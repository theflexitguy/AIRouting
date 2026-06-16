// Scope decision, correctness flags, and FieldRoutes value mapping.
//
// Non-negotiable rules (see build brief §3–4):
//  - "Today" is America/Chicago, DST-safe. Never use a UTC server date.
//  - in_scope        = onHold == 0 && recurringCharge > 0
//  - past_due        = service_due < today(Central)
//  - balance_ok      = customer_balance <= 150
//  - has_constraint  = special_scheduling is non-empty
//  - already_scheduled = a pending future appointment exists for THIS subscription_id
//  - auto_routable   = in_scope && past_due && balance_ok && !has_constraint && !already_scheduled

export const BALANCE_GATE = 150;

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
}

/** Default scope predicate — kept as a single named function so it's easy to adjust. */
export function isInScope(input: ScopeInput): boolean {
  return num(input.onHold) === 0 && num(input.recurringCharge) > 0;
}

export interface JobFlagsInput {
  inScope: boolean;
  serviceDue: string; // YYYY-MM-DD
  customerBalance: number;
  specialScheduling: string;
  alreadyScheduled: boolean;
  today: string; // YYYY-MM-DD (Central)
}

export interface JobFlags {
  pastDue: boolean;
  balanceOk: boolean;
  hasConstraint: boolean;
  autoRoutable: boolean;
  needsReview: boolean;
}

export function computeFlags(input: JobFlagsInput): JobFlags {
  const pastDue = Boolean(input.serviceDue) && input.serviceDue < input.today;
  const balanceOk = input.customerBalance <= BALANCE_GATE;
  const hasConstraint = input.specialScheduling.trim().length > 0;
  const autoRoutable =
    input.inScope && pastDue && balanceOk && !hasConstraint && !input.alreadyScheduled;
  const needsReview =
    input.inScope && pastDue && !input.alreadyScheduled && (hasConstraint || !balanceOk);
  return { pastDue, balanceOk, hasConstraint, autoRoutable, needsReview };
}
