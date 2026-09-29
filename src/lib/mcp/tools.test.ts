import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRoutiqMcpServer } from "./server.ts";
import type { MemoryFixture } from "./memory-source.ts";
import { FORBIDDEN, context } from "./test-fixtures.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const open: Client[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function connect(over: Partial<MemoryFixture> = {}): Promise<Client> {
  const server = createRoutiqMcpServer(context(over));
  const client = new Client({ name: "test", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  open.push(client);
  return client;
}

/** Call a tool and return its parsed JSON; fails the test if the tool reports an error. */
async function call(client: Client, name: string, args: Json = {}): Promise<Json> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as Array<{ text: string }>)[0].text;
  assert.ok(!r.isError, `${name} returned an error: ${text}`);
  return JSON.parse(text);
}

/** Call a tool that is expected to fail; returns the message shown to the model. */
async function fails(client: Client, name: string, args: Json = {}): Promise<string> {
  try {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(r.isError, `${name} unexpectedly succeeded`);
    return (r.content as Array<{ text: string }>)[0].text;
  } catch (e) {
    return (e as Error).message; // schema validation failures surface as protocol errors
  }
}

const ALL_TOOLS = [
  "get_dashboard_overview", "get_data_freshness", "get_kpis_and_trend", "get_route_summary", "list_routes",
  "list_stops", "get_route", "get_targets_by_service", "audit_target", "get_overdue_stops",
  "get_completed_breakdown", "get_monthly_history", "get_technician_forecast", "search_jobs", "get_job",
  "aggregate_jobs", "list_technicians", "get_filter_options", "get_configuration", "explain_metric",
];

describe("tool inventory", () => {
  it("exposes exactly the documented tools", async () => {
    const { tools } = await (await connect()).listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...ALL_TOOLS].sort());
  });

  it("marks every tool read-only and non-destructive", async () => {
    const { tools } = await (await connect()).listTools();
    for (const t of tools) {
      assert.equal(t.annotations?.readOnlyHint, true, `${t.name} must be readOnly`);
      assert.equal(t.annotations?.destructiveHint, false, `${t.name} must not be destructive`);
      assert.equal(t.annotations?.openWorldHint, false, t.name);
    }
  });

  it("describes every tool well enough for a model to choose it", async () => {
    const { tools } = await (await connect()).listTools();
    for (const t of tools) {
      assert.ok((t.description ?? "").length >= 80, `${t.name} needs a real description`);
      assert.equal(t.inputSchema.type, "object");
    }
  });
});

describe("get_dashboard_overview", () => {
  it("reports the route cards exactly as derived from the fixture", async () => {
    const o = await call(await connect(), "get_dashboard_overview");
    assert.deepEqual(
      { routes: o.routes.routes, stops: o.routes.totalStops, done: o.routes.completed, left: o.routes.stopsRemaining, drive: o.routes.driveMinutes, value: o.routes.routeValue },
      { routes: 2, stops: 10, done: 4, left: 6, drive: 80, value: 400 }, // the empty route is ignored
    );
    assert.equal(o.routes.driveTime, "1h 20m");
    assert.equal(o.routes.routesWithEstimatedDriveTime, 1);
    assert.equal(o.routes.stopsPerHour, 1.8); // 10 stops / 5.5 working hours
  });

  it("reports the week KPIs against their targets", async () => {
    const w = (await call(await connect(), "get_dashboard_overview")).week;
    assert.equal(w.routeCount, 4);
    assert.equal(w.stopsBooked, 18);
    assert.equal(w.stopsLeftOnRoutes, 9); // Mon 0 + Wed 3 + 3 + Thu 3
    assert.deepEqual(w.stopsPerRoute, { value: 4.5, target: 14, direction: "at_least", meetsTarget: false });
    assert.deepEqual(w.avgDriveMinutes, { value: 35, target: 45, direction: "at_most", meetsTarget: true });
  });

  it("reports targets, overdue, buckets, upcoming jobs and the trend", async () => {
    const o = await call(await connect(), "get_dashboard_overview");
    assert.equal(o.targets.total.target, 10);
    assert.equal(o.targets.total.done, 2);
    assert.equal(o.targets.total.status, "behind_pace");
    assert.equal(o.targets.total.pointsAheadOrBehind, -40); // 20% done vs 60% through the month
    assert.equal(o.targets.lines.length, 5);
    assert.deepEqual(o.targets.lines.map((l: Json) => l.line), ["general", "mosquito", "lawn", "termite", "commercial"]);
    assert.equal(o.overdue.customers, 1);
    assert.equal(o.completedThisMonth.completedAppointments, 656);
    assert.equal(o.jobsDueNext7Days.length, 7);
    assert.equal(o.jobsDueNext7Days[0].date, "2026-09-16");
    assert.equal(o.trend8Weeks.length, 8);
    assert.ok(o.summary.some((l: string) => /BEHIND pace/.test(l)));
  });

  it("tells the model which tool opens each number", async () => {
    const o = await call(await connect(), "get_dashboard_overview");
    const tools = o.drill.map((d: Json) => d.tool);
    for (const t of ["get_route_summary", "get_targets_by_service", "get_overdue_stops", "get_completed_breakdown", "get_technician_forecast", "explain_metric"]) {
      assert.ok(tools.includes(t), t);
    }
  });

  it("hides last month's completed buckets from the 'this month' card", async () => {
    const stale = { ...(await import("./test-fixtures.ts")).monthlyDone["2026-08"] };
    const o = await call(await connect({ liveMonthlyDone: stale }), "get_dashboard_overview");
    assert.equal(o.completedThisMonth, null);
  });
});

describe("filters", () => {
  it("narrows to a technician by partial name", async () => {
    const c = await call(await connect(), "get_route_summary", { technicians: ["kalin"] });
    assert.deepEqual([c.cards.routes, c.cards.totalStops, c.cards.completed, c.cards.stopsRemaining], [1, 6, 3, 3]);
    assert.equal(c.appliedFilters.technicians[0].name, "Kalin Jasso");
  });

  it("narrows by route group with spelling-insensitive matching", async () => {
    const c = await call(await connect(), "get_route_summary", { routeGroups: ["gpc"] });
    assert.deepEqual([c.cards.routes, c.cards.totalStops], [1, 6]);
  });

  it("supports a date range and a route template", async () => {
    const all = await call(await connect(), "get_route_summary", { startDate: "2026-09-14", endDate: "2026-09-17" });
    assert.deepEqual(
      { routes: all.cards.routes, stops: all.cards.totalStops, done: all.cards.completed, left: all.cards.stopsRemaining, drive: all.cards.driveMinutes, value: all.cards.routeValue },
      { routes: 4, stops: 18, done: 9, left: 9, drive: 140, value: 720 },
    );
    assert.deepEqual(all.byDay.map((d: Json) => d.date), ["2026-09-14", "2026-09-16", "2026-09-17"]);
    const rain = await call(await connect(), "get_route_summary", { startDate: "2026-09-14", endDate: "2026-09-17", routeTemplates: ["rain day"] });
    assert.deepEqual([rain.cards.routes, rain.cards.totalStops], [1, 3]);
  });

  it("filters at the STOP level by stop type (initial / reservice)", async () => {
    const initial = await call(await connect(), "get_route_summary", { stopTypes: ["initial"] });
    assert.deepEqual([initial.cards.routes, initial.cards.totalStops, initial.cards.completed], [1, 1, 1]);
    const re = await call(await connect(), "get_route_summary", { stopTypes: ["reservice"] });
    assert.deepEqual([re.cards.routes, re.cards.totalStops, re.cards.completed], [1, 1, 0]);
  });

  it("composes subscription type with stop type", async () => {
    const gp = await call(await connect(), "get_route_summary", { subscriptionTypes: ["general pest"] });
    assert.equal(gp.cards.totalStops, 9); // the stand-alone reservice (type "Reservice") drops out
    const none = await call(await connect(), "get_route_summary", { subscriptionTypes: ["General Pest"], stopTypes: ["reservice"] });
    assert.equal(none.cards.routes, 0);
  });

  it("returns actionable errors for bad input", async () => {
    const c = await connect();
    assert.match(await fails(c, "get_route_summary", { technicians: ["Nobody"] }), /Unknown technician "Nobody".*Kalin Jasso/);
    assert.match(await fails(c, "get_route_summary", { routeGroups: ["Sewers"] }), /Unknown route group "Sewers"\. Valid values: GPC, Specialty/);
    assert.match(await fails(c, "get_route_summary", { subscriptionTypes: ["Nope"] }), /Unknown subscription type/);
    assert.match(await fails(c, "get_route_summary", { startDate: "2026-09-01" }), /both startDate and endDate/);
    assert.match(await fails(c, "get_route_summary", { startDate: "09/01/2026", endDate: "2026-09-02" }), /YYYY-MM-DD/);
    assert.match(await fails(c, "get_route_summary", { startDate: "2026-09-10", endDate: "2026-09-01" }), /on or before/);
    assert.match(await fails(c, "get_route_summary", { startDate: "2024-01-01", endDate: "2026-09-01" }), /too long/);
    assert.match(await fails(c, "get_route_summary", { stopTypes: ["bogus"] }), /stopTypes|Invalid/i);
  });

  it("refuses an ambiguous partial technician name", async () => {
    const msg = await fails(await connect({ techs: [
      { id: "a", name: "Sam Smith", skillNames: [] }, { id: "b", name: "Sam Jones", skillNames: [] },
    ] }), "get_route_summary", { technicians: ["sam"] });
    assert.match(msg, /matches several technicians.*Sam Smith.*Sam Jones/);
  });
});

describe("routes and stops", () => {
  it("lists routes with sorting and pagination", async () => {
    const c = await connect();
    const byStops = await call(c, "list_routes", { sortBy: "stops", order: "desc" });
    assert.deepEqual(byStops.items.map((r: Json) => r.technician.name), ["Kalin Jasso", "Hayden Allen"]);
    assert.equal(byStops.totalRoutes, 2);
    const p1 = await call(c, "list_routes", { limit: 1, offset: 0 });
    assert.equal(p1.hasMore, true);
    assert.equal(p1.nextOffset, 1);
    const p2 = await call(c, "list_routes", { limit: 1, offset: 1 });
    assert.equal(p2.hasMore, false);
    assert.equal(p2.nextOffset, null);
    assert.notEqual(p1.items[0].technician.name, p2.items[0].technician.name);
  });

  it("shows whether each route's drive time is an estimate", async () => {
    const { items } = await call(await connect(), "list_routes");
    const byName = Object.fromEntries(items.map((r: Json) => [r.technician.name, r]));
    assert.equal(byName["Hayden Allen"].driveTimeIsEstimate, true);
    assert.equal(byName["Kalin Jasso"].driveTimeIsEstimate, false);
    assert.equal(byName["Kalin Jasso"].remaining, 3);
  });

  it("lists stops with status counts, filters and search", async () => {
    const c = await connect();
    const all = await call(c, "list_stops", { limit: 200 });
    assert.deepEqual(all.statusCounts, { completed: 4, pending: 6, scheduled: 0, unknown: 0 });
    assert.equal(all.total, 10);
    const pending = await call(c, "list_stops", { status: "pending", limit: 200 });
    assert.equal(pending.total, 6);
    const hit = await call(c, "list_stops", { search: "walk-in" });
    assert.equal(hit.total, 1);
    assert.deepEqual(
      { name: hit.items[0].customerName, type: hit.items[0].stopType, value: hit.items[0].value, svc: hit.items[0].serviceType },
      { name: "Walk-in Reservice", type: "reservice", value: 0, svc: "Reservice" },
    );
  });

  it("marks future stops as scheduled", async () => {
    const r = await call(await connect(), "list_stops", { startDate: "2026-09-17", endDate: "2026-09-17" });
    assert.deepEqual(r.statusCounts, { completed: 0, pending: 0, scheduled: 3, unknown: 0 });
  });

  it("returns one route in full, in stop order, with the dashboard's status logic", async () => {
    const r = await call(await connect(), "get_route", { date: "2026-09-16", technician: "kalin" });
    assert.equal(r.route.techName, "Kalin Jasso");
    assert.equal(r.route.driveTimeIsEstimate, false);
    assert.deepEqual(r.stops.map((s: Json) => s.position), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(r.stops.map((s: Json) => s.status), ["completed", "completed", "completed", "pending", "pending", "pending"]);
    assert.equal(r.stops[1].stopType, "initial");
    assert.equal(r.stops[5].stopType, "reservice");
    assert.equal(r.stops[0].address, "201 Main St, Bentonville, 72712");
    assert.equal(r.remaining, 3);
    assert.equal(r.stopsPerHour, 1.8);
  });

  it("explains a missing route by naming who did run that day", async () => {
    const c = await connect();
    assert.match(await fails(c, "get_route", { date: "2026-09-16", technician: "Zach" }), /No route found for Zach.*Kalin Jasso, Hayden Allen/);
    assert.match(await fails(c, "get_route", { date: "2026-01-01", technician: "Kalin" }), /no routes on that date/);
    assert.match(await fails(c, "get_route", { date: "yesterday", technician: "Kalin" }), /YYYY-MM-DD/);
  });

  it("reports weekly KPIs and an 8-week trend", async () => {
    const r = await call(await connect(), "get_kpis_and_trend");
    assert.equal(r.kpis.routeCount, 4);
    assert.equal(r.trend8Weeks.length, 8);
    assert.equal(r.trend8Weeks[7].routes, 4); // the current week is last
  });
});

describe("consistency: a card, its routes and its stops always agree", () => {
  // The drill-down promise: whatever filters are applied, the number on the card equals the sum
  // of the routes behind it and the count of the stops behind those.
  const COMBOS: Array<[string, Json]> = [
    ["no filters", {}],
    ["technician", { technicians: ["kalin"] }],
    ["route group", { routeGroups: ["Specialty"] }],
    ["subscription type", { subscriptionTypes: ["General Pest"] }],
    ["stop type: initial", { stopTypes: ["initial"] }],
    ["stop type: reservice", { stopTypes: ["reservice"] }],
    ["type + kind", { subscriptionTypes: ["General Pest"], stopTypes: ["regular"] }],
    ["date range", { startDate: "2026-09-14", endDate: "2026-09-17" }],
    ["range + technician", { startDate: "2026-09-14", endDate: "2026-09-17", technicians: ["hayden"] }],
    ["range + template", { startDate: "2026-09-14", endDate: "2026-09-17", routeTemplates: ["Rain Day"] }],
    ["range that matches nothing", { startDate: "2026-01-01", endDate: "2026-01-07" }],
  ];
  for (const [label, filters] of COMBOS) {
    it(label, async () => {
      const c = await connect();
      const cards = (await call(c, "get_route_summary", filters)).cards;
      const routes = await call(c, "list_routes", { ...filters, limit: 200 });
      const stops = await call(c, "list_stops", { ...filters, limit: 200 });
      const sum = (k: string) => routes.items.reduce((n: number, r: Json) => n + r[k], 0);
      assert.equal(cards.routes, routes.totalRoutes, "routes");
      assert.equal(cards.totalStops, sum("stops"), "total stops = sum over routes");
      assert.equal(cards.totalStops, stops.total, "total stops = stop rows");
      assert.equal(cards.completed, sum("completed"), "completed = sum over routes");
      assert.equal(cards.completed, stops.statusCounts.completed, "completed = completed stop rows");
      assert.equal(cards.stopsRemaining, sum("remaining"), "remaining = sum over routes");
      assert.equal(cards.stopsRemaining, stops.statusCounts.pending + stops.statusCounts.scheduled, "remaining = open stop rows");
      assert.equal(cards.driveMinutes, sum("driveMinutes"), "drive");
      assert.ok(Math.abs(cards.routeValue - sum("routeValue")) < 0.01, "value");
    });
  }

  it("every technician's route detail matches their row in the route list", async () => {
    const c = await connect();
    const { items } = await call(c, "list_routes", { limit: 200 });
    for (const r of items) {
      const d = await call(c, "get_route", { date: r.date, technician: r.technician.name });
      assert.equal(d.stops.length, r.stops, `${r.technician.name} stop count`);
      assert.equal(d.stops.filter((s: Json) => s.status === "completed").length, r.completed, `${r.technician.name} completed`);
      assert.equal(d.remaining, r.remaining, `${r.technician.name} remaining`);
    }
  });

  it("the week's technician workload adds up to the week's KPIs", async () => {
    const c = await connect();
    const { technicians } = await call(c, "list_technicians");
    const week = (await call(c, "get_dashboard_overview")).week;
    assert.equal(technicians.reduce((n: number, t: Json) => n + t.workload.routes, 0), week.routeCount);
    assert.equal(technicians.reduce((n: number, t: Json) => n + t.workload.stops, 0), week.stopsBooked);
    assert.equal(technicians.reduce((n: number, t: Json) => n + t.workload.remaining, 0), week.stopsLeftOnRoutes);
  });

  it("the overview agrees with the dedicated tools it links to", async () => {
    const c = await connect();
    const o = await call(c, "get_dashboard_overview");
    const t = await call(c, "get_targets_by_service");
    const od = await call(c, "get_overdue_stops");
    assert.deepEqual(o.targets.total, t.total);
    assert.deepEqual(o.targets.lines.map((l: Json) => [l.line, l.target, l.done]), t.lines.map((l: Json) => [l.line, l.target, l.done]));
    assert.equal(o.overdue.customers, od.card.customers);
  });
});

describe("targets", () => {
  it("returns live Targets by Service with the method behind each line", async () => {
    const t = await call(await connect(), "get_targets_by_service");
    assert.equal(t.mode, "live");
    const line = Object.fromEntries(t.lines.map((l: Json) => [l.line, l]));
    assert.deepEqual([line.general.target, line.general.done], [6, 1]);
    assert.deepEqual([line.lawn.target, line.lawn.done], [1, 1]);
    assert.equal(line.general.method, "seasonality_rate");
    assert.equal(line.lawn.method, "lawn_round_pace");
    assert.equal(line.termite.method, "due_this_month");
    assert.equal(line.commercial.method, "due_this_month");
    assert.equal(t.lines.reduce((s: number, l: Json) => s + l.target, 0), t.total.target);
  });

  it("audits every line and each audit reconciles with its card", async () => {
    const c = await connect();
    for (const line of ["general", "mosquito", "lawn", "termite", "commercial"]) {
      const a = await call(c, "audit_target", { line, limit: 200 });
      assert.equal(a.reconciles, true, `${line} audit must match its card`);
      assert.equal(a.cardTarget, a.auditTarget, line);
      assert.ok(a.formula.length > 20);
    }
  });

  it("pages, searches and filters the audit rows", async () => {
    const c = await connect();
    const a = await call(c, "audit_target", { line: "general", limit: 3 });
    assert.equal(a.items.length, 3);
    assert.equal(a.total, 17);
    assert.equal(a.hasMore, true);
    assert.ok(a.items.every((r: Json) => Number.isFinite(r.contribution) && String(r.contribution).length <= 6));
    const s = await call(c, "audit_target", { line: "general", search: "ben monthly" });
    assert.equal(s.total, 1);
    assert.equal(s.items[0].frequencyDays, 30);
  });

  it("rewinds to a past date (as-of) and says how 'done' was sourced", async () => {
    const t = await call(await connect(), "get_targets_by_service", { mode: "as_of", asOfDate: "2026-09-10" });
    assert.equal(t.mode, "as_of");
    assert.equal(t.lines.length, 6);
    assert.equal(t.coveredByRoutes, false); // no routes exist before 09-14 in the fixture
    assert.match(t.completedSource, /UNDERCOUNT/);
    assert.deepEqual(t.monthToDate, { from: "2026-09-01", to: "2026-09-10" });
  });

  it("validates as-of input", async () => {
    const c = await connect();
    assert.match(await fails(c, "get_targets_by_service", { mode: "as_of" }), /asOfDate/);
    assert.match(await fails(c, "get_targets_by_service", { mode: "as_of", asOfDate: "2026-09-16" }), /before today/);
    assert.match(await fails(c, "get_targets_by_service", { mode: "as_of", asOfDate: "2026-09-99x" }), /YYYY-MM-DD/);
    assert.match(await fails(c, "get_targets_by_service", { mode: "period" }), /needs a period/);
  });

  it("shows a historical period from cached monthly aggregates", async () => {
    const c = await connect();
    const last = await call(c, "get_targets_by_service", { mode: "period", period: "last_month" });
    assert.deepEqual(last.months, ["2026-08"]);
    assert.equal(last.monthsWithCachedData, 1);
    assert.deepEqual(last.monthsMissing, []);
    assert.equal(last.lines.find((l: Json) => l.line === "general").done, 300);
    assert.equal(last.total.done, 300 + 80 + 20 + 5 + 15);
    const q = await call(c, "get_targets_by_service", { mode: "period", period: "last_quarter" });
    assert.equal(q.monthsWithCachedData, 0);
    assert.equal(q.monthsMissing.length, 3);
    assert.equal(q.total.done, 0);
  });
});

describe("overdue", () => {
  it("counts customers on the card and lists why others are excluded", async () => {
    const o = await call(await connect(), "get_overdue_stops", { include: "both" });
    assert.deepEqual(o.card, { customers: 1, subscriptions: 1 });
    assert.equal(o.counted.items[0].customerName, "Cy Overdue");
    assert.equal(o.counted.items[0].daysOverdue, 27);
    assert.equal(o.counted.items[0].windowDays, 15); // a 90-day subscription
    const why = Object.fromEntries(o.excluded.items.map((r: Json) => [r.customerName, r.whyNotCounted[0]]));
    assert.match(why["Di Balance"], /balance \$650\.00 \(over \$420\.00\)/);
    assert.match(why["Lu Note"], /scheduling note: call first/);
    assert.match(why["Kim PendingCancel"], /pending cancel/);
    assert.match(why["Ed AlreadyBooked"], /already booked 2026-09-17/);
    assert.equal(o.excludedSummary.balanceOverGateTotal, 650);
  });

  it("honours include, filters, sorting and pagination", async () => {
    const c = await connect();
    const counted = await call(c, "get_overdue_stops");
    assert.ok(counted.counted && !counted.excluded);
    const excluded = await call(c, "get_overdue_stops", { include: "excluded" });
    assert.ok(excluded.excluded && !excluded.counted);
    const rich = await call(c, "get_overdue_stops", { include: "excluded", minBalance: 1 });
    assert.deepEqual(rich.excluded.items.map((r: Json) => r.customerName), ["Di Balance"]);
    const late = await call(c, "get_overdue_stops", { include: "excluded", sortBy: "daysOverdue" });
    assert.deepEqual(late.excluded.items.map((r: Json) => r.daysOverdue), [46, 37, 32, 22]);
    const page = await call(c, "get_overdue_stops", { include: "excluded", limit: 2, offset: 2 });
    assert.equal(page.excluded.items.length, 2);
    assert.equal(page.excluded.hasMore, false);
    const line = await call(c, "get_overdue_stops", { include: "both", serviceLine: "lawn" });
    assert.equal(line.counted.total + line.excluded.total, 0);
  });

  it("states the rules from the real thresholds", async () => {
    const o = await call(await connect(), "get_overdue_stops");
    assert.match(o.rules.join(" "), /\$420/);
    assert.match(o.rules.join(" "), /90-day interval: 15d/);
  });
});

describe("completed work, history and forecast", () => {
  it("returns this month's buckets, and admits when they are not computed", async () => {
    const c = await connect();
    const m = await call(c, "get_completed_breakdown");
    assert.equal(m.available, true);
    assert.equal(m.summary.initials.total, 44);
    assert.equal(m.summary.reservices, 30);
    assert.equal(m.detail.newSubscriptions, 50);
    const none = await call(await connect({ liveMonthlyDone: null, monthlyDone: {} }), "get_completed_breakdown");
    assert.equal(none.available, false);
    assert.match(none.message, /not been computed/);
  });

  it("sums a past period, lists missing months, and surfaces unclassified types", async () => {
    const c = await connect();
    const r = await call(c, "get_completed_breakdown", { period: "last_3_months" });
    assert.deepEqual(r.months, ["2026-07", "2026-08", "2026-09"]);
    assert.equal(r.monthsWithData, 3);
    assert.equal(r.totals.reservices, 90);
    assert.equal(r.totals.recurringDoneByLine.general, 900);
    assert.deepEqual(r.unclassifiedTypes, { "Cancelation Fee": 2, "Technician Tip": 1 });
    const q = await call(c, "get_completed_breakdown", { period: "last_quarter" });
    assert.equal(q.monthsMissing.length, 3);
    assert.equal(q.perMonth[0].computed, false);
  });

  it("returns monthly history oldest-first and flags missing months", async () => {
    const h = await call(await connect(), "get_monthly_history", { months: 4 });
    assert.deepEqual(h.history.map((m: Json) => m.month), ["2026-07", "2026-08", "2026-09"]);
    assert.deepEqual(h.missing, ["2026-06"]);
    assert.deepEqual(h.history[1].unclassifiedTypes, { "Cancelation Fee": 2, "Technician Tip": 1 });
  });

  it("forecasts 12 months and treats growthPct as a what-if", async () => {
    const c = await connect();
    const f = await call(c, "get_technician_forecast");
    assert.equal(f.months.length, 12);
    assert.equal(f.months[0].month, "2026-09"); // the forecast starts with the current month
    assert.equal(f.headline.firstMonth, "2026-09");
    assert.equal(f.growth.source, "manual");
    assert.equal(f.growth.isWhatIf, false);
    assert.equal(f.categories.length, 5);
    const w = await call(c, "get_technician_forecast", { growthPct: 10 });
    assert.equal(w.growth.isWhatIf, true);
    assert.equal(w.growth.annualPct, 214); // 1.10^12
    assert.ok(w.months[11].totalNeed >= f.months[11].totalNeed);
    assert.match(await fails(c, "get_technician_forecast", { growthPct: 99 }), /too big|<=|50|Invalid/i);
  });
});

describe("subscriptions", () => {
  it("searches with filters, sorting, facets and pagination", async () => {
    const c = await connect();
    const all = await call(c, "search_jobs", { limit: 5 });
    assert.equal(all.totalInScope, 22);
    assert.equal(all.matching, 22);
    assert.deepEqual(all.byServiceLine, { general: 17, mosquito: 1, termite: 1, commercial: 1, lawn: 2 });
    assert.equal(all.items.length, 5);
    assert.equal((await call(c, "search_jobs", { query: "cy over" })).matching, 1);
    assert.equal((await call(c, "search_jobs", { overdue: true })).matching, 1);
    assert.equal((await call(c, "search_jobs", { overdue: false })).matching, 21);
    assert.equal((await call(c, "search_jobs", { serviceLines: ["lawn"] })).matching, 2);
    assert.equal((await call(c, "search_jobs", { statuses: ["scheduled"] })).matching, 2);
    assert.equal((await call(c, "search_jobs", { technician: "hayden" })).matching, 3);
    assert.equal((await call(c, "search_jobs", { dueFrom: "2026-09-16", dueTo: "2026-09-30" })).matching, 5);
    assert.equal((await call(c, "search_jobs", { minBalance: 400 })).matching, 1);
    assert.equal((await call(c, "search_jobs", { booked: true })).matching, 2);
    assert.equal((await call(c, "search_jobs", { serviceTypes: ["mosquito fogging"] })).matching, 1);
    const top = await call(c, "search_jobs", { sortBy: "balance", limit: 1 });
    assert.equal(top.items[0].customerName, "Di Balance");
    assert.equal(top.items[0].balance, 650);
    const page = await call(c, "search_jobs", { limit: 5, offset: 20 });
    assert.equal(page.items.length, 2);
    assert.equal(page.hasMore, false);
  });

  it("gives more detail only on request", async () => {
    const c = await connect();
    const s = (await call(c, "search_jobs", { query: "ada" })).items[0];
    const f = (await call(c, "search_jobs", { query: "ada", detail: "full" })).items[0];
    assert.equal(s.flags, undefined);
    assert.equal(f.flags.pendingCancel, false);
    assert.equal(f.productionValue > 0, true);
    assert.ok(f.deadline && f.booking);
  });

  it("looks up a subscription and shows where it is scheduled", async () => {
    const c = await connect();
    const r = await call(c, "get_job", { id: "sub_101" });
    assert.equal(r.matches, 1);
    assert.deepEqual(r.jobs[0].appearsOnRoutes, [
      { date: "2026-09-17", technician: "Kalin Jasso", routeGroup: "GPC", position: 1, completed: false, stopType: "regular" },
    ]);
    const stop = await call(c, "get_job", { id: "sub_201" });
    assert.deepEqual(stop.jobs[0].appearsOnRoutes.map((x: Json) => x.date), ["2026-09-14", "2026-09-16"]);
    assert.equal((await call(c, "get_job", { customerId: "c103" })).jobs[0].job.customerName, "Cy Overdue");
    assert.equal((await call(c, "get_job", { subscriptionId: "104" })).jobs[0].job.balance, 650);
    assert.match(await fails(c, "get_job", { id: "sub_nope" }), /No in-scope subscription/);
    assert.match(await fails(c, "get_job", {}), /Provide one of/);
  });

  it("aggregates subscriptions by any dimension", async () => {
    const c = await connect();
    const line = await call(c, "aggregate_jobs", { groupBy: "serviceLine" });
    assert.equal(line.groups, 5);
    const general = line.items.find((g: Json) => g.group === "general");
    assert.deepEqual(
      { n: general.subscriptions, bal: general.balanceTotal, overdue: general.countedOverdue, booked: general.booked, cancel: general.pendingCancel },
      { n: 17, bal: 650, overdue: 1, booked: 2, cancel: 1 },
    );
    assert.equal(line.items[0].group, "general"); // largest first
    assert.equal(line.items.reduce((s: number, g: Json) => s + g.subscriptions, 0), 22);
    const tech = await call(c, "aggregate_jobs", { groupBy: "preferredTech" });
    assert.deepEqual(Object.fromEntries(tech.items.map((g: Json) => [g.group, g.subscriptions])), { "Kalin Jasso": 19, "Hayden Allen": 2, "Zach DeRoush": 1 });
    const filtered = await call(c, "aggregate_jobs", { groupBy: "status", overdue: true });
    assert.equal(filtered.matching, 1);
    const due = await call(c, "aggregate_jobs", { groupBy: "dueMonth" });
    assert.ok(due.items.some((g: Json) => g.group === "2026-09"));
  });
});

describe("reference tools", () => {
  it("shows technician workload for the week", async () => {
    const { technicians, window } = await call(await connect(), "list_technicians");
    assert.deepEqual(window, { from: "2026-09-14", to: "2026-09-20" });
    assert.deepEqual(technicians.map((t: Json) => t.name), ["Kalin Jasso", "Hayden Allen", "Zach DeRoush"]);
    const [kalin, hayden, zach] = technicians;
    assert.deepEqual(kalin.workload, { routes: 3, stops: 14, completed: 8, remaining: 6, driveMinutes: 110, routeValue: 560, stopsPerRoute: 4.7, stopsPerHour: 1.8 });
    assert.equal(hayden.workload.stops, 4);
    assert.deepEqual(zach.workload.stopsPerRoute, null); // the empty route does not count
    assert.deepEqual(hayden.preferredSubscriptions, { total: 2, countedOverdue: 1 });
    assert.deepEqual(kalin.skills, ["GPC", "Initials"]);
  });

  it("lists the filter dropdown values", async () => {
    const f = await call(await connect(), "get_filter_options");
    assert.equal(f.technicians.length, 3);
    assert.deepEqual(f.routeTemplates, ["Rain Day", "Regular"]);
    assert.deepEqual(f.routeGroups.savedInSettings, ["GPC", "Specialty"]);
    assert.deepEqual(f.stopTypes.map((s: Json) => s.value), ["regular", "initial", "reservice"]);
    assert.equal(f.periods.length, 7);
    assert.equal(f.subscriptionTypes.find((t: Json) => t.name === "General Pest").subscriptions, 17);
    assert.equal(f.serviceLines.find((l: Json) => l.value === "lawn").label, "Lawn");
  });

  it("exposes thresholds, and only the non-secret company settings", async () => {
    const cfg = await call(await connect(), "get_configuration");
    assert.equal(cfg.overdueRules.balanceGateDollars, 420);
    assert.equal(cfg.kpiTargets.stopsPerRoute.target, 14);
    assert.equal(cfg.calendar.monthWorkingDays, 20);
    assert.deepEqual(Object.keys(cfg.company).sort(), ["forecastMonthlyGrowthPct", "name", "savedRouteGroups"]);
    assert.equal(cfg.overdueRules.graceDaysByServiceIntervalDays["90"], 15);
  });

  it("explains metrics", async () => {
    const c = await connect();
    const list = await call(c, "explain_metric");
    assert.ok(list.metrics.length >= 15);
    const one = await call(c, "explain_metric", { metric: "overdue" });
    assert.equal(one.matches.length, 1);
    assert.equal(one.matches[0].tool, "get_overdue_stops");
    assert.match(one.matches[0].definition, /\$420/);
    assert.match(await fails(c, "explain_metric", { metric: "zzz" }), /Known: routes/);
  });
});

describe("data freshness", () => {
  it("reports sync age and routes per day", async () => {
    const f = await call(await connect(), "get_data_freshness");
    assert.equal(f.sync.ageHours, 5.9);
    assert.equal(f.sync.lastRunMode, "incremental");
    assert.deepEqual(f.warnings, []);
    assert.deepEqual(f.routesThisWeek.routesByDate, { "2026-09-14": 1, "2026-09-16": 2, "2026-09-17": 1 });
    assert.equal(f.routesFinalizedThrough, "2026-09-14");
    assert.deepEqual(f.fieldRoutesApiToday, { date: "2026-09-16", reads: 120, writes: 0 });
  });

  it("warns when the data is stale, syncing, never synced, or the watermark is stuck", async () => {
    const stale = await call(await connect({ sync: { lastRunAt: "2026-09-13T00:00:00.000Z" } }), "get_data_freshness");
    assert.match(stale.warnings.join(" "), /87 hours ago/);
    const running = await call(await connect({ sync: { runActive: true } }), "get_data_freshness");
    assert.match(running.warnings.join(" "), /in progress/);
    const never = await call(await connect({ sync: { lastRunAt: null } }), "get_data_freshness");
    assert.match(never.warnings.join(" "), /No completed FieldRoutes sync/);
    const stuck = await call(await connect({ sync: { finalizedThrough: "2026-08-01" } }), "get_data_freshness");
    assert.match(stuck.warnings.join(" "), /finalized only through 2026-08-01/);
    const overview = await call(await connect({ sync: { lastRunAt: "2026-09-13T00:00:00.000Z" } }), "get_dashboard_overview");
    assert.ok(overview.summary.some((l: string) => /87 hours ago/.test(l)), "overview must surface staleness");
  });
});

describe("privacy", () => {
  // The fixture's jobs carry a phone, email, latitude and an API key; nothing that leaves the
  // server may contain any of them, through any tool, in either the text or structured result.
  const CALLS: Array<[string, Json]> = [
    ["get_dashboard_overview", {}], ["get_data_freshness", {}], ["get_kpis_and_trend", {}], ["get_route_summary", {}],
    ["list_routes", {}], ["list_stops", {}], ["get_route", { date: "2026-09-16", technician: "kalin" }],
    ["get_targets_by_service", {}], ["audit_target", { line: "general" }], ["get_overdue_stops", { include: "both" }],
    ["get_completed_breakdown", {}], ["get_monthly_history", {}], ["get_technician_forecast", {}],
    ["search_jobs", { detail: "full", limit: 200 }], ["get_job", { id: "sub_101" }], ["aggregate_jobs", { groupBy: "city" }],
    ["list_technicians", {}], ["get_filter_options", {}], ["get_configuration", {}], ["explain_metric", {}],
  ];

  it("covers every tool", () => {
    assert.deepEqual(CALLS.map(([n]) => n).sort(), [...ALL_TOOLS].sort());
  });

  for (const [name, args] of CALLS) {
    it(`${name} leaks nothing private`, async () => {
      const r = await (await connect()).callTool({ name, arguments: args });
      assert.ok(!r.isError, JSON.stringify(r.content));
      const blob = JSON.stringify(r);
      for (const secret of FORBIDDEN) assert.ok(!blob.includes(secret), `${name} leaked "${secret}"`);
    });
  }
});

describe("resources and prompts", () => {
  it("serves the guide and the glossary", async () => {
    const c = await connect();
    const { resources } = await c.listResources();
    assert.deepEqual(resources.map((r) => r.uri).sort(), ["routiq://glossary", "routiq://guide"]);
    const guide = await c.readResource({ uri: "routiq://guide" });
    assert.match((guide.contents[0] as { text: string }).text, /get_dashboard_overview[\s\S]*audit_target/);
    const glossaryRes = await c.readResource({ uri: "routiq://glossary" });
    const glossary = JSON.parse((glossaryRes.contents[0] as { text: string }).text);
    assert.ok(glossary.length >= 15);
    assert.ok(glossary.every((e: Json) => e.key && e.definition && e.tool));
  });

  it("offers ready-made workflows that only reference real tools", async () => {
    const c = await connect();
    const { prompts } = await c.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), ["audit_metric", "collections_focus", "daily_briefing", "technician_review", "weekly_review"]);
    const known = new Set(ALL_TOOLS);
    for (const p of prompts) {
      const args = p.name === "audit_metric" ? { metric: "Lawn target" } : p.name === "technician_review" ? { technician: "Kalin" } : {};
      const text = ((await c.getPrompt({ name: p.name, arguments: args })).messages[0].content as { text: string }).text;
      const mentioned = text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];
      const toolLike = mentioned.filter((m) => ALL_TOOLS.some((t) => t.split("_")[0] === m.split("_")[0]) && /^(get|list|search|aggregate|audit|explain)_/.test(m));
      for (const m of toolLike) assert.ok(known.has(m), `${p.name} references unknown tool ${m}`);
    }
    const audit = await c.getPrompt({ name: "audit_metric", arguments: { metric: "Lawn target" } });
    assert.match((audit.messages[0].content as { text: string }).text, /Lawn target/);
  });
});

describe("read-only guarantee", () => {
  it("gives the tools no way to write: the data contract only has getters", async () => {
    const { MemoryDataSource } = await import("./memory-source.ts");
    const { FirestoreDataSource } = await import("./firestore-source.ts");
    for (const cls of [MemoryDataSource, FirestoreDataSource]) {
      const methods = Object.getOwnPropertyNames(cls.prototype).filter((n) => n !== "constructor" && typeof (cls.prototype as Json)[n] === "function");
      assert.ok(methods.filter((m) => m.startsWith("get")).length >= 7, `${cls.name} must expose the getters`);
      // No method may be named like a write, whatever helpers are added later.
      const WRITE_LIKE = ["set", "update", "delete", "remove", "add", "write", "commit", "create", "save", "put", "insert", "upsert", "patch", "batch", "destroy", "drop"];
      for (const banned of WRITE_LIKE) {
        assert.ok(!methods.some((m) => m.toLowerCase().startsWith(banned)), `${cls.name} has a write-like method: ${banned}*`);
      }
    }
  });
});
