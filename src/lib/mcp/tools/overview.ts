// The broad end of the funnel: one call that returns the whole dashboard, plus data
// freshness and the weekly-KPI/trend view.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DRIVE_TIME_TARGET,
  STOPS_PER_HOUR_TARGET,
  STOPS_PER_ROUTE_TARGET,
  meetsTarget,
} from "@/lib/metrics/operational";
import { BALANCE_GATE } from "@/lib/fieldroutes/scope";
import { computeDashboardBounds } from "@/lib/dashboard";
import type { MonthlyDone } from "@/lib/fieldroutes/monthly-done";
import type { DashboardState } from "../snapshot.ts";
import { loadDashboardState } from "../snapshot.ts";
import type { McpContext } from "../data-source.ts";
import { fmtMinutes, money, pct, round } from "../format.ts";
import { defineTool, filterShape } from "./define.ts";

// ---------------- reusable card builders ----------------

export function routeCards(st: DashboardState) {
  const s = st.stats();
  const rows = st.drill().routeRows;
  return {
    window: st.window,
    routes: s.todayRoutes,
    totalStops: s.totalStops,
    completed: s.completedInScope,
    stopsRemaining: s.stopsLeftToday,
    driveMinutes: s.estimatedDriveTime,
    driveTime: fmtMinutes(s.estimatedDriveTime),
    routesWithEstimatedDriveTime: rows.filter((r) => r.driveEstimated).length,
    routeValue: round(s.totalRouteValue, 2),
    avgRouteValue: round(s.avgRouteValue, 2),
    stopsPerHour: round(s.todayStopsPerHour, 1),
  };
}

const kpi = (value: number | null, target: number, lowerIsBetter = false) => ({
  value: round(value, 1),
  target,
  direction: lowerIsBetter ? "at_most" : "at_least",
  meetsTarget: meetsTarget(value, target, lowerIsBetter),
});

export function weekKpis(st: DashboardState) {
  const s = st.stats();
  const w = s.weekKpis;
  const range = st.applied.dateRange;
  return {
    label: range ? "Selected range" : "This week",
    from: range ? range.from : st.bounds.weekStart,
    to: range ? range.to : st.bounds.weekEnd,
    routeCount: w.routeCount,
    stopsBooked: s.weekStopsBooked,
    stopsLeftOnRoutes: s.stopsLeftWeek,
    stopsPerRoute: kpi(w.stopsPerRoute, STOPS_PER_ROUTE_TARGET),
    stopsPerHour: kpi(w.stopsPerHour, STOPS_PER_HOUR_TARGET),
    avgDriveMinutes: kpi(w.avgDriveTime, DRIVE_TIME_TARGET, true),
  };
}

export function paceSummary(p: { donePct: number; progressPct: number; ahead: boolean; remaining: number }) {
  const donePct = pct(p.donePct);
  const throughPct = pct(p.progressPct);
  return {
    remaining: p.remaining,
    percentOfTargetDone: donePct,
    percentThroughMonth: throughPct,
    status: p.ahead ? "on_or_ahead_of_pace" : "behind_pace",
    // Same arithmetic as the card: rounded percentages, then their difference.
    pointsAheadOrBehind: donePct - throughPct,
  };
}

export function targetLines(st: DashboardState) {
  const s = st.stats();
  return s.lineTargets
    .filter((lt) => lt.line !== "total")
    .map((lt) => {
      const wd = s.lineWeekDay[lt.line];
      return {
        line: lt.line,
        label: lt.label,
        target: lt.target,
        done: lt.done,
        ...paceSummary(lt.pace),
        bookedRestOfMonth: s.monthScheduledByLine[lt.line] || 0,
        week: wd ? { target: wd.weekTarget, done: wd.weekDone, booked: wd.weekBooked } : null,
        today: wd ? { target: wd.dayTarget, done: wd.todayDone, booked: wd.todayBooked } : null,
        rounds: lt.rounds && lt.rounds.length ? lt.rounds : undefined,
      };
    });
}

export function targetTotal(st: DashboardState) {
  const s = st.stats();
  const t = s.lineTargets[s.lineTargets.length - 1];
  return {
    target: t.target,
    done: t.done,
    ...paceSummary(t.pace),
    bookedRestOfMonth: s.monthScheduledTotal,
    weekTarget: s.weeklyTarget,
    weekDone: s.weekPace.done,
    weekBooked: s.weekScheduled,
    dayTarget: s.dailyTarget,
    todayBooked: s.todayScheduled,
  };
}

export function completedBuckets(md: MonthlyDone | null, today: string) {
  // The dashboard ignores a leftover document from a previous month.
  if (!md || md.month !== today.slice(0, 7)) return null;
  return {
    month: md.month,
    computedAt: md.computedAt,
    completedAppointments: md.completedAppointments,
    initials: { total: md.initialsTotal, byLine: md.initialsByLine },
    reservices: md.reserviceDone,
    followUps: md.followupDone,
    specialty: md.specialtyDone,
    wildlife: md.wildlifeDone,
    newCustomers: md.newCustomers,
    newSubscriptions: md.newSubscriptions,
    unclassified: md.unclassified ?? 0,
  };
}

const isoPlusDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export function freshnessWarnings(now: Date, lastRunAt: string | null, runActive: boolean): string[] {
  const warnings: string[] = [];
  if (!lastRunAt) {
    warnings.push("No completed FieldRoutes sync is recorded — the numbers may be empty or stale.");
  } else {
    const hours = (now.getTime() - Date.parse(lastRunAt)) / 3_600_000;
    if (hours > 30) warnings.push(`The last sync was ${Math.round(hours)} hours ago; today's completions and bookings may be out of date.`);
  }
  if (runActive) warnings.push("A sync is in progress right now; figures may change within minutes.");
  return warnings;
}

// ---------------- tools ----------------

export function registerOverviewTools(server: McpServer, ctx: McpContext) {
  defineTool(
    server,
    ctx,
    {
      name: "get_dashboard_overview",
      title: "Dashboard overview",
      description:
        "START HERE. The whole Routiq dashboard in one call: today's route cards (routes, stops, completed, remaining, drive time, route value, stops/hour), this week's KPIs vs targets, " +
        "Targets by Service (per-line target/done/pace/booked), Overdue Stops, this month's completed buckets and new business, jobs due in the next 7 days, and the 8-week trend. " +
        "Accepts the dashboard filters (technicians, route groups/templates, subscription types, stop types, date range) for the ROUTE-derived parts; targets and overdue are company-wide. " +
        "The `drill` list says which tool opens each number for the detail behind it.",
      inputSchema: filterShape,
    },
    async (args) => {
      const st = await loadDashboardState(ctx, args);
      const s = st.stats();
      const [live, sync] = await Promise.all([ctx.data.getLiveMonthlyDone(), ctx.data.getSyncStatus()]);
      const cards = routeCards(st);
      const total = targetTotal(st);
      const lines = targetLines(st);
      const behind = lines.filter((l) => l.status === "behind_pace").map((l) => l.label);
      const warnings = freshnessWarnings(ctx.now(), sync.lastRunAt, sync.runActive);

      const summary = [
        `${cards.window.label}${st.applied.dateRange ? ` (${cards.window.from} to ${cards.window.to})` : ` (${ctx.today})`}: ${cards.routes} routes, ${cards.totalStops} stops — ${cards.completed} completed, ${cards.stopsRemaining} remaining. Drive ${cards.driveTime}, route value ${money(cards.routeValue ?? 0)}.`,
        `Month to date: ${total.done} of ${total.target} services done (${total.percentOfTargetDone}% of target, ${total.percentThroughMonth}% through the month) — ${total.status === "behind_pace" ? "BEHIND pace" : "on or ahead of pace"}.` +
          (behind.length ? ` Behind: ${behind.join(", ")}.` : ""),
        `Overdue: ${s.overdueStops} customers.`,
        ...warnings,
      ];

      return {
        summary,
        appliedFilters: st.applied,
        routes: cards,
        week: weekKpis(st),
        targets: { month: { start: st.bounds.monthStart, end: st.bounds.monthEnd }, total, lines },
        overdue: { customers: s.overdueStops, balanceGate: BALANCE_GATE },
        completedThisMonth: completedBuckets(live, ctx.today),
        jobsDueNext7Days: s.jobsDueThisWeek.map((d, i) => ({ date: isoPlusDays(ctx.today, i), weekday: d.date, count: d.count })),
        trend8Weeks: s.trend.map((t) => ({
          weekOf: t.label,
          routes: t.routeCount,
          stopsPerRoute: round(t.stopsPerRoute, 1),
          avgDriveMinutes: round(t.avgDriveTime, 1),
          stopsPerHour: round(t.stopsPerHour, 1),
        })),
        freshness: { lastSyncAt: sync.lastRunAt, warnings },
        drill: [
          { metric: "routes / stops / completed / remaining / drive / value", tool: "get_route_summary", then: ["list_routes", "list_stops", "get_route"] },
          { metric: "week KPIs and trend", tool: "get_kpis_and_trend" },
          { metric: "targets by service", tool: "get_targets_by_service", then: ["audit_target"] },
          { metric: "overdue stops", tool: "get_overdue_stops" },
          { metric: "completed this month / new business", tool: "get_completed_breakdown" },
          { metric: "technicians needed", tool: "get_technician_forecast" },
          { metric: "any number's meaning", tool: "explain_metric" },
        ],
      };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "get_data_freshness",
      title: "Data freshness",
      description:
        "How current the numbers are: when FieldRoutes last synced, whether a sync is running, the date through which routes are finalized (no longer re-verified), how many routes exist for each day this week, and today's FieldRoutes API usage. Check this before calling anything 'current'.",
      inputSchema: {},
    },
    async () => {
      const bounds = computeDashboardBounds(ctx.today);
      const [sync, live, routes] = await Promise.all([
        ctx.data.getSyncStatus(),
        ctx.data.getLiveMonthlyDone(),
        ctx.data.getRoutes(bounds.weekStart, bounds.weekEnd),
      ]);
      const now = ctx.now();
      const ageHours = sync.lastRunAt ? round((now.getTime() - Date.parse(sync.lastRunAt)) / 3_600_000, 1) : null;
      const byDate: Record<string, number> = {};
      for (const r of routes) if ((r.totalStops || 0) > 0) byDate[r.date] = (byDate[r.date] || 0) + 1;
      const warnings = freshnessWarnings(now, sync.lastRunAt, sync.runActive);
      if (sync.finalizedThrough && sync.finalizedThrough < isoPlusDays(ctx.today, -3)) {
        warnings.push(`Routes are finalized only through ${sync.finalizedThrough}; later past days are still being re-verified or the watermark is stuck.`);
      }
      return {
        sync: {
          lastRunAt: sync.lastRunAt,
          ageHours,
          lastRunMode: sync.lastRunMode,
          lastFullSyncAt: sync.lastFullSyncAt,
          lastIncrementalAt: sync.lastIncrementalAt,
          runActive: sync.runActive,
          inScopeSubscriptions: sync.lastInScopeCount,
        },
        routesFinalizedThrough: sync.finalizedThrough,
        routesThisWeek: { weekStart: bounds.weekStart, weekEnd: bounds.weekEnd, routesByDate: byDate },
        monthlyAggregate: live ? { month: live.month, computedAt: live.computedAt } : null,
        fieldRoutesApiToday: sync.apiUsage,
        warnings,
        howToRead:
          "Subscription-based numbers (targets, overdue) move only when a sync runs. Route completions are stamped when the sync reconciles a day. Past days are finalized about a day after they occur.",
      };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "get_kpis_and_trend",
      title: "Weekly KPIs and 8-week trend",
      description:
        "Efficiency KPIs for the current week (or a date range) against their targets — stops per route (≥14), stops per hour (≥2.0), average drive time (<45 min) — plus the 8-week trend of each. Filter-aware. Use to judge whether routes are being run efficiently and whether that is improving.",
      inputSchema: filterShape,
    },
    async (args) => {
      const st = await loadDashboardState(ctx, args);
      const s = st.stats();
      return {
        appliedFilters: st.applied,
        kpis: weekKpis(st),
        trend8Weeks: s.trend.map((t) => ({
          weekOf: t.label,
          routes: t.routeCount,
          stopsPerRoute: round(t.stopsPerRoute, 1),
          avgDriveMinutes: round(t.avgDriveTime, 1),
          stopsPerHour: round(t.stopsPerHour, 1),
        })),
        note: "The trend ignores the date-range filter (always the last 8 weeks) but applies the other filters.",
      };
    },
  );
}
