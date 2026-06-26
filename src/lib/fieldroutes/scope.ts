// Scope decision, correctness flags, and FieldRoutes value mapping.
//
// Non-negotiable rules (see build brief §3–4):
//  - "Today" is America/Chicago, DST-safe. Never use a UTC server date.
//  - in_scope        = onHold == 0 && recurringCharge > 0 && frequency > 0 (recurring only)
//  - balance_ok      = customer_balance <= 149
//  - has_constraint  = special_scheduling is non-empty
//  - already_scheduled = a future appointment exists for THIS subscription_id
//
// Date-window model (per owner spec):
//  - due_soon (a.k.a. "Pending") = service_due within ±30 days of today(Central).
//    These are the appointments available for route generation.
//  - past_due_30 (a.k.a. "Past Due") = service_due more than 30 days before today.
//    These are the highest-priority backlog for route generation.
//  - A subscription serviced (lastCompleted) on/after its service_due is NOT past
//    due — that completion rolls the next due date forward (handled in sync via
//    serviceDueAlreadyCompleted).
//  - The $149 balance cap (and special-scheduling constraint) excludes a stop from
//    the Pending / Past Due *counts* and from routing, but the stop still appears
//    in the Jobs tab (status "review") so it can be audited and addressed.

export const BALANCE_GATE = 149;

/** Half-width of the "due soon / Pending" window, in days, on either side of today. */
export const WINDOW_DAYS = 30;

/**
 * Shift a YYYY-MM-DD calendar date by a number of days. Pure calendar math via
 * UTC (no time component, no DST drift) — the inputs are already Central-day
 * strings from centralTodayISO/toDateOnly, so this just moves the calendar day.
 */
export function shiftISODate(iso: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return "";
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Today's date as YYYY-MM-DD in America/Chicago, regardless of server TZ. */
export function centralTodayISO(now: Date = new Date()): string {
  // en-CA yields YYYY-MM-DD; timeZone forces the Central calendar day.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Normalize FieldRoutes date strings to YYYY-MM-DD (drops any time component). */
export function toDateOnly(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  }
  return "";
}

export function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Recurring frequency label from subscription.frequency (integer days).
 *  -1 => One-Time, 0 => As Needed, else "Every {n} Days".
 * Golden record: frequency 90 => "Every 90 Days".
 */
export function recurringFrequencyLabel(frequencyDays: unknown): string {
  const n = num(frequencyDays);
  if (n === -1) return "One-Time";
  if (n === 0) return "As Needed";
  return `Every ${n} Days`;
}

/**
 * Billing frequency label from subscription.billingFrequency (integer).
 *  0 or -1 => "After Each Service", else "Every {n} days" (lowercase d).
 * Golden record: billingFrequency 30 => "Every 30 days".
 */
export function billingFrequencyLabel(billingFrequency: unknown): string {
  const n = num(billingFrequency);
  if (n === 0 || n === -1) return "After Each Service";
  return `Every ${n} days`;
}

/** v1 category derivation from serviceType. Replace with serviceID→category map for lawn care. */
export function deriveCategory(serviceType: unknown): string {
  return String(serviceType ?? "").trim();
}

export interface ScopeInput {
  onHold: unknown; // subscription.onHold (0/1)
  recurringCharge: unknown; // subscription.recurringCharge
  frequency: unknown; // subscription.frequency (days; -1 One-Time, 0 As Needed, >0 recurring)
}

/**
 * Default scope predicate — kept as a single named function so it's easy to adjust.
 * "Recurring" is part of scope: frequency > 0 excludes One-Time (-1) and As Needed (0),
 * so they never reach the overdue metric or routing.
 */
export function isInScope(input: ScopeInput): boolean {
  return (
    num(input.onHold) === 0 &&
    num(input.recurringCharge) > 0 &&
    num(input.frequency) > 0
  );
}

/** True only for genuinely recurring subscriptions (frequency in days, > 0). */
export function isRecurringFrequency(frequency: unknown): boolean {
  return num(frequency) > 0;
}

export interface JobFlagsInput {
  inScope: boolean;
  serviceDue: string; // YYYY-MM-DD
  customerBalance: number;
  specialScheduling: string;
  alreadyScheduled: boolean;
  pendingCancel: boolean;
  potentialCustomer: boolean;
  today: string; // YYYY-MM-DD (Central)
}

export interface JobFlags {
  pastDue: boolean; // service_due < today (any amount) — kept for debugging/back-compat
  pastDue30: boolean; // service_due more than 30 days before today ("Past Due")
  dueSoon: boolean; // service_due within ±30 days of today ("Pending")
  balanceOk: boolean;
  hasConstraint: boolean;
  autoRoutable: boolean; // enters the routing pool (due soon OR past due, balance-ok, no constraint)
  needsReview: boolean; // relevant now but blocked by balance/constraint (shown, not routed)
  overdueActionable: boolean; // "Past Due" count: past_due_30 && balance-ok && no constraint && not scheduled
  dueSoonActionable: boolean; // "Pending" count: due_soon && balance-ok && no constraint && not scheduled
}

export function computeFlags(input: JobFlagsInput): JobFlags {
  const today = input.today;
  const windowStart = shiftISODate(today, -WINDOW_DAYS); // today − 30 days
  const windowEnd = shiftISODate(today, WINDOW_DAYS); // today + 30 days
  const sd = input.serviceDue;
  const hasDate = Boolean(sd);

  const pastDue = hasDate && sd < today;
  // "Past Due" = strictly more than 30 days overdue (service_due < today − 30).
  const pastDue30 = hasDate && sd < windowStart;
  // "Pending" / due soon = within ±30 days of today (inclusive). A date exactly
  // 30 days ago is Pending, not Past Due; 31+ days ago is Past Due.
  const dueSoon = hasDate && sd >= windowStart && sd <= windowEnd;
  // "Relevant now" = anything due now or overdue (the routable consideration set).
  // Dates more than 30 days in the FUTURE are not yet relevant.
  const relevant = pastDue30 || dueSoon;

  const balanceOk = input.customerBalance <= BALANCE_GATE;
  const hasConstraint = input.specialScheduling.trim().length > 0;

  const excluded = input.pendingCancel || input.potentialCustomer;
  const autoRoutable =
    input.inScope && relevant && balanceOk && !hasConstraint && !input.alreadyScheduled && !excluded;
  const needsReview =
    input.inScope && relevant && !input.alreadyScheduled && !excluded && (hasConstraint || !balanceOk);
  const overdueActionable =
    input.inScope && pastDue30 && balanceOk && !hasConstraint && !input.alreadyScheduled && !excluded;
  const dueSoonActionable =
    input.inScope && dueSoon && balanceOk && !hasConstraint && !input.alreadyScheduled && !excluded;

  return {
    pastDue,
    pastDue30,
    dueSoon,
    balanceOk,
    hasConstraint,
    autoRoutable,
    needsReview,
    overdueActionable,
    dueSoonActionable,
  };
}
