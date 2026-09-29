// Output shaping. Every record that leaves the server passes through one of these
// whitelists — nothing is ever spread out of a database document. That is what keeps
// credentials, employee home coordinates and internal blobs from leaking if a document
// grows a new field: the field simply isn't in the list.

import { calculateStopProductionValue } from "@/lib/production-value";
import type { JobRec, RouteRec } from "@/lib/dashboard";
import type { TechRecord } from "./data-source.ts";

type Rec = Record<string, unknown>;
const s = (v: unknown): string => (v === undefined || v === null ? "" : String(v).trim());
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const opt = (v: unknown): string | null => s(v) || null;

export type JobDetail = "summary" | "full";

export function jobBalance(j: JobRec): number {
  return n((j as Rec).subscriptionBalance);
}

/** Read a job field the typed JobRec doesn't declare. */
export const jobField = (j: JobRec, key: string): unknown => (j as Rec)[key];

export function publicJob(j: JobRec, detail: JobDetail = "summary"): Rec {
  const x = j as Rec;
  const base: Rec = {
    id: opt(j.docId),
    subscriptionId: opt(j.subscriptionId),
    customerId: opt(j.customerId),
    customerName: opt(j.customerName),
    address: opt(j.address),
    serviceType: opt(j.serviceType),
    serviceLine: opt(j.serviceLine),
    status: opt(j.status),
    frequency: opt(j.recurringFrequency),
    nextDue: opt(j.scheduledDate),
    lastCompleted: opt(j.subscriptionLastCompletedDate),
    balance: jobBalance(j),
    booked: j.alreadyScheduled === true,
    bookedDate: opt(j.fieldRoutesScheduledDate),
    bookedTech: opt(j.scheduledTech),
    routeGroup: opt(j.fieldRoutesRouteGroup),
    preferredTech: opt(x.preferredTech),
    countedAsOverdue: j.overdueActionable === true,
    schedulingNote: opt(j.schedulingRequest),
  };
  if (detail === "summary") return base;
  return {
    ...base,
    city: opt(x.city),
    zip: opt(x.zip),
    recurringPrice: opt(j.recurringPrice),
    billingFrequency: opt(j.billingFrequency),
    productionValue: calculateStopProductionValue(j).value || 0,
    serviceMinutes: n(j.duration) || null,
    seasonal: { isSeasonal: j.isSeasonal === true, startMonth: j.seasonalStartMonth ?? null, endMonth: j.seasonalEndMonth ?? null },
    flags: {
      inScope: j.inScope !== false,
      pendingCancel: j.pendingCancel === true,
      prospect: j.potentialCustomer === true,
      onHold: x.onHold === true,
      pastDue: x.pastDue === true,
      dueSoon: x.dueSoon === true,
      autoRoutable: x.autoRoutable === true,
      needsReview: x.needsReview === true,
      hasConstraint: x.hasConstraint === true,
      balanceOk: x.balanceOk === true,
      alreadyCompletedThisCycle: x.serviceDueAlreadyCompleted === true,
    },
    deadline: {
      intervalDays: n(x.serviceIntervalDays) || null,
      deadline: opt(x.serviceDeadline),
      daysUntil: x.daysUntilDeadline === undefined ? null : n(x.daysUntilDeadline),
      pastDeadline: x.pastDeadline === true,
    },
    booking: {
      routeId: opt(x.fieldRoutesRouteId),
      routeTemplate: opt(j.fieldRoutesRouteTemplate),
      stopKind: opt(j.fieldRoutesStopKind),
    },
    requiredSkills: Array.isArray(x.requiredSkills) ? x.requiredSkills.map(s) : [],
    syncedAt: opt(x.syncedAt),
  };
}

export function publicRoute(r: RouteRec): Rec {
  const x = r as unknown as Rec;
  const source = s(r.driveTimeSource);
  return {
    date: r.date,
    techId: opt(r.techId),
    techName: opt(r.techName),
    routeGroup: opt(r.routeGroupTitle),
    template: opt(r.routeTemplateTitle),
    totalStops: n(r.totalStops),
    completedStops: typeof r.completedStops === "number" ? r.completedStops : null,
    driveMinutes: n(r.totalDriveTimeMinutes),
    // "routes_api_matrix" is a real road time; anything else is a straight-line estimate.
    driveTimeIsEstimate: source !== "routes_api_matrix",
    driveTimeSource: opt(source),
    serviceMinutes: n(r.totalServiceMinutes),
    workMinutes: n(r.totalWorkMinutes),
    routeValue: n(r.routeValue),
    source: opt(x.source),
    approved: x.approved === true,
    locked: x.locked === true,
    updatedAt: opt(x.updatedAt),
  };
}

export function publicTech(t: TechRecord): Rec {
  return {
    id: t.id,
    name: t.name,
    employeeId: t.fieldRoutesEmployeeId || t.employeeId || null,
    skills: t.skillNames,
  };
}

/** A cached monthly aggregate, whitelisted. */
export function publicMonthlyDone(d: import("@/lib/fieldroutes/monthly-done").MonthlyDone): Rec {
  return {
    month: d.month,
    monthStart: d.monthStart,
    monthEnd: d.monthEnd,
    computedAt: d.computedAt,
    completedAppointments: d.completedAppointments,
    recurringDone: { total: d.recurringDoneTotal, byLine: d.recurringDoneByLine },
    initials: { total: d.initialsTotal, byLine: d.initialsByLine },
    reservices: d.reserviceDone,
    followUps: d.followupDone,
    specialty: d.specialtyDone,
    germanRoachWithinSpecialty: d.grDone,
    wildlife: d.wildlifeDone,
    newCustomers: d.newCustomers,
    newSubscriptions: d.newSubscriptions,
    // Completed work whose service type names no line — counted in NO line on purpose.
    unclassified: d.unclassified ?? 0,
    unclassifiedTypes: d.unclassifiedTypes ?? {},
  };
}
