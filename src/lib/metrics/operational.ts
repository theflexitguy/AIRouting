// Operational routing-hub metrics. Pure functions over plain route/job objects
// (no Firestore imports) so the dashboard math is testable and reusable. All KPIs
// are AUTO-COMPUTED from data we already pull — there is no manual weekly logging.

import { parseFrequencyDays } from "@/lib/production-value";

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
  inScope?: boolean;
  pendingCancel?: boolean;
  frequency?: number; // raw service interval in days
  recurringFrequency?: string; // label fallback, e.g. "Every 90 Days"
  isSeasonal?: boolean;
  seasonalStartMonth?: number | null; // 1–12
  seasonalEndMonth?: number | null;
}

// Assume 20 working days in a service month (owner's standard).
export const MONTH_WORKING_DAYS = 20;
const AVG_DAYS_PER_MONTH = 30.4;

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

/** Service interval in days for a subscription (raw frequency, or parsed label). */
function jobFrequencyDays(j: JobLike): number {
  const raw = Number(j.frequency);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const parsed = parseFrequencyDays(j.recurringFrequency);
  return parsed && parsed > 0 ? parsed : 0;
}

/** Is this subscription serviced in the given calendar month (1–12)? */
function activeInMonth(j: JobLike, month: number): boolean {
  if (!j.isSeasonal) return true; // year-round
  const start = Number(j.seasonalStartMonth);
  const end = Number(j.seasonalEndMonth);
  if (!start || !end) return true;
  // Normal season (Apr–Sep) start<=end; wrap-around season (e.g. Nov–Feb) start>end.
  return start <= end ? month >= start && month <= end : month >= start || month <= end;
}

/**
 * Auto-derived monthly service target for `month` (1–12): the number of services
 * that should be completed this month across the active book of business.
 *   per-sub contribution = activeThisMonth ? (avgDaysPerMonth / frequencyDays) : 0
 * → quarterly (90d) ≈ total/3, annual (365d) ≈ total/12, monthly (30d) ≈ total
 * (only counted in a seasonal sub's active months). Counts active in-scope,
 * non-pending-cancel subscriptions only.
 */
export function monthlyServiceTarget(jobs: JobLike[], month: number): number {
  let total = 0;
  for (const j of jobs) {
    if (j.inScope === false || j.pendingCancel === true) continue;
    if (!activeInMonth(j, month)) continue;
    const days = jobFrequencyDays(j);
    if (days <= 0) continue;
    total += AVG_DAYS_PER_MONTH / days;
  }
  return Math.round(total);
}

/** Distinct customers serviced (last-completed) within [monthStart, today]. */
export function monthlyServiced(jobs: JobLike[], monthStart: string, today: string): number {
  const done = new Set<string>();
  for (const j of jobs) {
    const cid = String(j.customerId ?? "");
    if (cid && inRange(j.subscriptionLastCompletedDate, monthStart, today)) done.add(cid);
  }
  return done.size;
}

/** Count Mon–Fri working days from the 1st of `today`'s month through `today` (inclusive). */
export function workingDaysElapsed(today: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!m) return 0;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  let count = 0;
  for (let d = 1; d <= day; d++) {
    const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

export interface MonthlyPace {
  target: number;
  done: number;
  remaining: number;
  donePct: number; // done / target (0..1+)
  monthProgressPct: number; // workingDaysElapsed / 20 (0..1)
  ahead: boolean; // on or ahead of pace
}

/**
 * Pace toward the monthly target: how far through the target are we vs how far
 * through the month (20 working days). Replaces the old "completion rate".
 */
export function monthlyPace(target: number, done: number, today: string): MonthlyPace {
  const donePct = target > 0 ? done / target : 0;
  const monthProgressPct = Math.min(1, workingDaysElapsed(today) / MONTH_WORKING_DAYS);
  return {
    target,
    done,
    remaining: Math.max(0, target - done),
    donePct,
    monthProgressPct,
    ahead: donePct >= monthProgressPct,
  };
}
