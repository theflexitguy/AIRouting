// Operational routing-hub metrics. Pure functions over plain route/job objects
// (no Firestore imports) so the dashboard math is testable and reusable. All KPIs
// are AUTO-COMPUTED from data we already pull — there is no manual weekly logging.

/** Minimal shape of a route doc this module needs. */
export interface RouteLike {
  totalStops?: number;
  totalDriveTimeMinutes?: number;
  totalWorkMinutes?: number;
  totalServiceMinutes?: number;
  date?: string;
}

/** Minimal shape of a job doc this module needs. */
export interface JobLike {
  scheduledDate?: string; // next service date (YYYY-MM-DD)
  subscriptionLastCompletedDate?: string; // last completed date (YYYY-MM-DD)
  customerId?: string;
}

// KPI targets, sourced from the owner's reference dashboard. Hardcoded for now;
// a later pass can move these into Settings.
export const STOPS_PER_ROUTE_TARGET = 14;
export const STOPS_PER_HOUR_TARGET = 2.0;
export const DRIVE_TIME_TARGET = 45; // minutes per route (lower is better)
export const STOP_VARIANCE_TARGET = 2; // max−min stops across routes (lower is better)
export const COMPLETION_RATE_TARGET = 0.95;

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Average stops per route across the given routes. null when no routes. */
export function stopsPerRoute(routes: RouteLike[]): number | null {
  if (routes.length === 0) return null;
  const total = routes.reduce((s, r) => s + n(r.totalStops), 0);
  return total / routes.length;
}

/** Average drive time (minutes) per route. null when no routes. */
export function avgDriveTime(routes: RouteLike[]): number | null {
  if (routes.length === 0) return null;
  const total = routes.reduce((s, r) => s + n(r.totalDriveTimeMinutes), 0);
  return total / routes.length;
}

/** Spread of stops across routes (max−min). null when fewer than 2 routes. */
export function stopVariance(routes: RouteLike[]): number | null {
  if (routes.length < 2) return null;
  const counts = routes.map((r) => n(r.totalStops));
  return Math.max(...counts) - Math.min(...counts);
}

/**
 * Stops completed per working hour. Uses totalWorkMinutes when present, else
 * falls back to drive + service minutes. null when no usable hours data.
 */
export function stopsPerHour(routes: RouteLike[]): number | null {
  if (routes.length === 0) return null;
  const totalStops = routes.reduce((s, r) => s + n(r.totalStops), 0);
  const totalMinutes = routes.reduce((s, r) => {
    const work = n(r.totalWorkMinutes);
    const fallback = n(r.totalDriveTimeMinutes) + n(r.totalServiceMinutes);
    return s + (work > 0 ? work : fallback);
  }, 0);
  if (totalMinutes <= 0) return null;
  return totalStops / (totalMinutes / 60);
}

/** Ratio of completed stops to planned stops for a period. null when no plan. */
export function completionRate(completed: number, planned: number): number | null {
  if (planned <= 0) return null;
  return completed / planned;
}

export interface Pace {
  target: number; // distinct subs whose service is DUE in [start, end]
  done: number; // distinct subs SERVICED (completed) in [start, today]
  remaining: number; // max(0, target − done)
  pct: number; // done / target, 0..1 (0 when target is 0)
}

const inRange = (date: string | undefined, start: string, end: string): boolean =>
  Boolean(date) && (date as string) >= start && (date as string) <= end;

/**
 * Pace toward an auto-derived service target for a period.
 *   target = distinct subscriptions whose next service (scheduledDate) falls in
 *            [periodStart, periodEnd] — the work due in the window.
 *   done   = distinct subscriptions serviced (subscriptionLastCompletedDate) in
 *            [periodStart, today] — actual work completed so far.
 * Dedupes by customerId to mirror the dashboard's distinct-customer overdue count.
 */
export function paceFor(
  jobs: JobLike[],
  periodStart: string,
  periodEnd: string,
  today: string,
): Pace {
  const dueCustomers = new Set<string>();
  const doneCustomers = new Set<string>();
  for (const j of jobs) {
    const cid = String(j.customerId ?? "");
    if (!cid) continue;
    if (inRange(j.scheduledDate, periodStart, periodEnd)) dueCustomers.add(cid);
    if (inRange(j.subscriptionLastCompletedDate, periodStart, today)) doneCustomers.add(cid);
  }
  const target = dueCustomers.size;
  const done = doneCustomers.size;
  return {
    target,
    done,
    remaining: Math.max(0, target - done),
    pct: target > 0 ? done / target : 0,
  };
}

/** True when a KPI value meets its target. `lowerIsBetter` flips the comparison. */
export function meetsTarget(
  value: number | null,
  target: number,
  lowerIsBetter = false,
): boolean | null {
  if (value === null) return null;
  return lowerIsBetter ? value <= target : value >= target;
}
