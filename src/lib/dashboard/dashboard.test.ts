import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDrillData,
  buildJobsByDocId,
  buildOverdueDrill,
  buildTechKeys,
  computeDashboardBounds,
  computeDashboardStats,
  makeRouteFilter,
  routeMatchesTech,
  selectScopedRoutes,
  stopKindOf,
  sumMonthlyDone,
} from "./index.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
const R = (o: any): any => ({ totalStops: 0, stopSequence: [], stops: [], ...o });
const J = (o: any): any => ({ inScope: true, serviceLine: "general", frequency: 90, ...o });
const stop = (id: string, completed: boolean, kind = "regular", extra: any = {}) => ({ id, customerName: id, value: 10, completed, kind, ...extra });

describe("computeDashboardBounds", () => {
  it("uses Monday–Sunday weeks and calendar months", () => {
    assert.deepEqual(computeDashboardBounds("2026-09-16"), {
      weekStart: "2026-09-14", weekEnd: "2026-09-20", monthStart: "2026-09-01", monthEnd: "2026-09-30", monthIndex: 9, trendStart: "2026-07-27",
    });
  });
  it("keeps a Sunday in the week that ends on it, and a Monday in the week that starts on it", () => {
    assert.equal(computeDashboardBounds("2026-09-20").weekStart, "2026-09-14");
    assert.equal(computeDashboardBounds("2026-09-14").weekStart, "2026-09-14");
    assert.equal(computeDashboardBounds("2026-09-21").weekStart, "2026-09-21");
  });
  it("handles year and leap-month boundaries", () => {
    const jan = computeDashboardBounds("2026-01-01");
    assert.equal(jan.weekStart, "2025-12-29");
    assert.equal(jan.monthIndex, 1);
    assert.equal(computeDashboardBounds("2028-02-10").monthEnd, "2028-02-29");
    assert.equal(computeDashboardBounds("2026-12-31").monthEnd, "2026-12-31");
  });
  it("starts the 8-week trend seven weeks before this week", () => {
    const b = computeDashboardBounds("2026-09-16");
    assert.equal((Date.parse(b.weekStart) - Date.parse(b.trendStart)) / 86_400_000, 49);
  });
});

describe("sumMonthlyDone", () => {
  const doc = (o: any = {}): any => ({
    recurringDoneByLine: { general: 10, mosquito: 5 }, initialsByLine: { general: 2, wildlife: 1 }, initialsTotal: 3,
    reserviceDone: 4, followupDone: 1, specialtyDone: 2, wildlifeDone: 1, newCustomers: 6, newSubscriptions: 5, completedAppointments: 30, ...o,
  });
  it("sums cached months, skipping ones that are not computed", () => {
    const s = sumMonthlyDone([doc(), null, doc({ recurringDoneByLine: { general: 1 } })], 3);
    assert.equal(s.byLine.general, 11);
    assert.equal(s.byLine.mosquito, 5);
    assert.equal(s.byLine.lawn, 0); // every tracked line is present
    assert.equal(s.initials, 6);
    assert.equal(s.reservices, 8);
    assert.equal(s.completedAppointments, 60);
    assert.equal(s.monthsAvailable, 2);
    assert.equal(s.monthsTotal, 3);
  });
  it("keeps non-tracked initial lines (e.g. wildlife) and tolerates missing fields", () => {
    const s = sumMonthlyDone([doc(), { month: "x" } as any], 2);
    assert.equal(s.initialsByLine.wildlife, 1);
    assert.equal(s.newCustomers, 6);
    assert.equal(sumMonthlyDone([], 0).monthsAvailable, 0);
  });
});

describe("technician + stop-kind helpers", () => {
  const techs = [{ id: "t1", name: "Kalin Jasso", employeeId: "10176" }, { id: "t2", name: "Hayden" }];
  it("matches a route on any of a technician's identifiers, case-insensitively", () => {
    const keys = buildTechKeys(["t1"], techs);
    assert.ok(routeMatchesTech({ techId: "t1" } as any, keys));
    assert.ok(routeMatchesTech({ techName: "KALIN JASSO" } as any, keys));
    assert.ok(!routeMatchesTech({ techId: "t2" } as any, keys));
    assert.ok(routeMatchesTech({ techId: "anything" } as any, new Set())); // no selection = everyone
  });
  it("treats an unknown kind as regular", () => {
    assert.equal(stopKindOf("INITIAL"), "initial");
    assert.equal(stopKindOf("reservice"), "reservice");
    assert.equal(stopKindOf(undefined), "regular");
    assert.equal(stopKindOf("weird"), "regular");
  });
});

describe("makeRouteFilter", () => {
  const jobs = [J({ docId: "sub_1", serviceType: "General Pest" }), J({ docId: "sub_2", serviceType: "Mosquito" })];
  const jobsByDocId = buildJobsByDocId(jobs);
  const route = R({
    date: "2026-09-16", techId: "t1", techName: "Kalin", routeGroupTitle: "gpc", routeTemplateTitle: "Regular", totalStops: 3, completedStops: 2,
    routeValue: 30, totalDriveTimeMinutes: 30, totalServiceMinutes: 75, stopSequence: ["sub_1", "sub_2", "appt_9"],
    stops: [stop("sub_1", true), stop("sub_2", true), stop("appt_9", false, "reservice", { serviceType: "Reservice", value: 0 })],
  });
  const filter = (over: any = {}) =>
    makeRouteFilter({ filterGroups: [], filterTemplates: [], filterSubTypes: [], filterStopKinds: [], techKeys: new Set(), jobsByDocId, ...over });

  it("drops phantom routes and passes real ones through untouched with no filters", () => {
    const out = filter()([route, R({ date: "2026-09-16", techId: "t9", totalStops: 0 })]);
    assert.equal(out.length, 1);
    assert.equal(out[0], route);
  });
  it("includes or excludes WHOLE routes by group and template (spelling-insensitive group)", () => {
    assert.equal(filter({ filterGroups: ["GPC"] })([route]).length, 1);
    assert.equal(filter({ filterGroups: ["Specialty"] })([route]).length, 0);
    assert.equal(filter({ filterTemplates: ["Rain Day"] })([route]).length, 0);
  });
  it("rewrites a route to its matching stops for a subscription-type filter", () => {
    const [r] = filter({ filterSubTypes: ["General Pest"] })([route]);
    assert.deepEqual([r.totalStops, r.completedStops, r.routeValue, r.stopSequence], [1, 1, 10, ["sub_1"]]);
    assert.equal(r.totalDriveTimeMinutes, 30); // a drive isn't attributable to one stop
    assert.equal(r.totalWorkMinutes, 30 + 25); // whole-route drive + filtered service time
  });
  it("filters by stop type using the stop's own kind, and composes with subscription type", () => {
    const [re] = filter({ filterStopKinds: ["reservice"] })([route]);
    assert.deepEqual([re.totalStops, re.completedStops], [1, 0]);
    assert.equal(filter({ filterSubTypes: ["General Pest"], filterStopKinds: ["reservice"] })([route]).length, 0);
    assert.equal(filter({ filterStopKinds: ["initial"] })([route]).length, 0);
  });
  it("falls back to the job's stamped kind when a stop has no detail kind", () => {
    const j = buildJobsByDocId([J({ docId: "sub_5", fieldRoutesStopKind: "initial", serviceType: "General Pest" })]);
    const r = R({ date: "2026-09-16", techId: "t1", totalStops: 1, stopSequence: ["sub_5"], stops: [] });
    assert.equal(makeRouteFilter({ filterGroups: [], filterTemplates: [], filterSubTypes: [], filterStopKinds: ["initial"], techKeys: new Set(), jobsByDocId: j })([r]).length, 1);
  });
  it("never mutates its input", () => {
    const before = JSON.stringify(route);
    filter({ filterSubTypes: ["General Pest"] })([route]);
    assert.equal(JSON.stringify(route), before);
  });
});

describe("selectScopedRoutes", () => {
  const rs = ["2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21"].map((date) => R({ date, totalStops: 1 }));
  const all = (x: any) => x;
  const base = { rawRoutes: [R({ date: "2026-09-16", totalStops: 1 }), R({ date: "2026-09-17", totalStops: 1 })], filterRoutes: all, today: "2026-09-16" };
  it("defaults to today's routes", () => {
    assert.deepEqual(selectScopedRoutes({ ...base, dateFilterEnabled: false, excludeWeekends: false, rangeRoutes: null }).map((r) => r.date), ["2026-09-16"]);
  });
  it("uses the range when enabled, and can drop Saturday/Sunday", () => {
    assert.equal(selectScopedRoutes({ ...base, dateFilterEnabled: true, excludeWeekends: false, rangeRoutes: rs }).length, 4);
    assert.deepEqual(selectScopedRoutes({ ...base, dateFilterEnabled: true, excludeWeekends: true, rangeRoutes: rs }).map((r) => r.date), ["2026-09-18", "2026-09-21"]);
  });
});

describe("buildDrillData", () => {
  const jobs = buildJobsByDocId([J({ docId: "sub_1", customerId: "c1", customerName: "Ann", serviceType: "General Pest", address: "1 A St", subscriptionLastCompletedDate: "2026-09-16" })]);
  const today = "2026-09-16";
  it("derives each stop's status by the dashboard's rules", () => {
    const d = buildDrillData({
      jobsByDocId: jobs, today,
      scopedRoutes: [
        R({ date: "2026-09-17", techName: "K", totalStops: 1, stopSequence: ["sub_1"] }), // future
        R({ date: today, techName: "K", totalStops: 2, completedStops: 1, stopSequence: ["sub_1", "appt_2"], stops: [stop("sub_1", true), stop("appt_2", false)] }),
        R({ date: today, techName: "L", totalStops: 1, stopSequence: ["sub_1"], stops: [] }), // predates the stops array → job fallback
        R({ date: "2026-09-10", techName: "K", totalStops: 1, stopSequence: ["sub_1"], stops: [] }), // old + no detail
      ],
    });
    // Routes sort by date: 09-10 (old, no detail) → 09-16 K (stamped) → 09-16 L (job fallback) → 09-17 (future).
    assert.deepEqual(d.stopRows.map((s) => s.status), ["unknown", "completed", "pending", "completed", "scheduled"]);
    assert.equal(d.hasUnknown, true);
    assert.equal(d.completedRows.length, 2);
    assert.equal(d.remainingRows.length, 2); // the pending stop and the scheduled one
  });
  it("orders routes by date then technician, and joins job facts onto stops", () => {
    const d = buildDrillData({ jobsByDocId: jobs, today, scopedRoutes: [R({ date: today, techName: "Z", totalStops: 1 }), R({ date: "2026-09-01", techName: "B", totalStops: 1 }), R({ date: today, techName: "A", totalStops: 1 })] });
    assert.deepEqual(d.routeRows.map((r) => `${r.date}/${r.techName}`), ["2026-09-01/B", `${today}/A`, `${today}/Z`]);
    const one = (stops: any[]) =>
      buildDrillData({ jobsByDocId: jobs, today, scopedRoutes: [R({ date: today, techName: "K", totalStops: 1, stopSequence: ["sub_1"], stops })] }).stopRows[0];
    // Job facts are joined on; the stop's own recorded name wins over the job's, which is the fallback.
    const withDetail = one([stop("sub_1", true, "regular", { customerName: "Ann (route sheet)" })]);
    assert.deepEqual([withDetail.customerId, withDetail.customerName, withDetail.serviceType, withDetail.address], ["c1", "Ann (route sheet)", "General Pest", "1 A St"]);
    assert.equal(one([]).customerName, "Ann");
  });
  it("computes stops/hour from work minutes, else drive + service, else null", () => {
    const row = (o: any) => buildDrillData({ jobsByDocId: jobs, today, scopedRoutes: [R({ date: today, techName: "K", totalStops: 6, ...o })] }).routeRows[0];
    assert.equal(row({ totalWorkMinutes: 180 }).stopsPerHour, 2);
    assert.equal(row({ totalDriveTimeMinutes: 60, totalServiceMinutes: 120 }).stopsPerHour, 2);
    assert.equal(row({}).stopsPerHour, null);
    assert.equal(row({ driveTimeSource: "routes_api_matrix" }).driveEstimated, false);
    assert.equal(row({ driveTimeSource: "haversine_fallback" }).driveEstimated, true);
  });
});

describe("buildOverdueDrill", () => {
  const today = "2026-09-16";
  const jobs = [
    J({ docId: "a", customerId: "c1", customerName: "Counted", scheduledDate: "2026-08-20", overdueActionable: true, subscriptionBalance: "0" }),
    J({ docId: "b", customerId: "c1", customerName: "Counted 2", scheduledDate: "2026-08-21", overdueActionable: true }), // same customer
    J({ docId: "c", customerId: "c2", customerName: "Owes", scheduledDate: "2026-08-01", subscriptionBalance: "500" }),
    J({ docId: "d", customerId: "c3", customerName: "Inside window", scheduledDate: "2026-09-10" }), // 6 days late, 90-day sub: pending, not overdue
    J({ docId: "e", customerId: "c4", customerName: "Future", scheduledDate: "2026-10-01" }),
    J({ docId: "f", customerId: "c5", customerName: "Stale flag", scheduledDate: "2026-08-01" }), // nothing explains it
    J({ docId: "g", customerId: "c6", customerName: "Ancient", scheduledDate: "2024-01-01" }),
    J({ docId: "h", customerId: "c7", customerName: "Prospect", scheduledDate: "2026-08-01", potentialCustomer: true }),
  ];
  const o = buildOverdueDrill({ rawJobs: jobs, today });
  it("counts exactly the stamped flag, and counts customers not subscriptions", () => {
    assert.deepEqual(o.counted.map((r) => r.docId).sort(), ["a", "b"]);
    assert.equal(o.customerCount, 1);
  });
  it("explains each exclusion, and skips rows that are not actually past due", () => {
    const why = Object.fromEntries(o.excluded.map((r) => [r.customerName, r.reasons.join("|")]));
    assert.match(why["Owes"], /balance \$500\.00/);
    assert.match(why["Stale flag"], /flag not refreshed/);
    assert.match(why["Ancient"], /stale — due \d+ days ago/);
    assert.match(why["Prospect"], /prospect/);
    assert.ok(!("Inside window" in why) && !("Future" in why));
  });
  it("orders most overdue first and totals the balances over the gate", () => {
    assert.ok(o.excluded.every((r, i, a) => i === 0 || a[i - 1].daysOverdue >= r.daysOverdue));
    assert.equal(o.excludedBalanceTotal, 500);
  });
});

describe("computeDashboardStats", () => {
  const today = "2026-09-16";
  const bounds = computeDashboardBounds(today);
  const jobs = [
    J({ docId: "sub_1", customerId: "c1", subscriptionLastCompletedDate: today, scheduledDate: "2026-12-01" }),
    J({ docId: "sub_2", customerId: "c2", scheduledDate: "2026-09-18", alreadyScheduled: true, fieldRoutesScheduledDate: "2026-09-18", overdueActionable: true }),
  ];
  const run = (rawRoutes: any[], extra: any = {}) => {
    const jobsByDocId = buildJobsByDocId(jobs);
    const filterRoutes = makeRouteFilter({ filterGroups: [], filterTemplates: [], filterSubTypes: [], filterStopKinds: [], techKeys: new Set(), jobsByDocId });
    const scopedRoutes = selectScopedRoutes({ dateFilterEnabled: false, excludeWeekends: false, rangeRoutes: null, rawRoutes, filterRoutes, today });
    return computeDashboardStats({
      rawRoutes, rawJobs: jobs, rangeRoutes: null, dateFilterEnabled: false, excludeWeekends: false, filterRoutes,
      filterGroups: [], filterTemplates: [], filterSubTypes: [], filterStopKinds: [], techKeys: new Set(), bounds, today, scopedRoutes, jobsByDocId, ...extra,
    });
  };
  const routes = [
    R({ date: today, techName: "K", totalStops: 4, completedStops: 3, totalDriveTimeMinutes: 40, routeValue: 100, totalWorkMinutes: 120, stopSequence: ["sub_1"], stops: [] }),
    R({ date: "2026-09-18", techName: "K", totalStops: 5, totalDriveTimeMinutes: 20, routeValue: 50, totalWorkMinutes: 100 }),
  ];
  it("counts today's cards, treating completedStops as the truth", () => {
    const s = run(routes);
    assert.deepEqual([s.todayRoutes, s.totalStops, s.completedToday, s.stopsLeftToday, s.estimatedDriveTime, s.totalRouteValue], [1, 4, 3, 1, 40, 100]);
    assert.equal(s.todayStopsPerHour, 2); // 4 stops / 2h
  });
  it("counts week remaining as future days whole plus today's booked-minus-done", () => {
    const s = run(routes);
    assert.equal(s.weekStopsBooked, 9);
    assert.equal(s.stopsLeftWeek, 1 + 5);
    assert.equal(s.weekKpis.routeCount, 2);
    assert.equal(s.weekKpis.stopsPerRoute, 4.5);
  });
  it("falls back to job completion dates when a route predates completedStops", () => {
    const s = run([R({ date: today, techName: "K", totalStops: 1, stopSequence: ["sub_1"], stops: [] })]);
    assert.equal(s.completedToday, 1); // sub_1 completed today
  });
  it("counts distinct overdue customers and the next 7 days of due jobs", () => {
    const s = run(routes);
    assert.equal(s.overdueStops, 1);
    assert.equal(s.jobsDueThisWeek.length, 7);
    assert.equal(s.jobsDueThisWeek[2].count, 0); // sub_2 is due 09-18 but has no pending/scheduled status set here
  });
  it("builds an 8-week trend ending with the current week, and per-line targets with a total", () => {
    const s = run(routes);
    assert.equal(s.trend.length, 8);
    assert.equal(s.trend[7].routeCount, 2);
    assert.equal(s.lineTargets[s.lineTargets.length - 1].line, "total");
    assert.equal(s.lineTargets.length, 6);
  });
});
