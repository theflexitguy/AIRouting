// Operational routing-hub metrics. Pure functions over plain route/job objects
// (no Firestore imports) so the dashboard math is testable and reusable. All KPIs
// are AUTO-COMPUTED from data we already pull — there is no manual weekly logging.

import { parseFrequencyDays } from "@/lib/production-value";
import { serviceLineMeta, type ServiceLine } from "@/lib/routing/service-line";

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
  serviceLine?: string; // general | gr | termite | lawn | mosquito | commercial | wildlife
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
  // A negative frequency is a FieldRoutes placeholder (e.g. -4 for plan-scheduled
  // lawn rounds). Don't parse the bogus "Every -4 Days" label.
  if (Number.isFinite(raw) && raw < 0) {
    const line = (j.serviceLine as ServiceLine) || "general";
    // Lawn rounds occur ONCE per year within their own ~6-week seasonal window
    // (not continuously like a normal seasonal service) — a flat 365-day
    // interval would only contribute ~1/6 of an occurrence across that short
    // window. Scale the interval to the window length so the seasonal
    // contribution (30.4/interval, summed over the window's active months)
    // works out to ~1 occurrence/year, matching reality.
    if (line === "lawn" && j.isSeasonal && j.seasonalStartMonth && j.seasonalEndMonth) {
      const windowMonths = j.seasonalEndMonth - j.seasonalStartMonth + 1;
      if (windowMonths > 0) return windowMonths * AVG_DAYS_PER_MONTH;
    }
    return serviceLineMeta(line).defaultIntervalDays;
  }
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

// Working days per service week (Mon–Fri).
export const WEEK_WORKING_DAYS = 5;

/** Count Mon–Fri working days in [start, end] inclusive (YYYY-MM-DD). */
export function workingDaysInRange(start: string, end: string): number {
  const s = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start);
  const e = /^(\d{4})-(\d{2})-(\d{2})$/.exec(end);
  if (!s || !e) return 0;
  let cursor = Date.UTC(Number(s[1]), Number(s[2]) - 1, Number(s[3]));
  const endMs = Date.UTC(Number(e[1]), Number(e[2]) - 1, Number(e[3]));
  let count = 0;
  while (cursor <= endMs) {
    const dow = new Date(cursor).getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
    cursor += 86400000;
  }
  return count;
}

/** Count Mon–Fri working days from the 1st of `today`'s month through `today` (inclusive). */
export function workingDaysElapsed(today: string): number {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(today);
  if (!m) return 0;
  return workingDaysInRange(`${m[1]}-${m[2]}-01`, today);
}

export interface PaceResult {
  target: number;
  done: number;
  remaining: number;
  donePct: number; // done / target (0..1+)
  progressPct: number; // elapsed / total working days (0..1)
  ahead: boolean; // on or ahead of pace
}
// Kept for back-compat with existing imports.
export type MonthlyPace = PaceResult;

/** Generic pace: target progress vs time progress (elapsed/total working days). */
export function paceOf(
  target: number,
  done: number,
  elapsedWorkingDays: number,
  totalWorkingDays: number,
): PaceResult {
  const donePct = target > 0 ? done / target : 0;
  const progressPct = totalWorkingDays > 0 ? Math.min(1, elapsedWorkingDays / totalWorkingDays) : 0;
  return {
    target,
    done,
    remaining: Math.max(0, target - done),
    donePct,
    progressPct,
    ahead: donePct >= progressPct,
  };
}

/** Pace toward the monthly target vs % through the month (20 working days). */
export function monthlyPace(target: number, done: number, today: string): PaceResult {
  return paceOf(target, done, workingDaysElapsed(today), MONTH_WORKING_DAYS);
}

/** Pace toward the weekly target vs % through the work-week (5 working days). */
export function weeklyPace(target: number, done: number, weekStart: string, today: string): PaceResult {
  return paceOf(target, done, workingDaysInRange(weekStart, today), WEEK_WORKING_DAYS);
}

// Service lines tracked as their own monthly targets on the dashboard. German
// Roach and Wildlife are intentionally excluded — those are one-time / auto-
// scheduled in FieldRoutes, not part of the recurring monthly book of business.
export const TARGET_SERVICE_LINES = ["general", "mosquito", "lawn", "termite", "commercial"] as const;
export type TargetServiceLine = (typeof TARGET_SERVICE_LINES)[number];

export const TARGET_SERVICE_LINE_LABELS: Record<TargetServiceLine, string> = {
  general: "General Pest",
  mosquito: "Mosquito",
  lawn: "Lawn",
  termite: "Termite",
  commercial: "Commercial",
};

const lineOf = (j: JobLike): string => String(j.serviceLine ?? "");

/** True when a service line is one of the tracked monthly-target lines. */
export function isTrackedServiceLine(line: string): boolean {
  return (TARGET_SERVICE_LINES as readonly string[]).includes(line);
}

/**
 * Lawn target/done for a specific month, counted DIRECTLY from the round
 * subscriptions rather than the seasonality-rate formula. Lawn is a 7-round
 * program where each customer's round is due on a real date inside its ~6-week
 * window, so "how many are due this month" is the honest count:
 *   done   = round subs COMPLETED this month (lastCompleted in [monthStart, today])
 *   left   = round subs still DUE this month  (serviceDue in [monthStart, monthEnd],
 *            not already completed this month)
 *   target = done + left (every round appointment that belongs to this month)
 * Counts subscriptions (each round is its own sub), not distinct customers.
 */
function lawnMonthTargetDone(
  lawnJobs: JobLike[],
  monthStart: string,
  monthEnd: string,
  today: string,
): { target: number; done: number } {
  let done = 0;
  let due = 0;
  for (const j of lawnJobs) {
    if (j.inScope === false || j.pendingCancel === true) continue;
    const lc = j.subscriptionLastCompletedDate;
    if (lc && lc >= monthStart && lc <= today) {
      done++;
      continue;
    }
    const sd = j.scheduledDate;
    if (sd && sd >= monthStart && sd <= monthEnd) due++;
  }
  return { target: done + due, done };
}

export interface LineTarget {
  line: TargetServiceLine | "total";
  label: string;
  target: number;
  done: number;
  pace: PaceResult;
}

/**
 * Per-service-line monthly targets + pace, plus a combined Total over the tracked
 * lines. Each line uses the same seasonality-aware target math as the company-wide
 * number, scoped to that line's subscriptions. Mosquito here includes Outdoor /
 * Boat Docks (they share the "mosquito" service line). GR and Wildlife are excluded.
 */
export function monthlyTargetsByLine(
  jobs: JobLike[],
  month: number,
  monthStart: string,
  monthEnd: string,
  today: string,
): LineTarget[] {
  const targetDoneFor = (line: TargetServiceLine, lineJobs: JobLike[]): { target: number; done: number } => {
    // Lawn is counted by rounds actually due this month; every other line uses
    // the seasonality-aware expected-services-per-month rate.
    if (line === "lawn") return lawnMonthTargetDone(lineJobs, monthStart, monthEnd, today);
    return {
      target: monthlyServiceTarget(lineJobs, month),
      done: monthlyServiced(lineJobs, monthStart, today),
    };
  };

  const rows: LineTarget[] = TARGET_SERVICE_LINES.map((line) => {
    const lineJobs = jobs.filter((j) => lineOf(j) === line);
    const { target, done } = targetDoneFor(line, lineJobs);
    return { line, label: TARGET_SERVICE_LINE_LABELS[line], target, done, pace: monthlyPace(target, done, today) };
  });
  // Total sums the per-line figures so Lawn's due-count contributes consistently.
  const target = rows.reduce((s, r) => s + r.target, 0);
  const done = rows.reduce((s, r) => s + r.done, 0);
  rows.push({ line: "total", label: "Total", target, done, pace: monthlyPace(target, done, today) });
  return rows;
}
