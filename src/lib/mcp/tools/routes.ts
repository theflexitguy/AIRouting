// Route-derived drill-down: cards → routes → stops → one route in full. All of it runs the
// dashboard's own filter + drill pipeline, so a card's number and its rows always agree.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildDrillData, routeMatchesTech, type DrillData, type RouteRec } from "@/lib/dashboard";
import type { McpContext } from "../data-source.ts";
import { ToolInputError, paginate, round } from "../format.ts";
import { publicRoute } from "../public.ts";
import { loadDashboardState, type DashboardState } from "../snapshot.ts";
import { routeCards } from "./overview.ts";
import { defineTool, filterShape, pageShape } from "./define.ts";

type RouteRow = DrillData["routeRows"][number];
type StopRow = DrillData["stopRows"][number];

const routeKey = (r: RouteRec) => `${r.date}-${String(r.techId || r.techName)}`;
const remainingOf = (row: RouteRow, today: string) =>
  row.date > today ? row.totalStops : Math.max(0, row.totalStops - row.completed);

function shapeRouteRow(row: RouteRow, byKey: Map<string, RouteRec>, today: string) {
  const doc = byKey.get(row.key);
  return {
    date: row.date,
    technician: { id: doc?.techId ?? null, name: row.techName },
    routeGroup: row.group || null,
    template: row.template || null,
    stops: row.totalStops,
    completed: row.completed,
    remaining: remainingOf(row, today),
    driveMinutes: row.driveMinutes,
    driveTimeIsEstimate: row.driveEstimated,
    workMinutes: row.workMinutes,
    routeValue: round(row.routeValue, 2),
    stopsPerHour: round(row.stopsPerHour, 1),
  };
}

/** Per-stop detail persisted on the route (kind, value), keyed like the drill's stop rows. */
function stopDetailIndex(st: DashboardState) {
  const idx = new Map<string, { kind?: string; value?: number; serviceType?: string }>();
  for (const r of st.scopedRoutes) {
    for (const s of Array.isArray(r.stops) ? r.stops : []) {
      idx.set(`${r.date}-${String(r.techId || r.techName)}-${String(s.id)}`, { kind: s.kind, value: s.value, serviceType: s.serviceType });
    }
  }
  return idx;
}

function shapeStopRow(row: StopRow, detail: { kind?: string; value?: number; serviceType?: string } | undefined) {
  return {
    date: row.date,
    technician: row.techName,
    routeGroup: row.group || null,
    template: row.template || null,
    customerId: row.customerId || null,
    customerName: row.customerName,
    address: row.address || null,
    serviceType: row.serviceType || detail?.serviceType || null,
    stopType: detail?.kind || "regular",
    value: detail?.value === undefined ? null : round(detail.value, 2),
    status: row.status,
  };
}

const groupBy = <T>(rows: T[], key: (r: T) => string) => {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    m.set(k, [...(m.get(k) ?? []), r]);
  }
  return m;
};

export function registerRouteTools(server: McpServer, ctx: McpContext) {
  defineTool(
    server,
    ctx,
    {
      name: "get_route_summary",
      title: "Route summary (today or a date range)",
      description:
        "The dashboard's route cards for today or a date range: routes, total stops, completed, stops remaining, drive time, total/average route value, stops per hour — plus a per-day and per-route-group breakdown. " +
        "Filter-aware (technician, route group/template, subscription type, stop type). Follow with list_routes for the routes behind the numbers, or list_stops for the individual stops.",
      inputSchema: filterShape,
    },
    async (args) => {
      const st = await loadDashboardState(ctx, args);
      const rows = st.drill().routeRows;
      const total = (rs: RouteRow[]) => ({
        routes: rs.length,
        stops: rs.reduce((s, r) => s + r.totalStops, 0),
        completed: rs.reduce((s, r) => s + r.completed, 0),
        remaining: rs.reduce((s, r) => s + remainingOf(r, ctx.today), 0),
        driveMinutes: rs.reduce((s, r) => s + r.driveMinutes, 0),
        routeValue: round(rs.reduce((s, r) => s + r.routeValue, 0), 2),
      });
      return {
        appliedFilters: st.applied,
        cards: routeCards(st),
        byDay: Array.from(groupBy(rows, (r) => r.date).entries()).map(([date, rs]) => ({ date, ...total(rs) })),
        byRouteGroup: Array.from(groupBy(rows, (r) => r.group || "(none)").entries()).map(([group, rs]) => ({ group, ...total(rs) })),
        caveats: [
          ...(st.drill().hasEstimatedDrive ? ["Some routes show straight-line drive-time estimates (see routesWithEstimatedDriveTime); real road times are longer."] : []),
          ...(st.drill().hasUnknown ? ["Some past days predate per-stop completion tracking, so their completed counts are unknown until re-verified."] : []),
        ],
      };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "list_routes",
      title: "List routes",
      description:
        "The routes behind the route cards — one row per technician-day with stops, completed, remaining, drive minutes (and whether that is an estimate), route value and stops/hour. " +
        "Sort by date, stops, drive, value or stopsPerHour to find the biggest, slowest or most valuable routes. Paginated. Use get_route for one route's stops.",
      inputSchema: {
        ...filterShape,
        sortBy: z.enum(["date", "stops", "drive", "value", "stopsPerHour"]).default("date"),
        order: z.enum(["asc", "desc"]).default("asc"),
        ...pageShape,
      },
    },
    async (args) => {
      const st = await loadDashboardState(ctx, args);
      const byKey = new Map(st.scopedRoutes.map((r) => [routeKey(r), r]));
      const rows = st.drill().routeRows.map((r) => shapeRouteRow(r, byKey, ctx.today));
      const dir = args.order === "desc" ? -1 : 1;
      const num = (v: number | null) => (v === null ? Number.NEGATIVE_INFINITY : v);
      const pick: Record<string, (r: (typeof rows)[number]) => number | string> = {
        date: (r) => r.date,
        stops: (r) => r.stops,
        drive: (r) => r.driveMinutes,
        value: (r) => r.routeValue ?? 0,
        stopsPerHour: (r) => num(r.stopsPerHour),
      };
      const key = pick[args.sortBy];
      const sorted = [...rows].sort((a, b) => {
        const av = key(a), bv = key(b);
        const c = typeof av === "string" ? av.localeCompare(String(bv)) : (av as number) - (bv as number);
        return c * dir || a.date.localeCompare(b.date) || a.technician.name.localeCompare(b.technician.name);
      });
      return {
        appliedFilters: st.applied,
        window: st.window,
        totalRoutes: rows.length,
        ...paginate(sorted, args.limit, args.offset),
      };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "list_stops",
      title: "List stops",
      description:
        "Individual stops behind the Total Stops / Completed / Stops Remaining cards: customer, address, technician, date, route group/template, service type, stop type (regular/initial/reservice), value and status " +
        "(completed, pending = still to do today or earlier, scheduled = future, unknown = an old day not yet re-verified). Filter by status or search a customer name or address. Paginated.",
      inputSchema: {
        ...filterShape,
        status: z.enum(["completed", "pending", "scheduled", "unknown"]).optional().describe("Only stops in this status."),
        search: z.string().optional().describe("Case-insensitive match on customer name, address or service type."),
        ...pageShape,
      },
    },
    async (args) => {
      const st = await loadDashboardState(ctx, args);
      const details = stopDetailIndex(st);
      const all = st.drill().stopRows;
      const statusCounts: Record<string, number> = { completed: 0, pending: 0, scheduled: 0, unknown: 0 };
      for (const r of all) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
      const q = (args.search ?? "").trim().toLowerCase();
      const filtered = all.filter(
        (r) =>
          (!args.status || r.status === args.status) &&
          (!q || `${r.customerName} ${r.address} ${r.serviceType}`.toLowerCase().includes(q)),
      );
      const page = paginate(filtered, args.limit, args.offset);
      return {
        appliedFilters: st.applied,
        window: st.window,
        statusCounts,
        ...page,
        items: page.items.map((r) => shapeStopRow(r, details.get(r.key))),
      };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "get_route",
      title: "One route in full",
      description:
        "A single technician's route on a single date, in stop order: route totals, drive-time source, and every stop with customer, address, service type, stop type, value and completion status. " +
        "Use list_routes first to find dates and technicians. Works for any date, not just this week.",
      inputSchema: {
        date: z.string().describe("YYYY-MM-DD"),
        technician: z.string().describe("Technician name or id (partial names work if unambiguous)."),
      },
    },
    async (args) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new ToolInputError("date must be YYYY-MM-DD.");
      const st = await loadDashboardState(ctx, { technicians: [args.technician] });
      const dayRoutes = await ctx.data.getRoutes(args.date, args.date);
      const route = dayRoutes.find((r) => (r.totalStops || 0) > 0 && routeMatchesTech(r, st.techKeys));
      if (!route) {
        const who = dayRoutes.filter((r) => (r.totalStops || 0) > 0).map((r) => r.techName || r.techId).filter(Boolean);
        throw new ToolInputError(
          `No route found for ${args.technician} on ${args.date}. ` +
            (who.length ? `Routes that day: ${who.join(", ")}.` : "There are no routes on that date."),
        );
      }
      // Reuse the dashboard's own per-stop status logic on just this route.
      const drill = buildDrillData({ scopedRoutes: [route], jobsByDocId: st.jobsByDocId, today: ctx.today });
      const seq = Array.isArray(route.stopSequence) ? route.stopSequence.map(String) : [];
      const detailById = new Map((Array.isArray(route.stops) ? route.stops : []).map((s) => [String(s.id), s]));
      const stops = drill.stopRows.map((row, i) => {
        const d = detailById.get(seq[i]);
        return {
          position: i + 1,
          stopId: seq[i],
          customerId: row.customerId || null,
          customerName: row.customerName,
          address: row.address || null,
          serviceType: row.serviceType || d?.serviceType || null,
          stopType: d?.kind || "regular",
          value: d?.value === undefined ? null : round(d.value, 2),
          status: row.status,
        };
      });
      const row = drill.routeRows[0];
      return {
        route: publicRoute(route),
        remaining: remainingOf(row, ctx.today),
        stopsPerHour: round(row.stopsPerHour, 1),
        stops,
        caveats: [
          ...(drill.hasEstimatedDrive ? ["Drive time is a straight-line estimate, not a road time."] : []),
          ...(drill.hasUnknown ? ["This day predates per-stop completion tracking, so stop statuses are unknown."] : []),
        ],
      };
    },
  );
}
