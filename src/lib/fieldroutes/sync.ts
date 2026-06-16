// FieldRoutes → Firestore sync.
//
// Swaps the CSV ingestion for a live API pull. Produces one job document per
// in-scope subscription in companies/{companyId}/jobs, written in the SAME
// shape the existing router/UI already consume (see src/types Job). The routing
// algorithm is NOT touched — only the data source changes.
//
// Feeds (driven by status, so the existing router needs no changes):
//   auto_routable      -> status "pending"   (enters the routing pool)
//   already_scheduled  -> status "scheduled" (pinned FieldRoutes stop)
//   needs_review       -> status "review"    (constraint/over-balance; excluded)
//   everything else    -> status "inactive"  (future/out-of-scope; excluded)
//
// Resumable + time-boxed: a single serverless invocation processes subscriptions
// in batches until it approaches the function's time budget, then persists its
// progress (subscription ID list, offset, running tallies, and the lookup maps)
// under fieldRoutesState/sync.run. Re-invoking the same mode resumes where it
// left off — this keeps a full sync of thousands of subscriptions within the
// 60-second function cap of Vercel's Hobby plan. Callers repeat the request
// until the response reports `done: true`.

import { adminDb } from "@/lib/firebase-admin";
import { normalizeServiceType } from "@/lib/job-id";
import { FieldRoutesClient } from "./client";
import {
  billingFrequencyLabel,
  centralTodayISO,
  computeFlags,
  deriveCategory,
  isInScope,
  num,
  recurringFrequencyLabel,
  toDateOnly,
} from "./scope";

export type SyncMode = "full" | "incremental";

// Stop starting new batches once we cross this; leaves headroom under the
// 60s function cap for the final Firestore flush and the HTTP response.
const SOFT_DEADLINE_MS = 45_000;
// Subscriptions per batch. One subscription `get` + one customer `get` per
// batch (both <= 1000-entity cap), so a batch costs ~2 throttled requests.
const BATCH_SUBS = 250;

export interface SyncResult {
  mode: SyncMode;
  companyId: string;
  done: boolean;
  total: number;
  offset: number;
  subscriptionsProcessed: number;
  inScopeCount: number;
  autoRoutableCount: number;
  alreadyScheduledCount: number;
  needsReviewCount: number;
  written: number;
  apiReads: number;
  cursor: string;
  startedAt: string;
  finishedAt: string;
  message: string;
}

interface ApptInfo {
  date: string;
  techId: string;
  techName: string;
}

interface RunProgress {
  active: boolean;
  mode: SyncMode;
  ids: string[];
  offset: number;
  cursor: string;
  apptMap: Record<string, ApptInfo>;
  empNames: Record<string, string>;
  counts: {
    inScope: number;
    autoRoutable: number;
    alreadyScheduled: number;
    needsReview: number;
    written: number;
    subsProcessed: number;
  };
}

function rec(value: unknown): Record<string, unknown> {
  return (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
}

function str(value: unknown): string {
  return String(value ?? "").trim();
}

function maxDateString(a: string, b: string): string {
  return b > a ? b : a;
}

function targetCompanyId(): string {
  const id = (process.env.FIELDROUTES_COMPANY_ID || "").trim();
  if (!id) throw new Error("FIELDROUTES_COMPANY_ID is required to know which company to populate.");
  return id;
}

function employeeName(emp: Record<string, unknown>): string {
  const first = str(emp.fname || emp.firstName);
  const last = str(emp.lname || emp.lastName);
  const full = `${first} ${last}`.trim();
  return full || str(emp.name) || str(emp.employeeID || emp.employeeId);
}

function normName(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const radiusMiles = 3958.7613;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return radiusMiles * 2 * Math.asin(Math.sqrt(h));
}

// Mirrors the routes page's estimateRouteMetrics so materialized FieldRoutes
// route docs carry the same drive/work estimates the UI shows for AI routes.
function haversineRouteMetrics(
  stops: Array<{ lat?: number; lng?: number; duration: number }>,
): Record<string, unknown> {
  let drive = 0;
  let service = 0;
  let prev: { lat?: number; lng?: number } | null = null;
  for (const s of stops) {
    service += Number(s.duration) || 25;
    if (
      prev &&
      typeof prev.lat === "number" &&
      typeof prev.lng === "number" &&
      typeof s.lat === "number" &&
      typeof s.lng === "number"
    ) {
      drive += (haversineMiles({ lat: prev.lat, lng: prev.lng }, { lat: s.lat, lng: s.lng }) / 30) * 60;
    }
    prev = s;
  }
  const roundedDrive = Math.round(drive);
  const roundedService = Math.round(service);
  return {
    totalDriveTimeMinutes: roundedDrive,
    totalServiceMinutes: roundedService,
    totalWorkMinutes: roundedDrive + roundedService,
    driveTimeSource: "haversine_fallback",
    polylineSource: "haversine_fallback",
    polylineStatus: "ESTIMATE_ONLY",
  };
}

/**
 * Ensure a technician record exists for every FieldRoutes employee that has
 * scheduled work, linked by FieldRoutes employee ID. This is the foundation
 * that lets the router and UI match a scheduled job to a tech — without it,
 * FieldRoutes routes are silently dropped (and could be double-booked).
 * Returns lookup maps so callers can resolve a job's tech to a technician doc id.
 */
async function syncTechnicians(
  db: FirebaseFirestore.Firestore,
  companyId: string,
  empNames: Record<string, string>,
  servingEmployeeIds: Set<string>,
  now: string,
): Promise<{ empToTech: Map<string, string>; nameToTech: Map<string, string> }> {
  const existingSnap = await db.collection(`companies/${companyId}/technicians`).get();
  const byEmpId = new Map<string, string>();
  const byName = new Map<string, string>();
  existingSnap.docs.forEach((d) => {
    const data = d.data();
    const empId = str(data.fieldRoutesEmployeeId || data.fieldRoutesTechId || data.employeeId);
    if (empId) byEmpId.set(empId, d.id);
    const nm = normName(data.name);
    if (nm) byName.set(nm, d.id);
  });

  const empToTech = new Map<string, string>();
  const nameToTech = new Map<string, string>(byName);

  let batch = db.batch();
  let ops = 0;
  for (const empId of servingEmployeeIds) {
    if (!empId || empId === "0") continue;
    const name = empNames[empId] || empId;
    const existingId = byEmpId.get(empId) || byName.get(normName(name));

    const linkFields = {
      companyId,
      name,
      employeeId: empId,
      fieldRoutesEmployeeId: empId,
      fieldRoutesTechId: empId,
      source: "fieldroutes",
      updatedAt: now,
    };

    let techId: string;
    if (existingId) {
      // Link an existing tech (don't touch active/maxStops the user may have set).
      techId = existingId;
      batch.set(db.doc(`companies/${companyId}/technicians/${techId}`), linkFields, { merge: true });
    } else {
      techId = `fr_${empId}`;
      batch.set(
        db.doc(`companies/${companyId}/technicians/${techId}`),
        { ...linkFields, active: true, maxStopsPerDay: 25, createdAt: now },
        { merge: true },
      );
    }
    empToTech.set(empId, techId);
    nameToTech.set(normName(name), techId);
    ops++;
    if (ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();

  return { empToTech, nameToTech };
}

/**
 * Materialize FieldRoutes-scheduled appointments as real, locked route docs so
 * they appear everywhere (dashboard counts, every map, routes page) and the
 * generator treats them as immovable. Derived entirely from current Firestore
 * job state (zero API cost), so it is always accurate regardless of sync mode.
 *
 * Existing non-FieldRoutes stops on a slot (e.g. AI-generated additions) are
 * preserved; stale FieldRoutes stops (appointment moved/cancelled) are removed.
 */
async function reconcileScheduledRoutes(
  db: FirebaseFirestore.Firestore,
  companyId: string,
  empNames: Record<string, string>,
  today: string,
  now: string,
): Promise<{ routesWritten: number; routesDeleted: number; techsLinked: number }> {
  interface SJob {
    id: string;
    date: string;
    techEmpId: string;
    techName: string;
    lat?: number;
    lng?: number;
    duration: number;
    scheduledDate: string;
    customerName: string;
  }

  const jobsSnap = await db.collection(`companies/${companyId}/jobs`).where("status", "==", "scheduled").get();
  const scheduled: SJob[] = [];
  const servingEmployeeIds = new Set<string>();
  jobsSnap.docs.forEach((doc) => {
    const d = doc.data();
    if (!d.fieldRoutesScheduled) return;
    const date = toDateOnly(d.fieldRoutesScheduledDate || d.scheduledDate);
    if (!date || date < today) return;
    const techEmpId = str(d.fieldRoutesServicedById);
    const techName = str(d.fieldRoutesServicedBy || d.assignedTechId);
    if (techEmpId) servingEmployeeIds.add(techEmpId);
    scheduled.push({
      id: doc.id,
      date,
      techEmpId,
      techName,
      lat: typeof d.lat === "number" ? d.lat : undefined,
      lng: typeof d.lng === "number" ? d.lng : undefined,
      duration: Number(d.duration) || 25,
      scheduledDate: str(d.scheduledDate),
      customerName: str(d.customerName),
    });
  });

  const { empToTech, nameToTech } = await syncTechnicians(db, companyId, empNames, servingEmployeeIds, now);
  const resolveTechId = (j: SJob) =>
    empToTech.get(j.techEmpId) || nameToTech.get(normName(j.techName)) || "";

  // Group scheduled jobs by (date :: techId).
  const groups = new Map<string, { date: string; techId: string; techName: string; jobs: SJob[] }>();
  for (const j of scheduled) {
    const techId = resolveTechId(j);
    if (!techId) continue;
    const key = `${j.date}::${techId}`;
    if (!groups.has(key)) {
      const techName = empNames[j.techEmpId] || j.techName || techId;
      groups.set(key, { date: j.date, techId, techName, jobs: [] });
    }
    groups.get(key)!.jobs.push(j);
  }

  // Load existing future routes to preserve generated stops and clean up stale ones.
  const routesSnap = await db.collection(`companies/${companyId}/routes`).where("date", ">=", today).get();
  const existingBySlot = new Map<string, { ref: FirebaseFirestore.DocumentReference; data: FirebaseFirestore.DocumentData }>();
  routesSnap.docs.forEach((rd) => {
    const r = rd.data();
    existingBySlot.set(`${str(r.date)}::${str(r.techId)}`, { ref: rd.ref, data: r });
  });

  let batch = db.batch();
  let ops = 0;
  let routesWritten = 0;
  let routesDeleted = 0;
  const commit = async () => {
    if (ops > 0) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  const handledSlots = new Set<string>();
  for (const [key, group] of groups) {
    handledSlots.add(key);
    const orderedJobs = group.jobs
      .slice()
      .sort(
        (a, b) =>
          a.scheduledDate.localeCompare(b.scheduledDate) ||
          a.customerName.localeCompare(b.customerName),
      );
    const frStopIds = orderedJobs.map((j) => j.id);
    const metrics = haversineRouteMetrics(orderedJobs);
    const existing = existingBySlot.get(key);

    if (existing) {
      const prevFr: string[] = Array.isArray(existing.data.fieldRoutesStopIds)
        ? existing.data.fieldRoutesStopIds.map(String)
        : [];
      const prevSeq: string[] = Array.isArray(existing.data.stopSequence)
        ? existing.data.stopSequence.map(String)
        : [];
      // Keep generated (non-FieldRoutes) stops; swap in the current FR stops.
      const preserved = prevSeq.filter((id) => !prevFr.includes(id) && !frStopIds.includes(id));
      const newSeq = [...frStopIds, ...preserved];
      const isPureFieldRoutes = preserved.length === 0;
      batch.set(
        existing.ref,
        {
          companyId,
          date: group.date,
          techId: group.techId,
          techName: group.techName,
          stopSequence: newSeq,
          totalStops: newSeq.length,
          fieldRoutesStopIds: frStopIds,
          hasFieldRoutesStops: true,
          ...metrics,
          // A pure-FieldRoutes slot is locked. A slot that also holds generated
          // stops keeps its existing approval so we don't surprise-lock an AI
          // route — its FieldRoutes stops are still protected by pinning.
          approved: isPureFieldRoutes ? true : existing.data.approved === true,
          ...(isPureFieldRoutes ? { locked: true } : {}),
          source: isPureFieldRoutes ? "fieldroutes" : "mixed",
          updatedAt: now,
        },
        { merge: true },
      );
    } else {
      batch.set(db.doc(`companies/${companyId}/routes/${group.date}-${group.techId}`), {
        companyId,
        date: group.date,
        techId: group.techId,
        techName: group.techName,
        stopSequence: frStopIds,
        totalStops: frStopIds.length,
        fieldRoutesStopIds: frStopIds,
        hasFieldRoutesStops: true,
        ...metrics,
        confidence: 1,
        approved: true,
        locked: true,
        source: "fieldroutes",
        generatedBy: "fieldroutes",
        createdAt: now,
        updatedAt: now,
      });
    }
    routesWritten++;
    ops++;
    if (ops >= 450) await commit();
  }

  // Clean up slots that previously held FieldRoutes stops but no longer do.
  for (const [key, existing] of existingBySlot) {
    if (handledSlots.has(key)) continue;
    const prevFr: string[] = Array.isArray(existing.data.fieldRoutesStopIds)
      ? existing.data.fieldRoutesStopIds.map(String)
      : [];
    if (prevFr.length === 0) continue; // not FieldRoutes-managed — leave it alone
    const prevSeq: string[] = Array.isArray(existing.data.stopSequence)
      ? existing.data.stopSequence.map(String)
      : [];
    const preserved = prevSeq.filter((id) => !prevFr.includes(id));
    if (preserved.length === 0) {
      batch.delete(existing.ref);
      routesDeleted++;
    } else {
      batch.set(
        existing.ref,
        {
          stopSequence: preserved,
          totalStops: preserved.length,
          fieldRoutesStopIds: [],
          hasFieldRoutesStops: false,
          source: existing.data.source === "mixed" ? "ai" : existing.data.source,
          updatedAt: now,
        },
        { merge: true },
      );
    }
    ops++;
    if (ops >= 450) await commit();
  }
  await commit();

  return { routesWritten, routesDeleted, techsLinked: empToTech.size };
}

/** Stable ascending order so the resume offset points at the same IDs across invocations. */
function sortIds(ids: string[]): string[] {
  return ids
    .map((s) => str(s))
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

/**
 * Resolve which subscription IDs to (re)sync.
 *  - full: every active subscription.
 *  - incremental: subscriptions changed since the cursor, plus subscriptions of
 *    changed customers and changed appointments.
 */
async function resolveSubscriptionIds(
  client: FieldRoutesClient,
  mode: SyncMode,
  cursor: string,
): Promise<string[]> {
  if (mode === "full" || !cursor) {
    // No cursor yet on an incremental run falls back to a full pull so we don't miss anything.
    return client.searchIds("subscription", { active: 1 });
  }

  const changedSubs = await client.searchIds("subscription", {
    dateUpdated: { operator: ">", value: cursor },
  });
  const changedCustomers = await client.searchIds("customer", {
    dateUpdated: { operator: ">", value: cursor },
  });
  const changedAppointments = await client.searchIds("appointment", {
    dateUpdated: { operator: ">", value: cursor },
  });

  // Resolving changed customers/appointments back to subscriptions is best-effort:
  // if a filter key is rejected we still process the directly-changed subscriptions
  // rather than failing the whole incremental run.
  let subsOfChangedCustomers: string[] = [];
  if (changedCustomers.length) {
    try {
      subsOfChangedCustomers = await client.searchIds("subscription", {
        customerID: { operator: "in", value: changedCustomers },
      });
    } catch (err) {
      console.warn("[fieldroutes/sync] customer→subscription resolve skipped:", String(err));
    }
  }

  let subsOfChangedAppointments: string[] = [];
  if (changedAppointments.length) {
    try {
      const appts = await client.getEntities("appointment", changedAppointments);
      subsOfChangedAppointments = appts.map((a) => str(rec(a).subscriptionID)).filter(Boolean);
    } catch (err) {
      console.warn("[fieldroutes/sync] appointment→subscription resolve skipped:", String(err));
    }
  }

  return Array.from(
    new Set([...changedSubs, ...subsOfChangedCustomers, ...subsOfChangedAppointments]),
  );
}

/**
 * Build the account-wide lookups a fresh run needs: the ordered subscription ID
 * list, the pending-appointment map (double-book join on subscription_id ONLY),
 * and the employee-name map. These are persisted with the run so resume
 * invocations skip the setup cost entirely.
 */
async function buildRunSetup(
  client: FieldRoutesClient,
  mode: SyncMode,
  cursor: string,
  today: string,
): Promise<{ ids: string[]; apptMap: Record<string, ApptInfo>; empNames: Record<string, string> }> {
  const ids = sortIds(await resolveSubscriptionIds(client, mode, cursor));

  // Employees are few — fetch all once for name resolution.
  const employeeIds = await client.searchIds("employee", {});
  const employees = employeeIds.length ? await client.getEntities("employee", employeeIds) : [];
  const empNames: Record<string, string> = {};
  for (const e of employees) {
    const er = rec(e);
    const id = str(er.employeeID || er.employeeId);
    if (id) empNames[id] = employeeName(er);
  }
  const resolveEmpName = (id: unknown): string => {
    const key = str(id);
    if (!key || key === "0") return "";
    return empNames[key] || key;
  };

  // Pending future appointments across the account, indexed by subscription_id.
  const pendingApptIds = await client.searchIds("appointment", {
    status: 0, // 0 = Pending
    date: { operator: ">=", value: today },
  });
  const pendingAppts = pendingApptIds.length
    ? await client.getEntities("appointment", pendingApptIds)
    : [];
  const apptMap: Record<string, ApptInfo> = {};
  for (const a of pendingAppts) {
    const ar = rec(a);
    const subId = str(ar.subscriptionID);
    if (!subId) continue;
    const date = toDateOnly(ar.date);
    if (!date || date < today) continue;
    const existing = apptMap[subId];
    // Keep the earliest upcoming appointment.
    if (!existing || date < existing.date) {
      apptMap[subId] = {
        date,
        techId: str(ar.employeeID), // VERIFIED: employeeID, not assignedTech
        techName: resolveEmpName(ar.employeeID),
      };
    }
  }

  return { ids, apptMap, empNames };
}

export async function runSync(mode: SyncMode): Promise<SyncResult> {
  const startMs = Date.now();
  const startedAt = new Date().toISOString();
  const companyId = targetCompanyId();
  const today = centralTodayISO();
  const client = new FieldRoutesClient();
  const db = adminDb();

  const stateRef = db.doc(`companies/${companyId}/fieldRoutesState/sync`);
  const stateSnap = await stateRef.get();
  const state = stateSnap.exists ? (stateSnap.data() as Record<string, unknown>) : {};
  const priorCursor = str(state.cursor);

  // Resume an in-progress run of the SAME mode; otherwise start a fresh run.
  const prior = state.run as RunProgress | undefined;
  const resuming = Boolean(prior?.active) && prior?.mode === mode && Array.isArray(prior?.ids);

  let ids: string[];
  let apptMap: Record<string, ApptInfo>;
  let empNames: Record<string, string>;
  let offset: number;
  let cursor: string;
  let inScopeCount: number;
  let autoRoutableCount: number;
  let alreadyScheduledCount: number;
  let needsReviewCount: number;
  let written: number;
  let subsProcessed: number;

  if (resuming && prior) {
    ids = prior.ids;
    apptMap = rec(prior.apptMap) as Record<string, ApptInfo>;
    empNames = rec(prior.empNames) as Record<string, string>;
    offset = num(prior.offset);
    cursor = str(prior.cursor) || priorCursor;
    inScopeCount = num(prior.counts?.inScope);
    autoRoutableCount = num(prior.counts?.autoRoutable);
    alreadyScheduledCount = num(prior.counts?.alreadyScheduled);
    needsReviewCount = num(prior.counts?.needsReview);
    written = num(prior.counts?.written);
    subsProcessed = num(prior.counts?.subsProcessed);
  } else {
    const setup = await buildRunSetup(client, mode, priorCursor, today);
    ids = setup.ids;
    apptMap = setup.apptMap;
    empNames = setup.empNames;
    offset = 0;
    cursor = priorCursor;
    inScopeCount = autoRoutableCount = alreadyScheduledCount = needsReviewCount = 0;
    written = subsProcessed = 0;
  }

  const total = ids.length;
  const resolveEmpName = (id: unknown): string => {
    const key = str(id);
    if (!key || key === "0") return "";
    return empNames[key] || key;
  };

  // --- Process subscriptions in batches until exhausted or near the time budget. ---
  const now = new Date().toISOString();
  let batch = db.batch();
  let ops = 0;
  const flush = async () => {
    if (ops > 0) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  while (offset < total) {
    if (Date.now() - startMs > SOFT_DEADLINE_MS) break;

    const sliceIds = ids.slice(offset, offset + BATCH_SUBS);
    const subscriptions = await client.getEntities("subscription", sliceIds);
    const customerIds = Array.from(
      new Set(subscriptions.map((s) => str(rec(s).customerID)).filter(Boolean)),
    );
    const customers = customerIds.length ? await client.getEntities("customer", customerIds) : [];
    const customerById = new Map(customers.map((c) => [str(rec(c).customerID), rec(c)]));

    for (const subRaw of subscriptions) {
      const sub = rec(subRaw);
      const subscriptionId = str(sub.subscriptionID);
      if (!subscriptionId) continue;
      const customerId = str(sub.customerID);
      const customer = customerById.get(customerId) || {};

      cursor = maxDateString(cursor, str(sub.dateUpdated));

      const serviceType = str(sub.serviceType);
      const serviceDue = toDateOnly(sub.nextService);
      const lastCompleted = toDateOnly(sub.lastCompleted);
      const customerBalance = num(customer.balance);
      const specialScheduling = str(customer.specialScheduling);
      const onHold = num(sub.onHold);

      const appt = apptMap[subscriptionId];
      const alreadyScheduled = Boolean(appt);
      const scheduledFor = appt ? appt.date : "";
      const scheduledTech = appt ? appt.techName : "";
      const scheduledTechId = appt ? appt.techId : "";

      const inScope = isInScope({ onHold, recurringCharge: sub.recurringCharge });
      const flags = computeFlags({
        inScope,
        serviceDue,
        customerBalance,
        specialScheduling,
        alreadyScheduled,
        today,
      });

      const serviceDueAlreadyCompleted =
        Boolean(lastCompleted) && Boolean(serviceDue) && lastCompleted >= serviceDue;

      let status: string;
      if (serviceDueAlreadyCompleted) status = "completed";
      else if (alreadyScheduled) status = "scheduled";
      else if (flags.autoRoutable) status = "pending";
      else if (flags.needsReview) status = "review";
      else status = "inactive";

      if (inScope) inScopeCount++;
      if (flags.autoRoutable) autoRoutableCount++;
      if (alreadyScheduled) alreadyScheduledCount++;
      if (flags.needsReview) needsReviewCount++;

      const preferredTech = resolveEmpName(sub.preferredTech);
      const fname = str(customer.fname);
      const lname = str(customer.lname);
      const address = str(customer.address);
      const city = str(customer.city);
      const zip = str(customer.zip);
      const fullAddress = [address, city, zip].filter(Boolean).join(", ");

      const docRef = db.doc(`companies/${companyId}/jobs/sub_${subscriptionId}`);
      const jobData: Record<string, unknown> = {
        companyId,
        subscriptionId,
        customerId,
        customerName: `${fname} ${lname}`.trim() || customerId,
        firstName: fname,
        lastName: lname,
        address: fullAddress,
        addressRaw: address,
        city,
        zip,
        lat: typeof customer.lat === "number" ? customer.lat : num(customer.lat) || null,
        lng: typeof customer.lng === "number" ? customer.lng : num(customer.lng) || null,
        scheduledDate: serviceDue,
        serviceType,
        serviceTypeNormalized: normalizeServiceType(serviceType),
        subscriptionCategory: deriveCategory(serviceType),
        category: deriveCategory(serviceType),
        duration: 25,
        status,
        // Routing-relevant assignment fields:
        assignedTechId: alreadyScheduled ? scheduledTech : "",
        fieldRoutesScheduled: alreadyScheduled,
        fieldRoutesScheduledDate: scheduledFor || serviceDue,
        fieldRoutesServicedBy: alreadyScheduled ? scheduledTech : "",
        fieldRoutesServicedById: alreadyScheduled ? scheduledTechId : "",
        fieldRoutesScheduleSource: alreadyScheduled ? "api_appointment" : "",
        schedulingRequest: specialScheduling,
        // Subscription / billing detail (labels match the FieldRoutes report):
        recurringFrequency: recurringFrequencyLabel(sub.frequency),
        billingFrequency: billingFrequencyLabel(sub.billingFrequency),
        recurringPrice: str(sub.recurringCharge),
        subscriptionStatus: str(sub.active),
        subscriptionBalance: String(customerBalance),
        subscriptionOnHold: String(onHold),
        subscriptionLastServiced: lastCompleted,
        subscriptionLastCompletedDate: lastCompleted,
        serviceDueAlreadyCompleted,
        preferredTech,
        // Computed flags (also stored as columns for review feeds / debugging):
        inScope,
        pastDue: flags.pastDue,
        balanceOk: flags.balanceOk,
        hasConstraint: flags.hasConstraint,
        alreadyScheduled,
        autoRoutable: flags.autoRoutable,
        needsReview: flags.needsReview,
        customerBalance,
        onHold: onHold === 1,
        scheduledFor,
        scheduledTech,
        subDateUpdated: str(sub.dateUpdated),
        source: "api",
        syncedAt: now,
        updatedAt: now,
      };

      batch.set(docRef, { ...jobData, createdAt: now }, { merge: true });
      written++;
      subsProcessed++;
      ops++;
      if (ops >= 450) await flush();
    }
    await flush();
    offset += sliceIds.length;
  }
  await flush();

  const done = offset >= total;
  const finishedAt = new Date().toISOString();

  if (done) {
    // Link technicians and materialize FieldRoutes-scheduled routes so they show
    // up everywhere and the generator schedules around them. Runs only when the
    // whole sync completes; derived from current Firestore state (no API cost).
    try {
      const reconciled = await reconcileScheduledRoutes(db, companyId, empNames, today, now);
      console.log(
        `[fieldroutes/sync] reconciled routes: ${reconciled.routesWritten} written, ` +
          `${reconciled.routesDeleted} removed, ${reconciled.techsLinked} techs linked`,
      );
    } catch (err) {
      console.error("[fieldroutes/sync] route reconciliation failed:", String(err));
    }

    // Advance the top-level cursor only when the whole run completes, so an
    // interrupted incremental run re-resolves the same change set next time.
    if (!cursor) cursor = now;
    await stateRef.set(
      {
        cursor,
        lastRunMode: mode,
        lastRunAt: finishedAt,
        lastRunWritten: written,
        lastInScopeCount: inScopeCount,
        run: { active: false },
        ...(mode === "full" ? { lastFullSyncAt: finishedAt } : { lastIncrementalAt: finishedAt }),
      },
      { merge: true },
    );
  } else {
    const progress: RunProgress = {
      active: true,
      mode,
      ids,
      offset,
      cursor,
      apptMap,
      empNames,
      counts: {
        inScope: inScopeCount,
        autoRoutable: autoRoutableCount,
        alreadyScheduled: alreadyScheduledCount,
        needsReview: needsReviewCount,
        written,
        subsProcessed,
      },
    };
    // Replace the whole run object (set without merge on the field) so stale keys don't linger.
    await stateRef.set({ run: progress, lastRunMode: mode, lastRunAt: finishedAt }, { merge: true });
  }

  const message = done
    ? `Sync complete: processed ${subsProcessed} of ${total} subscriptions.`
    : `Partial sync: ${offset} of ${total} subscriptions processed. Call the same URL again to continue.`;

  return {
    mode,
    companyId,
    done,
    total,
    offset,
    subscriptionsProcessed: subsProcessed,
    inScopeCount,
    autoRoutableCount,
    alreadyScheduledCount,
    needsReviewCount,
    written,
    apiReads: client.readCount,
    cursor,
    startedAt,
    finishedAt,
    message,
  };
}

/**
 * Daily past_due / auto_routable recompute (Central time). past_due flips with the
 * passage of time, not a record edit — so recompute it independently of the sync.
 * Pure Firestore reads/writes, zero API cost.
 */
export async function recomputePastDue(): Promise<{ companyId: string; scanned: number; updated: number }> {
  const companyId = targetCompanyId();
  const today = centralTodayISO();
  const db = adminDb();

  const snap = await db.collection(`companies/${companyId}/jobs`).where("source", "==", "api").get();
  const now = new Date().toISOString();
  let batch = db.batch();
  let ops = 0;
  let updated = 0;

  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.serviceDueAlreadyCompleted) continue;
    const serviceDue = str(d.scheduledDate);
    const inScope = Boolean(d.inScope);
    const balanceOk = Boolean(d.balanceOk);
    const hasConstraint = Boolean(d.hasConstraint);
    const alreadyScheduled = Boolean(d.alreadyScheduled);

    const pastDue = Boolean(serviceDue) && serviceDue < today;
    const autoRoutable = inScope && pastDue && balanceOk && !hasConstraint && !alreadyScheduled;
    const needsReview = inScope && pastDue && !alreadyScheduled && (hasConstraint || !balanceOk);

    let status: string;
    if (alreadyScheduled) status = "scheduled";
    else if (autoRoutable) status = "pending";
    else if (needsReview) status = "review";
    else status = "inactive";

    if (
      pastDue !== Boolean(d.pastDue) ||
      autoRoutable !== Boolean(d.autoRoutable) ||
      needsReview !== Boolean(d.needsReview) ||
      status !== str(d.status)
    ) {
      batch.update(doc.ref, { pastDue, autoRoutable, needsReview, status, updatedAt: now });
      updated++;
      ops++;
      if (ops >= 450) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
  }
  if (ops > 0) await batch.commit();

  return { companyId, scanned: snap.size, updated };
}
