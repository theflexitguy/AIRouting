// Scope decision, correctness flags, and FieldRoutes value mapping.
//
// Non-negotiable rules (see build brief §3–4):
//  - "Today" is America/Chicago, DST-safe. Never use a UTC server date.
//  - in_scope        = onHold == 0 && recurringCharge > 0 && frequency > 0 (recurring only)
//  - balance_ok      = customer_balance <= BALANCE_GATE (default 420; the Flex
//                      "do not schedule" hard stop — Sensei Office 101 / v1 Job Pool)
//  - has_constraint  = special_scheduling is non-empty
//  - already_scheduled = a future appointment exists for THIS subscription_id
//
// Date-window model (per owner spec):
//  - past_due (a.k.a. "Past Due") = service_due past a FREQUENCY-SCALED grace
//    period before today: quarterly (90d) → 15 days, bimonthly (60d) → 10,
//    monthly (30d) → 5 (= interval ÷ 6, clamped to [2, 30]). Frequent services
//    flag sooner. These are the highest-priority backlog for route generation.
//  - due_soon (a.k.a. "Pending") = from the grace threshold through +30 days
//    ahead. These are the appointments available for route generation.
//  - A subscription serviced (lastCompleted) on/after its service_due is NOT past
//    due — that completion rolls the next due date forward (handled in sync via
//    serviceDueAlreadyCompleted).
//  - The balance cap (and special-scheduling constraint) excludes a stop from
//    the Pending / Past Due *counts* and from routing, but the stop still appears
//    in the Jobs tab (status "review") so it can be audited and addressed.

// Customer balance (dollars) at/above which a stop is NOT scheduled. Flex's hard
// "do not schedule" line is $420 (Sensei Office 101 / v1 Job Pool). Overridable
// per company via Routing Settings (companies/{id}.routingBalanceGate).
export const BALANCE_GATE = 420;

/** Half-width of the "due soon / Pending" window, in days, on either side of today. */
export const WINDOW_DAYS = 30;

/**
 * Upper bound on how far back a "Past Due" stop can be. Anything due more than
 * this many days ago is treated as stale (long-dead service date) and dropped
 * from the Past Due / overdue counts and from routing — these are almost always
 * abandoned subscriptions, not real backlog worth chasing.
 */
export const MAX_OVERDUE_DAYS = 365;

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
 *
 * NOTE: a $0 recurring charge is NOT disqualifying. Some active subscriptions are
 * priced at $0 on purpose — e.g. an Outdoor Package whose cost is bundled into the
 * customer's General Pest service. Those are real recurring work that must still be
 * counted and routed, so scope is active + recurring + not on hold, price aside.
 */
export function isInScope(input: ScopeInput): boolean {
  return num(input.onHold) === 0 && num(input.frequency) > 0;
}

/** True only for genuinely recurring subscriptions (frequency in days, > 0). */
export function isRecurringFrequency(frequency: unknown): boolean {
  return num(frequency) > 0;
}

/**
 * Days a service may slip past its due date before it counts as "Past Due".
 * Scales with the service frequency so frequent services flag sooner (owner's
 * rule = interval ÷ 6): quarterly (90d) → 15, bimonthly (60d) → 10, monthly
 * (30d) → 5. Clamped to [2, WINDOW_DAYS] so nothing is more lenient than the old
 * flat 30 days, and an unknown/non-positive frequency falls back to WINDOW_DAYS.
 */
export function pastDueGraceDays(frequencyDays: unknown): number {
  const f = num(frequencyDays);
  if (f <= 0) return WINDOW_DAYS;
  return Math.min(WINDOW_DAYS, Math.max(2, Math.round(f / 6)));
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
  frequencyDays?: number; // service interval (days); scales the Past Due threshold
  // Optional Routing-Settings overrides. When omitted, the module defaults apply.
  balanceGate?: number; // overrides BALANCE_GATE (dollars)
  customerBalanceAgeDays?: number; // how long the balance has been outstanding
  balanceAgeGate?: number; // max allowed balance age in days; 0/undefined = unenforced
}

export interface JobFlags {
  pastDue: boolean; // service_due < today (any amount) — kept for debugging/back-compat
  pastDue30: boolean; // service_due past its frequency-scaled grace ("Past Due")
  dueSoon: boolean; // within grace-days overdue through the forward window ("Pending")
  balanceOk: boolean;
  hasConstraint: boolean;
  autoRoutable: boolean; // enters the routing pool (due soon OR past due, balance-ok, no constraint)
  needsReview: boolean; // relevant now but blocked by balance/constraint (shown, not routed)
  overdueActionable: boolean; // "Past Due" count: past_due_30 && balance-ok && no constraint && not scheduled
  dueSoonActionable: boolean; // "Pending" count: due_soon && balance-ok && no constraint && not scheduled
}

export function computeFlags(input: JobFlagsInput): JobFlags {
  const today = input.today;
  // Past Due threshold scales with frequency (quarterly 15 / bimonthly 10 /
  // monthly 5); the forward "due soon" look-ahead stays at WINDOW_DAYS.
  const graceDays = pastDueGraceDays(input.frequencyDays);
  const pastDueStart = shiftISODate(today, -graceDays); // today − grace
  const windowEnd = shiftISODate(today, WINDOW_DAYS); // today + 30 days
  const overdueFloor = shiftISODate(today, -MAX_OVERDUE_DAYS); // today − 365 days
  const sd = input.serviceDue;
  const hasDate = Boolean(sd);

  const pastDue = hasDate && sd < today;
  // Older than the 1-year floor = stale/abandoned; ignored everywhere below.
  const tooOld = hasDate && sd < overdueFloor;
  // "Past Due" = more than `graceDays` overdue, but not more than a year. The
  // floor drops dead service dates.
  const pastDue30 = hasDate && sd < pastDueStart && !tooOld;
  // "Pending" / due soon = from `graceDays` overdue through the forward window.
  // A date exactly `graceDays` ago is Pending; older is Past Due.
  const dueSoon = hasDate && sd >= pastDueStart && sd <= windowEnd;
  // "Relevant now" = anything due now or overdue (the routable consideration set).
  // Dates more than WINDOW_DAYS in the FUTURE are not yet relevant.
  const relevant = pastDue30 || dueSoon;

  // Balance gate: amount under the cap AND (when an age limit is configured and a
  // positive age is known) not past the allowed days-outstanding. Age is only
  // enforced when both a gate and a known age are present, so it's a no-op until
  // the balance-age field is synced.
  const gate = typeof input.balanceGate === "number" && input.balanceGate > 0 ? input.balanceGate : BALANCE_GATE;
  const ageGate = typeof input.balanceAgeGate === "number" && input.balanceAgeGate > 0 ? input.balanceAgeGate : 0;
  const age = typeof input.customerBalanceAgeDays === "number" ? input.customerBalanceAgeDays : 0;
  const amountOk = input.customerBalance <= gate;
  const ageOk = ageGate <= 0 || age <= 0 || age <= ageGate;
  const balanceOk = amountOk && ageOk;
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
