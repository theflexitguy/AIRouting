// Deterministic fixture for the MCP tests. "Today" is Wednesday 2026-09-16 (week
// Mon 09-14 … Sun 09-20). Every number the tests assert on can be derived by hand from this file.

import type { JobRec, RouteRec } from "@/lib/dashboard";
import type { MonthlyDone } from "@/lib/fieldroutes/monthly-done";
import { MemoryDataSource, type MemoryFixture } from "./memory-source.ts";
import type { McpContext, TechRecord } from "./data-source.ts";

export const TODAY = "2026-09-16";
export const NOW = new Date("2026-09-16T15:00:00.000Z"); // 10:00 Central

/** Fields that must NEVER appear in any tool output (they exist here to prove they don't). */
export const FORBIDDEN = ["SECRET-KEY-DO-NOT-LEAK", "555-0100", "leak@example.com", "36.31234", "startLat"];

export const techs: TechRecord[] = [
  { id: "t_kalin", name: "Kalin Jasso", employeeId: "10176", fieldRoutesEmployeeId: "10176", skillNames: ["GPC", "Initials"] },
  { id: "t_hayden", name: "Hayden Allen", employeeId: "10217", fieldRoutesEmployeeId: "10217", skillNames: ["GPC"] },
  { id: "t_zach", name: "Zach DeRoush", employeeId: "10198", fieldRoutesEmployeeId: "10198", skillNames: ["Termite", "Initials"] },
];

let seq = 100;
export function job(o: Record<string, unknown> = {}): JobRec {
  const n = ++seq;
  return {
    docId: `sub_${n}`,
    subscriptionId: String(n),
    customerId: `c${n}`,
    customerName: `Customer ${n}`,
    address: `${n} Main St, Bentonville, 72712`,
    serviceType: "General Pest",
    serviceLine: "general",
    status: "pending",
    inScope: true,
    frequency: 90,
    recurringFrequency: "Every 90 Days",
    scheduledDate: "2026-10-20",
    subscriptionLastCompletedDate: "2026-07-20",
    subscriptionBalance: "0",
    alreadyScheduled: false,
    overdueActionable: false,
    pendingCancel: false,
    potentialCustomer: false,
    duration: 25,
    recurringPrice: "120",
    preferredTech: "Kalin Jasso",
    // Private / internal fields that a careless pass-through would leak:
    lat: 36.31234,
    phone: "555-0100",
    email: "leak@example.com",
    fieldRoutesApiKey: "SECRET-KEY-DO-NOT-LEAK",
    ...o,
  } as JobRec;
}

export const jobs: JobRec[] = [
  job({ docId: "sub_101", subscriptionId: "101", customerId: "c101", customerName: "Ada Booked", scheduledDate: "2026-09-17", alreadyScheduled: true, fieldRoutesScheduledDate: "2026-09-17", status: "scheduled", scheduledTech: "Kalin Jasso", fieldRoutesRouteGroup: "GPC" }),
  job({ docId: "sub_102", subscriptionId: "102", customerId: "c102", customerName: "Ben Monthly", frequency: 30, recurringFrequency: "Every 30 Days", scheduledDate: "2026-10-03", subscriptionLastCompletedDate: "2026-09-03", status: "completed" }),
  job({ docId: "sub_103", subscriptionId: "103", customerId: "c103", customerName: "Cy Overdue", scheduledDate: "2026-08-20", overdueActionable: true, preferredTech: "Hayden Allen" }),
  job({ docId: "sub_104", subscriptionId: "104", customerId: "c104", customerName: "Di Balance", scheduledDate: "2026-08-01", subscriptionBalance: "650", preferredTech: "Hayden Allen" }),
  job({ docId: "sub_105", subscriptionId: "105", customerId: "c105", customerName: "Ed AlreadyBooked", scheduledDate: "2026-08-25", alreadyScheduled: true, fieldRoutesScheduledDate: "2026-09-17", status: "scheduled", scheduledTech: "Hayden Allen" }),
  job({ docId: "sub_106", subscriptionId: "106", customerId: "c106", customerName: "Flo Mosquito", serviceType: "Mosquito Fogging", serviceLine: "mosquito", frequency: 30, recurringFrequency: "Every 30 Days", scheduledDate: "2026-09-25", subscriptionLastCompletedDate: "2026-08-28", isSeasonal: true, seasonalStartMonth: 4, seasonalEndMonth: 9 }),
  job({ docId: "sub_107", subscriptionId: "107", customerId: "c107", customerName: "Gus Termite", serviceType: "Termite Bait Stations", serviceLine: "termite", frequency: 365, recurringFrequency: "Every 365 Days", scheduledDate: "2026-09-22", subscriptionLastCompletedDate: "2025-09-22", preferredTech: "Zach DeRoush" }),
  job({ docId: "sub_108", subscriptionId: "108", customerId: "c108", customerName: "Hal Commercial", serviceType: "Commercial", serviceLine: "commercial", scheduledDate: "2026-09-30", subscriptionLastCompletedDate: "2026-06-30" }),
  job({ docId: "sub_109", subscriptionId: "109", customerId: "c109", customerName: "Ivy Lawn5", serviceType: "Round 5 - Fertilizer & Weed Control", serviceLine: "lawn", frequency: 365, recurringFrequency: "Every 365 Days", scheduledDate: "2026-09-05", subscriptionLastCompletedDate: "2026-09-05", seasonalStartMonth: 8, seasonalEndMonth: 9 }),
  job({ docId: "sub_110", subscriptionId: "110", customerId: "c110", customerName: "Jo Lawn6", serviceType: "Round 6 - Root Strength & Weed Control", serviceLine: "lawn", frequency: 365, recurringFrequency: "Every 365 Days", scheduledDate: "2026-09-20", subscriptionLastCompletedDate: "2025-09-20", seasonalStartMonth: 9, seasonalEndMonth: 10 }),
  job({ docId: "sub_111", subscriptionId: "111", customerId: "c111", customerName: "Kim PendingCancel", scheduledDate: "2026-08-15", pendingCancel: true }),
  job({ docId: "sub_112", subscriptionId: "112", customerId: "c112", customerName: "Lu Note", scheduledDate: "2026-08-10", schedulingRequest: "call first" }),
  // Stops on today's routes need job docs so names/addresses/types resolve:
  ...[201, 202, 203, 204, 205, 206, 207, 208, 209, 210].map((n) =>
    job({ docId: `sub_${n}`, subscriptionId: String(n), customerId: `c${n}`, customerName: `Stop ${n}`, address: `${n} Main St, Bentonville, 72712`, scheduledDate: "2026-12-01", subscriptionLastCompletedDate: "2026-06-01", status: "pending" }),
  ),
];

const stop = (id: string, name: string, completed: boolean, extra: Record<string, unknown> = {}) => ({ id, customerName: name, value: 40, completed, kind: "regular", serviceType: "General Pest", ...extra });

export const routes: RouteRec[] = [
  // Monday: Kalin, 5 stops, all done
  {
    date: "2026-09-14", techId: "t_kalin", techName: "Kalin Jasso", routeGroupTitle: "GPC", routeTemplateTitle: "Regular",
    totalStops: 5, completedStops: 5, totalDriveTimeMinutes: 40, totalServiceMinutes: 125, totalWorkMinutes: 165, routeValue: 200, driveTimeSource: "routes_api_matrix",
    stopSequence: ["sub_201", "sub_202", "sub_203", "sub_204", "sub_205"],
    stops: ["201", "202", "203", "204", "205"].map((n) => stop(`sub_${n}`, `Stop ${n}`, true)),
  } as RouteRec,
  // Today: Kalin, 6 stops, 3 done; includes an initial and a stand-alone reservice (no job doc)
  {
    date: TODAY, techId: "t_kalin", techName: "Kalin Jasso", routeGroupTitle: "GPC", routeTemplateTitle: "Regular",
    totalStops: 6, completedStops: 3, totalDriveTimeMinutes: 50, totalServiceMinutes: 150, totalWorkMinutes: 200, routeValue: 240, driveTimeSource: "routes_api_matrix",
    stopSequence: ["sub_201", "sub_202", "sub_206", "sub_207", "sub_208", "appt_9001"],
    stops: [
      stop("sub_201", "Stop 201", true),
      stop("sub_202", "Stop 202", true, { kind: "initial", serviceType: "General Pest Initial" }),
      stop("sub_206", "Stop 206", true),
      stop("sub_207", "Stop 207", false),
      stop("sub_208", "Stop 208", false),
      stop("appt_9001", "Walk-in Reservice", false, { kind: "reservice", serviceType: "Reservice", value: 0 }),
    ],
  } as RouteRec,
  // Today: Hayden, 4 stops, 1 done, straight-line drive estimate, Specialty group
  {
    date: TODAY, techId: "t_hayden", techName: "Hayden Allen", routeGroupTitle: "Specialty", routeTemplateTitle: "Regular",
    totalStops: 4, completedStops: 1, totalDriveTimeMinutes: 30, totalServiceMinutes: 100, totalWorkMinutes: 130, routeValue: 160, driveTimeSource: "haversine_fallback",
    stopSequence: ["sub_209", "sub_210", "sub_203", "sub_204"],
    stops: [stop("sub_209", "Stop 209", true), stop("sub_210", "Stop 210", false), stop("sub_203", "Stop 203", false), stop("sub_204", "Stop 204", false)],
  } as RouteRec,
  // Tomorrow: Kalin, 3 stops (future — completion not applicable)
  {
    date: "2026-09-17", techId: "t_kalin", techName: "Kalin Jasso", routeGroupTitle: "GPC", routeTemplateTitle: "Rain Day",
    totalStops: 3, totalDriveTimeMinutes: 20, totalServiceMinutes: 75, totalWorkMinutes: 95, routeValue: 120, driveTimeSource: "routes_api_matrix",
    stopSequence: ["sub_101", "sub_105", "sub_106"],
    stops: [stop("sub_101", "Ada Booked", false), stop("sub_105", "Ed AlreadyBooked", false), stop("sub_106", "Flo Mosquito", false)],
  } as RouteRec,
  // A phantom (no stops) that must be ignored everywhere
  { date: TODAY, techId: "t_zach", techName: "Zach DeRoush", routeGroupTitle: "Specialty", totalStops: 0, stopSequence: [], stops: [] } as RouteRec,
];

const md = (month: string, o: Partial<MonthlyDone> = {}): MonthlyDone => ({
  version: 2, month, monthStart: `${month}-01`, monthEnd: `${month}-28`, today: `${month}-28`, computedAt: `${month}-28T12:00:00.000Z`,
  completedAppointments: 500,
  recurringDoneByLine: { general: 300, mosquito: 80, lawn: 20, termite: 5, commercial: 15 }, recurringDoneTotal: 420,
  initialsByLine: { general: 40, mosquito: 2, lawn: 0, termite: 1, commercial: 1 }, initialsTotal: 44,
  reserviceDone: 30, followupDone: 12, specialtyDone: 20, grDone: 2, wildlifeDone: 4, newCustomers: 60, newSubscriptions: 50,
  unclassified: 0, unclassifiedTypes: {},
  ...o,
});

export const monthlyDone: Record<string, MonthlyDone> = {
  "2026-07": md("2026-07"),
  "2026-08": md("2026-08", { unclassified: 3, unclassifiedTypes: { "Cancelation Fee": 2, "Technician Tip": 1 } }),
  "2026-09": md("2026-09", { monthEnd: "2026-09-30", today: TODAY, completedAppointments: 656 }),
};

export function fixture(over: Partial<MemoryFixture> = {}): MemoryFixture {
  return { companyId: "co_test", meta: { name: "Test Pest Co", routeGroups: ["GPC", "Specialty"], forecastMonthlyGrowthPct: 0 }, jobs, routes, techs, monthlyDone, liveMonthlyDone: monthlyDone["2026-09"], sync: { lastRunAt: "2026-09-16T09:05:00.000Z", lastRunMode: "incremental", runActive: false, finalizedThrough: "2026-09-14", lastInScopeCount: jobs.length, apiUsage: { date: TODAY, reads: 120, writes: 0 } }, ...over };
}

export function context(over: Partial<MemoryFixture> = {}): McpContext {
  return { data: new MemoryDataSource(fixture(over)), today: TODAY, now: () => NOW };
}
