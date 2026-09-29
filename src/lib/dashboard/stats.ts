// Extracted VERBATIM from src/app/(dashboard)/dashboard/page.tsx so the dashboard and the
// MCP server compute every number with the same code. Do not fork the logic — change it here.

import { addDays, endOfMonth, endOfWeek, format, parseISO, startOfMonth, startOfWeek, subWeeks } from "date-fns";
import { canonicalRouteGroup } from "@/lib/route-groups";
import {
  lawnRoundNumberForWindow,
  lawnRoundNumberFromServiceType,
  lawnRoundsForMonth,
} from "@/lib/routing/service-line";
import {
  MONTH_WORKING_DAYS,
  avgDriveTime,
  isTrackedServiceLine,
  monthlyServiced,
  monthlyTargetsByLine,
  scheduledCountByLine,
  scheduledTrackedTotal,
  stopsPerHour,
  stopsPerRoute,
  weeklyPace,
} from "@/lib/metrics/operational";
import { norm, stopKindOf, isWeekendISO, type RouteFilter } from "./filters.ts";
import type { DashboardBounds, DashboardStats, JobRec, RouteRec, TrendRow, WeekKpis } from "./types.ts";

/** Week/month boundaries around `today` (weeks start Monday). */
export function computeDashboardBounds(today: string): DashboardBounds {
  const d = parseISO(today);
  return {
    weekStart: format(startOfWeek(d, { weekStartsOn: 1 }), "yyyy-MM-dd"),
    weekEnd: format(endOfWeek(d, { weekStartsOn: 1 }), "yyyy-MM-dd"),
    monthStart: format(startOfMonth(d), "yyyy-MM-dd"),
    monthEnd: format(endOfMonth(d), "yyyy-MM-dd"),
    monthIndex: Number(today.slice(5, 7)),
    trendStart: format(startOfWeek(subWeeks(d, 7), { weekStartsOn: 1 }), "yyyy-MM-dd"),
  };
}

export interface DashboardStatsInput {
  rawRoutes: RouteRec[];
  rawJobs: JobRec[];
  rangeRoutes: RouteRec[] | null;
  dateFilterEnabled: boolean;
  excludeWeekends: boolean;
  filterRoutes: RouteFilter;
  filterGroups: string[];
  filterTemplates: string[];
  filterSubTypes: string[];
  filterStopKinds: string[];
  techKeys: Set<string>;
  bounds: DashboardBounds;
  today: string;
  scopedRoutes: RouteRec[];
  jobsByDocId: Map<string, JobRec>;
}

/** Every headline number on the dashboard (cards, week KPIs, targets, trend, due-this-week). */
export function computeDashboardStats(input: DashboardStatsInput): DashboardStats {
  const {
    rawRoutes, rawJobs, rangeRoutes, dateFilterEnabled, excludeWeekends, filterRoutes,
    filterGroups, filterTemplates, filterSubTypes, filterStopKinds, techKeys, bounds, today,
    scopedRoutes, jobsByDocId,
  } = input;
  // KPIs use this week's routes (or the custom range).
  const rangeSet = dateFilterEnabled
    ? (excludeWeekends ? (rangeRoutes ?? []).filter(r => !isWeekendISO(String(r.date))) : (rangeRoutes ?? []))
    : null;
  const todaySet = scopedRoutes;
  const kpiSet = filterRoutes(
    rangeSet ?? rawRoutes.filter(r => r.date >= bounds.weekStart && r.date <= bounds.weekEnd)
  );

  const totalStops = todaySet.reduce((s, r) => s + (r.totalStops || 0), 0);
  const estimatedDriveTime = todaySet.reduce((s, r) => s + (r.totalDriveTimeMinutes || 0), 0);
  const totalRouteValue = todaySet.reduce((s, r) => s + (Number(r.routeValue) || 0), 0);
  const avgRouteValue = todaySet.length > 0 ? totalRouteValue / todaySet.length : 0;

  // Jobs completed today within the tech/group filter scope (jobs carry the
  // scheduled tech name + route group). Freshness is bounded by the last sync.
  const jobInFilterScope = (j: JobRec) => {
    if (filterGroups.length > 0 && !filterGroups.includes(canonicalRouteGroup(String(j.fieldRoutesRouteGroup || "")))) return false;
    if (filterTemplates.length > 0 && !filterTemplates.includes(String(j.fieldRoutesRouteTemplate || "").trim())) return false;
    if (filterSubTypes.length > 0 && !filterSubTypes.includes(String(j.serviceType || "").trim())) return false;
    if (filterStopKinds.length > 0 && !filterStopKinds.includes(stopKindOf(j.fieldRoutesStopKind))) return false;
    if (techKeys.size > 0 && !techKeys.has(norm(j.scheduledTech))) return false;
    return true;
  };
  // Completed stops on a route: the reconcile stamps completedStops from
  // actual appointment statuses on past AND today's docs. Docs that predate
  // the field (or non-FieldRoutes routes) fall back to counting stops whose
  // job doc completed on the route's date, filtered like everything else.
  const completedOnRoute = (r: RouteRec): number => {
    if (typeof r.completedStops === "number") return r.completedStops;
    const seq = Array.isArray(r.stopSequence) ? r.stopSequence.map(String) : [];
    return seq.filter(id => {
      const j = jobsByDocId.get(id);
      return j && j.subscriptionLastCompletedDate === r.date && jobInFilterScope(j);
    }).length;
  };
  const completedToday = todaySet
    .filter(r => r.date === today)
    .reduce((s, r) => s + completedOnRoute(r), 0);
  // "Completed" card: with a custom range, completions across the whole range;
  // otherwise today's routes — both from the same per-route appointment truth.
  const completedInScope = dateFilterEnabled
    ? todaySet.reduce((s, r) => s + completedOnRoute(r), 0)
    : completedToday;

  // Work still sitting on routes: future days count whole; today and past
  // days count each route's booked-minus-completed remainder (appointment
  // truth as of the last sync) — a 68-stop day with 65 done shows 3
  // remaining, not 0, and today's count no longer shrinks as work completes.
  const stopsStillToDo = (routes: RouteRec[]): number => {
    let left = 0;
    for (const r of routes) {
      if (r.date > today) left += r.totalStops || 0;
      else left += Math.max(0, (r.totalStops || 0) - completedOnRoute(r));
    }
    return left;
  };
  const stopsLeftToday = stopsStillToDo(todaySet);
  const stopsLeftWeek = stopsStillToDo(kpiSet);
  const weekStopsBooked = kpiSet.reduce((s, r) => s + (r.totalStops || 0), 0);

  // Already-booked FieldRoutes appointments (the schedule as it stands) — the
  // forward half of pace: done + booked vs target says whether the current
  // schedule is enough to stay on track or the books need more.
  const monthScheduledByLine = scheduledCountByLine(rawJobs, today, bounds.monthEnd);
  const monthScheduledTotal = scheduledTrackedTotal(monthScheduledByLine);
  const weekScheduled = scheduledTrackedTotal(scheduledCountByLine(rawJobs, today, bounds.weekEnd));
  // "Booked today" answers "did we put enough on today's schedule?" — so an
  // appointment completed earlier today still counts (unlike the month/week
  // projections, which exclude completed appts to avoid double-counting done).
  const todayScheduled = rawJobs.filter(
    j => j.alreadyScheduled === true &&
      j.fieldRoutesScheduledDate === today &&
      isTrackedServiceLine(String(j.serviceLine ?? ""))
  ).length;

  // Overdue + targets stay company-wide (subscriptions aren't tied to a route
  // group, and overdue subs are typically unassigned).
  const overdueStops = new Set(
    rawJobs.filter(j => j.overdueActionable).map(j => String(j.customerId))
  ).size;

  // Per-service-line monthly targets (General Pest / Mosquito / Lawn / Termite /
  // Commercial) plus a combined Total. GR + Wildlife are excluded (one-time /
  // auto-scheduled). Weekly + Daily derive from the tracked-line Total.
  const lineTargets = monthlyTargetsByLine(rawJobs, bounds.monthIndex, bounds.monthStart, bounds.monthEnd, today);
  const totalRow = lineTargets[lineTargets.length - 1];
  const monthlyTarget = totalRow.target;
  const pace = totalRow.pace;
  const weeklyTarget = Math.round(monthlyTarget / 4);
  const dailyTarget = Math.round(monthlyTarget / MONTH_WORKING_DAYS);

  // Week/day segmentation per service line: targets derive from the line's
  // monthly target (÷4 weekly, ÷ working-days daily — same derivation the
  // Total cards use); done counts distinct customers completed in the window
  // (per-round subs for Lawn, matching its monthly card); booked counts
  // appointments already on the books.
  const weekBookedByLine = scheduledCountByLine(rawJobs, today, bounds.weekEnd);
  const lineWeekDay: DashboardStats["lineWeekDay"] = {};
  for (const lt of lineTargets) {
    if (lt.line === "total") continue;
    const lineJobs = rawJobs.filter(j => String(j.serviceLine ?? "") === lt.line);
    // Lawn done: ONLY the current round (the round sub whose seasonal window
    // covers this month), deduped to distinct plans (customers). A plan owns
    // several round subs, so counting sub records — or other rounds — would
    // over-report like the monthly card did (113 vs 82 plans). Other lines
    // already count distinct customers.
    // A lawn sub belongs to this month only if its round (from service type,
    // else stamped window) is one the calendar marks active this month — the
    // same rule the monthly card uses, so unattributable/other-round subs
    // don't leak in.
    const activeLawnRounds = new Set(lawnRoundsForMonth(bounds.monthIndex));
    const lawnCurrentRound = (j: JobRec) => {
      const round =
        lawnRoundNumberFromServiceType(j.serviceType) ??
        lawnRoundNumberForWindow(j.seasonalStartMonth, j.seasonalEndMonth);
      return round !== null && activeLawnRounds.has(round);
    };
    const doneIn = (start: string, end: string) =>
      lt.line === "lawn"
        ? new Set(
            lineJobs
              .filter(j =>
                j.inScope !== false && j.pendingCancel !== true && lawnCurrentRound(j) &&
                j.subscriptionLastCompletedDate && j.subscriptionLastCompletedDate >= start && j.subscriptionLastCompletedDate <= end
              )
              .map(j => String(j.customerId || j.docId || ""))
          ).size
        : monthlyServiced(lineJobs, start, end);
    lineWeekDay[lt.line] = {
      weekTarget: Math.round(lt.target / 4),
      weekDone: doneIn(bounds.weekStart, today),
      weekBooked: weekBookedByLine[lt.line] || 0,
      dayTarget: Math.round(lt.target / MONTH_WORKING_DAYS),
      todayDone: doneIn(today, today),
      todayBooked: lineJobs.filter(j => j.alreadyScheduled === true && j.fieldRoutesScheduledDate === today).length,
    };
  }
  const trackedJobs = rawJobs.filter(j => isTrackedServiceLine(String(j.serviceLine ?? "")));
  const weeklyDone = monthlyServiced(trackedJobs, bounds.weekStart, today);
  const weekPace = weeklyPace(weeklyTarget, weeklyDone, bounds.weekStart, today);

  const weekKpis: WeekKpis = {
    stopsPerRoute: stopsPerRoute(kpiSet),
    stopsPerHour: stopsPerHour(kpiSet),
    avgDriveTime: avgDriveTime(kpiSet),
    routeCount: kpiSet.length,
  };

  // 8-week trend: always the last 8 weeks of routes, with tech/group filters
  // applied (but not the date-range filter).
  const trendSet = filterRoutes(rawRoutes);
  const trend: TrendRow[] = [];
  const d0 = parseISO(today);
  for (let w = 7; w >= 0; w--) {
    const wkStartDate = startOfWeek(subWeeks(d0, w), { weekStartsOn: 1 });
    const wkStart = format(wkStartDate, "yyyy-MM-dd");
    const wkEnd = format(endOfWeek(wkStartDate, { weekStartsOn: 1 }), "yyyy-MM-dd");
    const wk = trendSet.filter(r => r.date >= wkStart && r.date <= wkEnd);
    trend.push({
      label: format(wkStartDate, "MMM d"),
      routeCount: wk.length,
      stopsPerRoute: stopsPerRoute(wk),
      avgDriveTime: avgDriveTime(wk),
      stopsPerHour: stopsPerHour(wk),
    });
  }

  // Jobs due over the next 7 days (company-wide).
  const jobsDueThisWeek = Array.from({ length: 7 }, (_, i) => {
    const dd = format(addDays(parseISO(today), i), "yyyy-MM-dd");
    const count = rawJobs.filter(j =>
      j.scheduledDate === dd && (j.status === "pending" || j.status === "scheduled")
    ).length;
    return { date: format(addDays(parseISO(today), i), "EEE"), count };
  });

  return {
    todayRoutes: todaySet.length,
    totalStops,
    completedToday,
    completedInScope,
    stopsLeftToday,
    estimatedDriveTime,
    totalRouteValue,
    avgRouteValue,
    todayStopsPerHour: stopsPerHour(todaySet),
    overdueStops,
    weekKpis,
    weekStopsBooked,
    stopsLeftWeek,
    lineTargets,
    monthScheduledByLine,
    monthScheduledTotal,
    weekScheduled,
    todayScheduled,
    monthlyTarget,
    weeklyTarget,
    dailyTarget,
    lineWeekDay,
    pace,
    weekPace,
    trend,
    jobsDueThisWeek,
  };
}
