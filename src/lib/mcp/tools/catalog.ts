// Reference tools: who the technicians are and how loaded they are, what the filter
// dropdowns contain, the thresholds behind the metrics, and the metric dictionary.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { groupRouteGroupTitles, canonicalRouteGroup } from "@/lib/route-groups";
import {
  COMPLETION_RATE_TARGET,
  DASHBOARD_PERIODS,
  DRIVE_TIME_TARGET,
  MONTH_WORKING_DAYS,
  STOPS_PER_HOUR_TARGET,
  STOPS_PER_ROUTE_TARGET,
  STOP_VARIANCE_TARGET,
  TARGET_SERVICE_LINES,
  TARGET_SERVICE_LINE_LABELS,
  TECH_CATEGORIES,
  WEEK_WORKING_DAYS,
} from "@/lib/metrics/operational";
import { BALANCE_GATE, MAX_OVERDUE_DAYS, pastDueGraceDays } from "@/lib/fieldroutes/scope";
import { STOP_KIND_OPTIONS, norm } from "@/lib/dashboard";
import type { McpContext } from "../data-source.ts";
import { ToolInputError, round } from "../format.ts";
import { buildGlossary } from "../glossary.ts";
import { jobField, publicTech } from "../public.ts";
import { loadDashboardState } from "../snapshot.ts";
import { defineTool } from "./define.ts";

const LINE_LABELS: Record<string, string> = { ...TARGET_SERVICE_LINE_LABELS, gr: "German Roach", wildlife: "Wildlife" };

export function registerCatalogTools(server: McpServer, ctx: McpContext) {
  defineTool(
    server,
    ctx,
    {
      name: "list_technicians",
      title: "Technicians and their workload",
      description:
        "Every technician with their FieldRoutes skills and their workload for a window (default: the current Mon–Sun week, or startDate/endDate): routes, stops, completed, remaining, drive minutes, route value, stops per route and stops per hour — " +
        "plus how many subscriptions name them as preferred technician (and how many of those are counted overdue). Use to compare technicians or spot who is overloaded.",
      inputSchema: {
        startDate: z.string().optional().describe("YYYY-MM-DD; with endDate. Default: this week."),
        endDate: z.string().optional(),
      },
    },
    async (args) => {
      const probe = await loadDashboardState(ctx, {});
      const from = args.startDate ?? probe.bounds.weekStart;
      const to = args.endDate ?? probe.bounds.weekEnd;
      const st = await loadDashboardState(ctx, { startDate: from, endDate: to });
      const drill = st.drill();
      const routeByKey = new Map(st.scopedRoutes.map((r) => [`${r.date}-${String(r.techId || r.techName)}`, r]));
      const jobs = st.rawJobs;
      return {
        window: { from, to },
        technicians: st.techs
          .map((t) => {
            const rows = drill.routeRows.filter((row) => {
              const doc = routeByKey.get(row.key);
              return doc?.techId === t.id || norm(row.techName) === norm(t.name);
            });
            const stops = rows.reduce((s, r) => s + r.totalStops, 0);
            const work = rows.reduce((s, r) => s + r.workMinutes, 0);
            const mine = jobs.filter((j) => norm(jobField(j, "preferredTech")) === norm(t.name));
            return {
              ...publicTech(t),
              name: t.name,
              workload: {
                routes: rows.length,
                stops,
                completed: rows.reduce((s, r) => s + r.completed, 0),
                remaining: rows.reduce((s, r) => s + (r.date > ctx.today ? r.totalStops : Math.max(0, r.totalStops - r.completed)), 0),
                driveMinutes: rows.reduce((s, r) => s + r.driveMinutes, 0),
                routeValue: round(rows.reduce((s, r) => s + r.routeValue, 0), 2),
                stopsPerRoute: rows.length ? round(stops / rows.length, 1) : null,
                stopsPerHour: work > 0 ? round(stops / (work / 60), 1) : null,
              },
              preferredSubscriptions: { total: mine.length, countedOverdue: mine.filter((j) => j.overdueActionable === true).length },
            };
          })
          .sort((a, b) => b.workload.stops - a.workload.stops || String(a.name).localeCompare(String(b.name))),
      };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "get_filter_options",
      title: "Valid filter values",
      description:
        "What the dashboard's filter dropdowns contain: technicians, route groups (with their spelling variants), route templates, subscription (service) types with counts, service lines with counts, stop types and history periods. Call this to learn valid values before filtering.",
      inputSchema: {},
    },
    async () => {
      const [meta, st] = await Promise.all([ctx.data.getCompanyMeta(), loadDashboardState(ctx, {})]);
      const titles = st.rawRoutes.map((r) => String(r.routeGroupTitle || "")).filter(Boolean);
      const templates = Array.from(new Set(st.rawRoutes.map((r) => String(r.routeTemplateTitle || "").trim()).filter(Boolean))).sort();
      const types: Record<string, number> = {};
      const lines: Record<string, number> = {};
      for (const j of st.rawJobs) {
        const t = String(j.serviceType || "").trim();
        if (t) types[t] = (types[t] || 0) + 1;
        lines[String(j.serviceLine)] = (lines[String(j.serviceLine)] || 0) + 1;
      }
      return {
        technicians: st.techs.map((t) => ({ id: t.id, name: t.name })),
        routeGroups: {
          savedInSettings: meta.routeGroups.map(canonicalRouteGroup),
          seenOnRecentRoutes: groupRouteGroupTitles(titles),
        },
        routeTemplates: templates,
        subscriptionTypes: Object.entries(types).sort((a, b) => b[1] - a[1]).map(([name, subscriptions]) => ({ name, subscriptions })),
        serviceLines: Object.entries(lines).sort((a, b) => b[1] - a[1]).map(([value, subscriptions]) => ({ value, label: LINE_LABELS[value] ?? value, subscriptions })),
        trackedServiceLines: TARGET_SERVICE_LINES,
        stopTypes: STOP_KIND_OPTIONS,
        periods: DASHBOARD_PERIODS,
        note: "Route groups and templates come from routes in the last 8 weeks plus this week.",
      };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "get_configuration",
      title: "Targets, thresholds and settings",
      description:
        "The fixed numbers behind the metrics: KPI targets (stops/route, stops/hour, drive time), working-day counts, the overdue rules (balance gate, maximum lateness, frequency-scaled grace windows), technician capacity per category, and the company's non-secret settings (saved route groups, forecast growth). Use to explain why something is or isn't flagged.",
      inputSchema: {},
    },
    async () => {
      const meta = await ctx.data.getCompanyMeta();
      return {
        company: { name: meta.name, savedRouteGroups: meta.routeGroups, forecastMonthlyGrowthPct: meta.forecastMonthlyGrowthPct },
        kpiTargets: {
          stopsPerRoute: { target: STOPS_PER_ROUTE_TARGET, direction: "at_least" },
          stopsPerHour: { target: STOPS_PER_HOUR_TARGET, direction: "at_least" },
          avgDriveMinutes: { target: DRIVE_TIME_TARGET, direction: "at_most" },
          definedButNotShownOnDashboard: {
            stopCountSpread: { target: STOP_VARIANCE_TARGET, direction: "at_most" },
            completionRate: { target: COMPLETION_RATE_TARGET, direction: "at_least" },
          },
        },
        calendar: { monthWorkingDays: MONTH_WORKING_DAYS, weekWorkingDays: WEEK_WORKING_DAYS, weekStartsOn: "Monday", timezone: "America/Chicago" },
        overdueRules: {
          balanceGateDollars: BALANCE_GATE,
          maxDaysOverdue: MAX_OVERDUE_DAYS,
          graceDaysByServiceIntervalDays: Object.fromEntries([7, 14, 30, 60, 90, 180, 365].map((d) => [String(d), pastDueGraceDays(d)])),
        },
        technicianCapacity: TECH_CATEGORIES,
        trackedServiceLines: TARGET_SERVICE_LINES,
      };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "explain_metric",
      title: "Explain a metric",
      description:
        "Plain-language definition of any dashboard metric: what it means, the formula, where the data comes from, caveats, and which tool returns it. Omit `metric` to list them all (keys: routes, total_stops, completed, stops_remaining, drive_time, route_value, stops_per_hour, week_kpis, targets_by_service, target_methods, overdue_stops, completed_buckets, stop_types, new_business, technician_forecast, service_lines, as_of_view, freshness).",
      inputSchema: { metric: z.string().optional().describe("A metric key or part of its title, e.g. 'overdue'.") },
    },
    async (args) => {
      const all = buildGlossary();
      if (!args.metric) return { metrics: all.map((e) => ({ key: e.key, title: e.title })) };
      const q = args.metric.trim().toLowerCase().replace(/[\s-]+/g, "_");
      const hits = all.filter((e) => e.key === q || e.key.includes(q) || e.title.toLowerCase().includes(args.metric!.trim().toLowerCase()));
      if (hits.length === 0) {
        throw new ToolInputError(`No metric matches "${args.metric}". Known: ${all.map((e) => e.key).join(", ")}.`);
      }
      return { matches: hits };
    },
  );
}
