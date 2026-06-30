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
import { calculateStopProductionValue } from "@/lib/production-value";
import { deriveServiceLine } from "@/lib/routing/service-line";
import { computeDeadlineFlags } from "@/lib/routing/intervals";
import { FieldRoutesClient, FieldRoutesBudgetError } from "./client";
import { loadBudget, recordApiUsage } from "./usage";
import {
  BALANCE_GATE,
  billingFrequencyLabel,
  centralTodayISO,
  computeFlags,
  deriveCategory,
  isInScope,
  isRecurringFrequency,
  num,
  recurringFrequencyLabel,
  toDateOnly,
} from "./scope";

/** Per-company routing config (balance gate + balance-age limit). */
interface RoutingConfig {
  balanceGate: number;
  balanceAgeGate: number;
}

/**
 * Load the configurable routing gates from the company doc. Falls back to the
 * module defaults (BALANCE_GATE; age unenforced) when unset or unreadable.
 */
async function loadRoutingConfig(
  db: FirebaseFirestore.Firestore,
  companyId: string,
): Promise<RoutingConfig> {
  try {
    const snap = await db.doc(`companies/${companyId}`).get();
    const d = (snap.exists ? snap.data() : {}) || {};
    const gate = num(d.routingBalanceGate);
    const ageGate = num(d.routingBalanceAgeDays);
    return {
      balanceGate: gate > 0 ? gate : BALANCE_GATE,
      balanceAgeGate: ageGate > 0 ? ageGate : 0,
    };
  } catch {
    return { balanceGate: BALANCE_GATE, balanceAgeGate: 0 };
  }
}

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
  // True when the run stopped (or never started) because the daily API cap was
  // reached. The run is paused, not failed — re-invoke after the cap resets or
  // after raising it in Settings.
  capped: boolean;
  apiCap: number;
  apiUsedToday: number;
}

interface ApptInfo {
  date: string;
  techId: string;
  techName: string;
  routeId: string;
  routeGroup: string; // FieldRoutes route.groupTitle (e.g. "GPC", "Specialty")
}

interface RunProgress {
  active: boolean;
  mode: SyncMode;
  ids: string[];
  offset: number;
  cursor: string;
  apptMap: Record<string, ApptInfo>;
  empNames: Record<string, string>;
  technicianEmpIds: string[];
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

// FieldRoutes classifies employees by `type`: 1 = Technician, 3 = Tech & Sales
// both run service routes; 0 = Office and 2 = Sales never do. Office/sales/CSR
// staff were polluting the technician list because FieldRoutes still records
// them as a route's `assignedTech` in some cases. We INCLUDE technician types
// (rather than exclude known office types) so any unexpected/custom type value
// defaults to "kept" — a real field tech is never silently dropped.
const FIELDROUTES_TECHNICIAN_TYPES = new Set([1, 3]);

function employeeType(emp: Record<string, unknown>): number | null {
  const raw = emp.type ?? emp.fkEmployeeType ?? emp.employeeType ?? emp.fkType;
  const t = Number(raw);
  return Number.isFinite(t) ? t : null;
}

function isTechnicianEmployee(emp: Record<string, unknown>): boolean {
  const t = employeeType(emp);
  return t !== null && FIELDROUTES_TECHNICIAN_TYPES.has(t);
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
  // Track docs THIS sync auto-created (id prefix `fr_`) so we can prune the ones
  // that no longer correspond to a real serving tech. An earlier bug attributed
  // appointments to the office/API account that created them, spawning phantom
  // "technicians" (office staff, the API service account). They have no real
  // meaning and must not clutter the tech list.
  const autoCreatedFrDocs = new Set<string>();
  existingSnap.docs.forEach((d) => {
    const data = d.data();
    const empId = str(data.fieldRoutesEmployeeId || data.fieldRoutesTechId || data.employeeId);
    if (empId) byEmpId.set(empId, d.id);
    const nm = normName(data.name);
    if (nm) byName.set(nm, d.id);
    if (d.id.startsWith("fr_")) autoCreatedFrDocs.add(d.id);
  });

  const empToTech = new Map<string, string>();
  const nameToTech = new Map<string, string>(byName);
  const keptFrDocs = new Set<string>();

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
    if (techId.startsWith("fr_")) keptFrDocs.add(techId);
    ops++;
    if (ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  // Prune phantom auto-created techs: any `fr_` doc we made before that isn't
  // backed by a real serving tech this run. We only touch `fr_`-prefixed docs
  // (which only this sync creates), so user-created or linked-existing techs are
  // never deleted.
  for (const frId of autoCreatedFrDocs) {
    if (keptFrDocs.has(frId)) continue;
    batch.delete(db.doc(`companies/${companyId}/technicians/${frId}`));
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
 * Refresh the scheduled-appointment fields on EXISTING job docs from the freshly
 * built apptMap, regardless of incremental scope.
 *
 * Why: an incremental sync only re-writes subscriptions whose own dateUpdated (or
 * their customer/appointment) changed. When FieldRoutes assigns/changes the TECH
 * on a route, the route's dateUpdated changes but the subscription's doesn't, so
 * the incremental loop never re-pulls those subs and their job docs keep a stale
 * (often empty) tech — surfacing as phantom "Unassigned" stops in the Route
 * Builder even though FieldRoutes has them on an assigned tech's route.
 *
 * apptMap is rebuilt every run from ALL forward appointments (date >= today) and
 * already carries the current tech/route/group per subscription, so this refresh
 * costs ZERO extra API reads — it just fans that fresh state out to every
 * scheduled job doc, not only the ones in this pass's change set. recomputePastDue
 * (run afterwards) stays consistent because we also set alreadyScheduled + clear
 * the actionable flags here.
 *
 * It also DE-SCHEDULES the inverse case: a job doc still flagged scheduled for a
 * future date whose subscription is no longer in apptMap (its appointment was
 * cancelled / rescheduled / removed in FieldRoutes). Without this, those stops
 * linger as phantom route stops the dispatcher never put there. apptMap is the
 * authoritative current set of forward appointments, so absence = de-schedule.
 */
async function refreshScheduledAssignments(
  db: FirebaseFirestore.Firestore,
  companyId: string,
  apptMap: Record<string, ApptInfo>,
  today: string,
  now: string,
): Promise<{ updated: number; scanned: number; descheduled: number }> {
  const subIds = Object.keys(apptMap).filter((id) => id && id !== "-1" && id !== "0");
  let updated = 0;
  let scanned = 0;
  let batch = db.batch();
  let ops = 0;
  for (let i = 0; i < subIds.length; i += 300) {
    const refs = subIds
      .slice(i, i + 300)
      .map((id) => db.doc(`companies/${companyId}/jobs/sub_${id}`));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (!snap.exists) continue;
      scanned++;
      const d = snap.data() || {};
      const appt = apptMap[str(d.subscriptionId)];
      if (!appt) continue;
      const techId = str(appt.techId);
      const techName = str(appt.techName);
      const routeId = str(appt.routeId);
      const routeGroup = str(appt.routeGroup);
      const date = str(appt.date) || str(d.scheduledDate);
      // Never override a stop FieldRoutes already marked complete for this cycle.
      const completed = str(d.status) === "completed" || Boolean(d.serviceDueAlreadyCompleted);
      const desiredStatus = completed ? str(d.status) : "scheduled";

      const same =
        Boolean(d.fieldRoutesScheduled) === true &&
        Boolean(d.alreadyScheduled) === true &&
        str(d.fieldRoutesScheduledDate) === date &&
        str(d.fieldRoutesServicedById) === techId &&
        str(d.fieldRoutesServicedBy) === techName &&
        str(d.assignedTechId) === techName &&
        str(d.fieldRoutesRouteId) === routeId &&
        str(d.fieldRoutesRouteGroup) === routeGroup &&
        str(d.status) === desiredStatus;
      if (same) continue;

      const update: Record<string, unknown> = {
        fieldRoutesScheduled: true,
        alreadyScheduled: true,
        fieldRoutesScheduledDate: date,
        fieldRoutesServicedById: techId,
        fieldRoutesServicedBy: techName,
        assignedTechId: techName,
        fieldRoutesRouteId: routeId,
        fieldRoutesRouteGroup: routeGroup,
        fieldRoutesScheduleSource: "api_appointment",
        scheduledFor: date,
        scheduledTech: techName,
        updatedAt: now,
      };
      // A scheduled stop is excluded from the routable / review counts — mirror
      // what computeFlags produces for an already-scheduled subscription.
      if (!completed) {
        update.status = "scheduled";
        update.autoRoutable = false;
        update.needsReview = false;
        update.overdueActionable = false;
        update.dueSoonActionable = false;
      }
      batch.update(snap.ref, update);
      updated++;
      ops++;
      if (ops >= 450) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
  }

  // Pass B — de-schedule phantom stops: job docs still flagged scheduled for a
  // future date whose subscription is NOT in the current appointment set. Their
  // FieldRoutes appointment was cancelled / rescheduled / removed, so reset them
  // to their computed (unscheduled) status. recomputePastDue would also do this
  // eventually, but we do it here so the route reconciliation in the SAME run
  // already excludes them.
  let descheduled = 0;
  const scheduledSnap = await db
    .collection(`companies/${companyId}/jobs`)
    .where("fieldRoutesScheduled", "==", true)
    .get();
  for (const doc of scheduledSnap.docs) {
    const d = doc.data();
    const subId = str(d.subscriptionId);
    if (subId && apptMap[subId]) continue; // still has a live appointment — keep
    const schedDate = str(d.fieldRoutesScheduledDate) || str(d.scheduledDate);
    if (schedDate && schedDate < today) continue; // past stop — leave for normal flow
    if (str(d.status) === "completed" || Boolean(d.serviceDueAlreadyCompleted)) continue;

    // Recompute the unscheduled status/flags from stored data (alreadyScheduled
    // now false), mirroring recomputePastDue.
    const flags = computeFlags({
      inScope: Boolean(d.inScope),
      serviceDue: str(d.scheduledDate),
      customerBalance: num(d.customerBalance),
      specialScheduling: Boolean(d.hasConstraint) ? "x" : "",
      alreadyScheduled: false,
      pendingCancel: Boolean(d.pendingCancel),
      potentialCustomer: Boolean(d.potentialCustomer),
      today,
    });
    const status = flags.autoRoutable ? "pending" : flags.needsReview ? "review" : "inactive";
    batch.update(doc.ref, {
      fieldRoutesScheduled: false,
      alreadyScheduled: false,
      fieldRoutesServicedBy: "",
      fieldRoutesServicedById: "",
      fieldRoutesRouteId: "",
      fieldRoutesRouteGroup: "",
      fieldRoutesScheduleSource: "",
      assignedTechId: "",
      scheduledTech: "",
      status,
      autoRoutable: flags.autoRoutable,
      needsReview: flags.needsReview,
      overdueActionable: flags.overdueActionable,
      dueSoonActionable: flags.dueSoonActionable,
      pastDue: flags.pastDue,
      pastDue30: flags.pastDue30,
      dueSoon: flags.dueSoon,
      updatedAt: now,
    });
    descheduled++;
    ops++;
    if (ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }

  if (ops > 0) await batch.commit();
  return { updated, scanned, descheduled };
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
  technicianEmpIds: Set<string>,
  today: string,
  now: string,
): Promise<{ routesWritten: number; routesDeleted: number; techsLinked: number }> {
  interface SJob {
    id: string;
    date: string;
    techEmpId: string;
    techName: string;
    routeGroup: string;
    value: number;
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
      routeGroup: str(d.fieldRoutesRouteGroup),
      value: calculateStopProductionValue({
        recurringPrice: d.recurringPrice,
        billingPrice: d.billingPrice,
        recurringFrequency: d.recurringFrequency,
        billingFrequency: d.billingFrequency,
        revenue: d.revenue,
        productionValue: d.productionValue,
      }).value || 0,
      lat: typeof d.lat === "number" ? d.lat : undefined,
      lng: typeof d.lng === "number" ? d.lng : undefined,
      duration: Number(d.duration) || 25,
      scheduledDate: str(d.scheduledDate),
      customerName: str(d.customerName),
    });
  });

  // Restrict the technician list to employees FieldRoutes classifies as field
  // technicians (by role/type). If the roster is empty (no employee data) or
  // the filter would drop EVERY serving tech (unexpected type values), fall back
  // to the unfiltered set so a real tech's locked routes are never lost.
  let techServing = servingEmployeeIds;
  if (technicianEmpIds.size > 0) {
    const filtered = new Set([...servingEmployeeIds].filter((id) => technicianEmpIds.has(id)));
    if (filtered.size > 0) {
      techServing = filtered;
    } else {
      console.warn(
        "[fieldroutes/sync] technician role filter matched 0 of " +
          `${servingEmployeeIds.size} serving employees — keeping all to avoid dropping real techs.`,
      );
    }
  }

  const { empToTech, nameToTech } = await syncTechnicians(db, companyId, empNames, techServing, now);
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
    // A (date,tech) slot's stops share one FieldRoutes route → one group. Take
    // the first non-empty group label so the dashboard can filter by route group.
    const routeGroupTitle = orderedJobs.find((j) => j.routeGroup)?.routeGroup || "";
    const routeValue = orderedJobs.reduce((sum, j) => sum + (Number(j.value) || 0), 0);
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
          routeGroupTitle,
          routeValue,
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
        routeGroupTitle,
        routeValue,
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
    // Prefer a server-side frequency filter so we never even fetch One-Time/As Needed
    // subs (saves API reads). If FieldRoutes rejects/ignores the filter, fall back to
    // pulling all active subs — the main loop still drops non-recurring ones.
    try {
      return await client.searchIds("subscription", {
        active: 1,
        frequency: { operator: ">", value: 0 },
      });
    } catch (err) {
      if (err instanceof FieldRoutesBudgetError) throw err;
      console.warn(
        "[fieldroutes/sync] subscription frequency filter unsupported; falling back to active-only:",
        String(err),
      );
      return client.searchIds("subscription", { active: 1 });
    }
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
): Promise<{
  ids: string[];
  apptMap: Record<string, ApptInfo>;
  empNames: Record<string, string>;
  technicianEmpIds: string[];
  employeeRoster: Array<{ employeeId: string; name: string; type: number | null; isTechnician: boolean }>;
}> {
  const ids = sortIds(await resolveSubscriptionIds(client, mode, cursor));

  // Employees are few — fetch all once for name resolution.
  const employeeIds = await client.searchIds("employee", {});
  const employees = employeeIds.length ? await client.getEntities("employee", employeeIds) : [];
  const empNames: Record<string, string> = {};
  // Every alias ID of employees FieldRoutes marks as field technicians (by role/
  // type). Used to keep office/sales staff out of the technician list. A roster
  // is persisted alongside so the actual type of every employee is inspectable.
  const technicianEmpIds = new Set<string>();
  const employeeRoster: Array<{ employeeId: string; name: string; type: number | null; isTechnician: boolean }> = [];
  for (const e of employees) {
    const er = rec(e);
    const isTech = isTechnicianEmployee(er);
    employeeRoster.push({
      employeeId: str(er.employeeID || er.employeeId),
      name: employeeName(er),
      type: employeeType(er),
      isTechnician: isTech,
    });
    if (!isTech) continue;
    for (const raw of [er.employeeID, er.employeeId, er.roamingRep, er.linkedEmployeeIDs]) {
      for (const part of str(raw).split(",")) {
        const id = part.trim();
        if (id && id !== "0") technicianEmpIds.add(id);
      }
    }
  }
  // route.assignedTech can reference an employee by any of several ID fields
  // (employeeID, roamingRep, linkedEmployeeIDs) — confirmed against live data
  // where a tech's employeeID (e.g. 10005) differs from the ID routes use
  // (e.g. roamingRep 10122). Map every alias so the tech name always resolves;
  // employeeID wins on collision.
  for (const e of employees) {
    const er = rec(e);
    const name = employeeName(er);
    for (const raw of [er.roamingRep, er.linkedEmployeeIDs]) {
      for (const part of str(raw).split(",")) {
        const id = part.trim();
        if (id && id !== "0" && !empNames[id]) empNames[id] = name;
      }
    }
  }
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

  // ALL appointments for today or later — not just status 0 (Pending). Once a
  // tech starts or completes a stop in FieldRoutes, the appointment status
  // changes (1 = In Progress, 2 = Completed, etc.), but the route should still
  // appear on the dashboard and the subscription should still be marked as
  // scheduled so routing doesn't double-book it.
  const allApptIds = await client.searchIds("appointment", {
    date: { operator: ">=", value: today },
  });
  const allAppts = allApptIds.length
    ? await client.getEntities("appointment", allApptIds)
    : [];

  // The field technician is NOT on the appointment. Confirmed against live data:
  //   - appointment.employeeID  -> the office/API account that CREATED it (e.g. 10004)
  //   - appointment.assignedTech -> always "0" on pending appointments
  //   - route.addedBy            -> the creator again
  //   - route.assignedTech       -> the actual field tech for that route ✅
  // So resolve the tech from the route the appointment belongs to (via routeID),
  // reading route.assignedTech. Routes with assignedTech "0" are genuinely
  // unassigned in FieldRoutes — we leave their appointments tech-less rather than
  // inventing a phantom technician.
  const routeIdSet = new Set<string>();
  for (const a of allAppts) {
    const routeId = str(rec(a).routeID);
    if (routeId && routeId !== "0") routeIdSet.add(routeId);
  }
  const routeIds = Array.from(routeIdSet);
  const routes = routeIds.length ? await client.getEntities("route", routeIds) : [];
  const routeTechMap = new Map<string, string>();
  // route.groupTitle is the stable route-group label ("GPC"/"Specialty"/etc.).
  // Captured here from routes we already fetch, so the dashboard can filter
  // route-derived KPIs by group with zero extra API calls.
  const routeGroupMap = new Map<string, string>();
  for (const r of routes) {
    const rr = rec(r);
    const rid = str(rr.routeID);
    const techEmpId = str(rr.assignedTech);
    if (rid && techEmpId && techEmpId !== "0") routeTechMap.set(rid, techEmpId);
    const groupTitle = str(rr.groupTitle);
    if (rid && groupTitle) routeGroupMap.set(rid, groupTitle);
  }

  const apptMap: Record<string, ApptInfo> = {};
  for (const a of allAppts) {
    const ar = rec(a);
    const subId = str(ar.subscriptionID);
    if (!subId) continue;
    // Drop Cancelled (-1) and Rescheduled (-2) appointments — they still exist in
    // the appointment table (and would otherwise be treated as live scheduled
    // stops), but FieldRoutes no longer has the customer on that route. Pending
    // (0), Completed (1) and No-Show (2) are kept so an in-progress/finished route
    // still shows. This prevents phantom "scheduled" stops in the Route Builder.
    const apptStatus = num(ar.status);
    if (apptStatus === -1 || apptStatus === -2) continue;
    const date = toDateOnly(ar.date);
    if (!date || date < today) continue;
    const existing = apptMap[subId];
    const routeId = str(ar.routeID);
    const techEmpId = routeTechMap.get(routeId) || "";
    if (!existing || date < existing.date) {
      apptMap[subId] = {
        date,
        techId: techEmpId,
        techName: resolveEmpName(techEmpId),
        routeId: routeId && routeId !== "0" ? routeId : "",
        routeGroup: routeGroupMap.get(routeId) || "",
      };
    }
  }

  return { ids, apptMap, empNames, technicianEmpIds: [...technicianEmpIds], employeeRoster };
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
  let priorCursor = str(state.cursor);

  // Resume an in-progress run of the SAME mode; otherwise start a fresh run.
  const prior = state.run as RunProgress | undefined;
  const resuming = Boolean(prior?.active) && prior?.mode === mode && Array.isArray(prior?.ids);

  // Auto-detect empty DB after a reset: if the job collection is empty but we
  // still have a stored cursor, an incremental sync would only pick up recently
  // changed subscriptions and miss the bulk of the data. Clear the cursor so
  // resolveSubscriptionIds falls through to a full pull automatically.
  if (mode === "incremental" && priorCursor && !resuming) {
    const sample = await db
      .collection(`companies/${companyId}/jobs`)
      .where("source", "==", "api")
      .limit(1)
      .get();
    if (sample.empty) {
      console.log(
        "[fieldroutes/sync] Job collection empty with existing cursor — switching to full pull",
      );
      priorCursor = "";
    }
  }

  // Enforce the daily API cap. Reads are metered against the company's combined
  // reads+writes budget so RouteIQ never consumes the whole FieldRoutes account
  // quota (3,000/day, shared with every other tool).
  const budget = await loadBudget(db, companyId);
  client.setMaxReads(budget.remaining);

  // Already at/over the cap: don't start (or pause a resume) without spending a
  // single read. Any in-progress run state is left untouched so it resumes once
  // the cap resets at midnight Central (or the user raises it).
  if (budget.remaining <= 0) {
    const finishedAt = new Date().toISOString();
    return {
      mode,
      companyId,
      done: false,
      total: 0,
      offset: num(prior?.offset),
      subscriptionsProcessed: 0,
      inScopeCount: 0,
      autoRoutableCount: 0,
      alreadyScheduledCount: 0,
      needsReviewCount: 0,
      written: 0,
      apiReads: 0,
      cursor: priorCursor,
      startedAt,
      finishedAt,
      message: `FieldRoutes API daily cap reached (${budget.used}/${budget.cap} reads+writes). Sync paused — it resumes after the cap resets at midnight Central, or raise the cap in Settings.`,
      capped: true,
      apiCap: budget.cap,
      apiUsedToday: budget.used,
    };
  }

  // Configurable balance gate / age limit (Routing Settings). Cheap Firestore read.
  const routingConfig = await loadRoutingConfig(db, companyId);

  let ids: string[];
  let apptMap: Record<string, ApptInfo>;
  let empNames: Record<string, string>;
  let technicianEmpIds: string[];
  let offset: number;
  let cursor: string;
  let inScopeCount: number;
  let autoRoutableCount: number;
  let alreadyScheduledCount: number;
  let needsReviewCount: number;
  let written: number;
  let subsProcessed: number;

  // Set true if the cap is hit mid-run; flips the response to a paused state.
  let capped = false;

  if (resuming && prior) {
    ids = prior.ids;
    apptMap = rec(prior.apptMap) as Record<string, ApptInfo>;
    empNames = rec(prior.empNames) as Record<string, string>;
    technicianEmpIds = Array.isArray(prior.technicianEmpIds) ? prior.technicianEmpIds.map(String) : [];
    offset = num(prior.offset);
    cursor = str(prior.cursor) || priorCursor;
    inScopeCount = num(prior.counts?.inScope);
    autoRoutableCount = num(prior.counts?.autoRoutable);
    alreadyScheduledCount = num(prior.counts?.alreadyScheduled);
    needsReviewCount = num(prior.counts?.needsReview);
    written = num(prior.counts?.written);
    subsProcessed = num(prior.counts?.subsProcessed);
  } else {
    try {
      const setup = await buildRunSetup(client, mode, priorCursor, today);
      ids = setup.ids;
      apptMap = setup.apptMap;
      empNames = setup.empNames;
      technicianEmpIds = setup.technicianEmpIds;
      // Persist the full employee roster (id, name, type, isTechnician) so the
      // role-based technician filter is auditable — if a real tech is missing,
      // their actual `type` is visible here.
      await db.doc(`companies/${companyId}/fieldRoutesState/employeeRoster`).set(
        {
          employees: setup.employeeRoster,
          technicianCount: setup.technicianEmpIds.length,
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
    } catch (err) {
      if (err instanceof FieldRoutesBudgetError) {
        // Ran out of budget while building the account-wide lookups. No per-sub
        // progress to persist, so record the reads spent and report a pause; the
        // next invocation rebuilds setup once budget is available again.
        await recordApiUsage(db, companyId, { reads: client.readCount });
        const finishedAt = new Date().toISOString();
        const used = budget.used + client.readCount;
        return {
          mode,
          companyId,
          done: false,
          total: 0,
          offset: 0,
          subscriptionsProcessed: 0,
          inScopeCount: 0,
          autoRoutableCount: 0,
          alreadyScheduledCount: 0,
          needsReviewCount: 0,
          written: 0,
          apiReads: client.readCount,
          cursor: priorCursor,
          startedAt,
          finishedAt,
          message: `FieldRoutes API daily cap reached (${used}/${budget.cap} reads+writes) while preparing the sync. It resumes after the cap resets at midnight Central, or raise the cap in Settings.`,
          capped: true,
          apiCap: budget.cap,
          apiUsedToday: used,
        };
      }
      throw err;
    }
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
    let subscriptions: Record<string, unknown>[];
    let customers: Record<string, unknown>[];
    try {
      subscriptions = await client.getEntities("subscription", sliceIds);
      const customerIds = Array.from(
        new Set(subscriptions.map((s) => str(rec(s).customerID)).filter(Boolean)),
      );
      customers = customerIds.length ? await client.getEntities("customer", customerIds) : [];
    } catch (err) {
      if (err instanceof FieldRoutesBudgetError) {
        // Hit the cap fetching this slice. offset hasn't advanced and prior
        // slices are already committed, so breaking here is cleanly resumable.
        capped = true;
        break;
      }
      throw err;
    }
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
      // Real per-stop service time (minutes) from FieldRoutes — varies by service
      // type. Drives route service-minutes and the dashboard's Stops/Hour, which
      // was previously stuck because every stop used a hardcoded 25 min.
      const serviceDuration = num(sub.duration) > 0 ? num(sub.duration) : 25;
      // Seasonality drives the monthly service target. FieldRoutes stores the
      // season window on the subscription (seasonalStart/End = "0000-00-00" when
      // not seasonal). Capture the start/end MONTH (1–12) so the dashboard can
      // count a seasonal sub only in its active months.
      const seasonalStartDate = toDateOnly(sub.seasonalStart);
      const seasonalEndDate = toDateOnly(sub.seasonalEnd);
      const monthOf = (iso: string): number | null => {
        const m = /^\d{4}-(\d{2})-\d{2}$/.exec(iso);
        const n = m ? Number(m[1]) : 0;
        return n >= 1 && n <= 12 ? n : null;
      };
      const seasonalStartMonth = monthOf(seasonalStartDate);
      const seasonalEndMonth = monthOf(seasonalEndDate);
      const isSeasonal = seasonalStartMonth !== null && seasonalEndMonth !== null;
      const customerBalance = num(customer.balance);
      const specialScheduling = str(customer.specialScheduling);
      const onHold = num(sub.onHold);
      const frequency = num(sub.frequency);
      const active = num(sub.active);
      // Classify early — lawn rounds (a 7-round annual plan) carry a placeholder
      // frequency (e.g. -4) that fails the recurring test below, so we exempt the
      // lawn line from the non-recurring deletion while still dropping it when
      // cancelled (active != 1). serviceType alone is enough to spot the rounds.
      const serviceLine = deriveServiceLine(serviceType);
      const isLawnPlan = serviceLine === "lawn";

      // The app is recurring + ACTIVE only. Drop a subscription doc when it is no
      // longer active (cancelled/frozen → active != 1) or not genuinely recurring
      // (One-Time -1 / As Needed 0). This is how a sub that was deactivated in
      // FieldRoutes stops showing stale past-dues: the incremental sync re-pulls
      // it via dateUpdated, sees active != 1, and deletes the doc. (Pure Firestore
      // op; the full-set sweep in reconcileActiveSubscriptions catches the rest.)
      if (active !== 1 || (!isRecurringFrequency(frequency) && !isLawnPlan)) {
        const stale = db.doc(`companies/${companyId}/jobs/sub_${subscriptionId}`);
        batch.delete(stale);
        subsProcessed++;
        ops++;
        if (ops >= 450) await flush();
        continue;
      }

      // Customer-level gate. A subscription can be active:1 while the CUSTOMER
      // is one FieldRoutes excludes from "Customers Due For Service":
      //   - status != 1  → Inactive / Lead / Potential (statusText "Inactive")
      //   - officeID < 0 → test/system accounts (officeID "-1"), which can still
      //     be marked status:1 Active, so the status check alone misses them.
      // Drop the job doc in either case so these never reach routing or counts.
      // Guard: only act when we actually have the customer record (and, for the
      // status test, the field is present) so a missing customer can't trigger
      // a spurious delete.
      const haveCustomer = Boolean(str(customer.customerID));
      const custStatusRaw = customer.status;
      const custStatusPresent =
        custStatusRaw !== undefined && custStatusRaw !== null && String(custStatusRaw).trim() !== "";
      const custStatus = num(custStatusRaw);
      const custOfficeId = num(customer.officeID);
      const customerInactive = haveCustomer && custStatusPresent && custStatus !== 1;
      const customerTestOffice = haveCustomer && custOfficeId < 0;
      if (customerInactive || customerTestOffice) {
        const stale = db.doc(`companies/${companyId}/jobs/sub_${subscriptionId}`);
        batch.delete(stale);
        subsProcessed++;
        ops++;
        if (ops >= 450) await flush();
        continue;
      }

      const appt = apptMap[subscriptionId];
      const alreadyScheduled = Boolean(appt);
      // Coerce with str() so a missing field on a rehydrated appt entry (Firestore
      // strips undefined on persist) can never propagate undefined into the doc write.
      const scheduledFor = appt ? str(appt.date) : "";
      const scheduledRouteId = appt ? str(appt.routeId) : "";
      const scheduledTech = appt ? str(appt.techName) : "";
      const scheduledTechId = appt ? str(appt.techId) : "";
      const scheduledRouteGroup = appt ? str(appt.routeGroup) : "";

      // Pending cancel comes straight off the customer record (don't derive it
      // from dateCancelled — that field is "0000-00-00 00:00:00" when unset and
      // would parse as a truthy date). Survivors of the gate above are all
      // status:1 Active, so potentialCustomer is moot here (kept false).
      const pendingCancel = num(customer.pendingCancel) === 1;
      const potentialCustomer = false;

      // Lawn rounds are recurring revenue even though FieldRoutes gives them a
      // placeholder frequency, so treat an active, charged lawn round as in-scope.
      const inScope =
        isInScope({ onHold, recurringCharge: sub.recurringCharge, frequency }) ||
        (isLawnPlan && num(onHold) === 0 && num(sub.recurringCharge) > 0 && active === 1);
      const flags = computeFlags({
        inScope,
        serviceDue,
        customerBalance,
        specialScheduling,
        alreadyScheduled,
        pendingCancel,
        potentialCustomer,
        today,
        balanceGate: routingConfig.balanceGate,
        balanceAgeGate: routingConfig.balanceAgeGate,
        customerBalanceAgeDays: num(customer.balanceAge),
      });

      // serviceLine is derived above (from serviceType). Interval deadline is
      // counted from the last completed service.
      const deadlineFlags = computeDeadlineFlags(
        {
          serviceLine,
          frequency,
          recurringFrequency: recurringFrequencyLabel(sub.frequency),
          lastCompleted,
          scheduledDate: serviceDue,
        },
        today,
      );

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
        duration: serviceDuration,
        status,
        // Routing-relevant assignment fields:
        assignedTechId: alreadyScheduled ? scheduledTech : "",
        fieldRoutesScheduled: alreadyScheduled,
        fieldRoutesScheduledDate: scheduledFor || serviceDue,
        fieldRoutesServicedBy: alreadyScheduled ? scheduledTech : "",
        fieldRoutesServicedById: alreadyScheduled ? scheduledTechId : "",
        fieldRoutesRouteId: alreadyScheduled ? scheduledRouteId : "",
        fieldRoutesRouteGroup: scheduledRouteGroup,
        fieldRoutesScheduleSource: alreadyScheduled ? "api_appointment" : "",
        schedulingRequest: specialScheduling,
        // Subscription / billing detail (labels match the FieldRoutes report):
        recurringFrequency: recurringFrequencyLabel(sub.frequency),
        frequency,
        billingFrequency: billingFrequencyLabel(sub.billingFrequency),
        recurringPrice: str(sub.recurringCharge),
        subscriptionStatus: str(sub.active),
        subscriptionBalance: String(customerBalance),
        subscriptionOnHold: String(onHold),
        subscriptionLastServiced: lastCompleted,
        subscriptionLastCompletedDate: lastCompleted,
        serviceDueAlreadyCompleted,
        seasonalStartMonth,
        seasonalEndMonth,
        isSeasonal,
        // Service-line segregation + interval-deadline urgency (Sensei v2 Router model).
        serviceLine,
        serviceIntervalDays: deadlineFlags.intervalDays,
        serviceDeadline: deadlineFlags.deadline,
        daysUntilDeadline: deadlineFlags.daysUntilDeadline,
        pastDeadline: deadlineFlags.pastDeadline && !serviceDueAlreadyCompleted,
        deadlineFlagZone: deadlineFlags.flagZone && !serviceDueAlreadyCompleted,
        grEscalation: deadlineFlags.grEscalation && !serviceDueAlreadyCompleted,
        preferredTech,
        // Computed flags (also stored as columns for review feeds / debugging):
        inScope,
        pastDue: flags.pastDue,
        pastDue30: flags.pastDue30,
        dueSoon: flags.dueSoon,
        balanceOk: flags.balanceOk,
        hasConstraint: flags.hasConstraint,
        alreadyScheduled,
        autoRoutable: flags.autoRoutable,
        needsReview: flags.needsReview,
        // "Past Due" (>30d overdue) and "Pending" (±30d) actionable counts — a
        // completed-after-due stop is neither (servicing rolled the date forward).
        overdueActionable: flags.overdueActionable && !serviceDueAlreadyCompleted,
        dueSoonActionable: flags.dueSoonActionable && !serviceDueAlreadyCompleted,
        pendingCancel,
        potentialCustomer,
        customerStatus: custStatus,
        customerOfficeId: custOfficeId,
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

  // On the final pass, fan the fresh apptMap (current tech/route/group per
  // scheduled subscription) out to ALL scheduled job docs — not just the ones in
  // this run's change set — so tech reassignments made in FieldRoutes (which an
  // incremental sync wouldn't otherwise re-pull) can't leave stale "Unassigned"
  // stops. Zero API cost (apptMap is already in memory).
  if (done) {
    try {
      const refreshed = await refreshScheduledAssignments(db, companyId, apptMap, today, now);
      console.log(
        `[fieldroutes/sync] refreshed scheduled assignments: ${refreshed.updated} updated of ` +
          `${refreshed.scanned} scanned, ${refreshed.descheduled} de-scheduled (phantom stops cleared)`,
      );
    } catch (err) {
      console.error("[fieldroutes/sync] scheduled-assignment refresh failed:", String(err));
    }
  }

  // Reconcile scheduled routes after every sync pass (incremental or full) so
  // Today's Routes on the dashboard always reflects the current FieldRoutes state.
  // Derived from current Firestore job state — zero API cost.
  try {
    const reconciled = await reconcileScheduledRoutes(db, companyId, empNames, new Set(technicianEmpIds), today, now);
    console.log(
      `[fieldroutes/sync] reconciled routes: ${reconciled.routesWritten} written, ` +
        `${reconciled.routesDeleted} removed, ${reconciled.techsLinked} techs linked`,
    );
  } catch (err) {
    console.error("[fieldroutes/sync] route reconciliation failed:", String(err));
  }

  if (done) {
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
      technicianEmpIds,
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

  // Meter the reads this invocation spent against the daily cap.
  await recordApiUsage(db, companyId, { reads: client.readCount });
  const apiUsedToday = budget.used + client.readCount;

  const message = done
    ? `Sync complete: processed ${subsProcessed} of ${total} subscriptions.`
    : capped
      ? `FieldRoutes API daily cap reached (${apiUsedToday}/${budget.cap} reads+writes). Synced ${offset} of ${total} subscriptions; the rest resumes after the cap resets at midnight Central, or raise the cap in Settings.`
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
    capped,
    apiCap: budget.cap,
    apiUsedToday,
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

  const routingConfig = await loadRoutingConfig(db, companyId);
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
    const hasConstraint = Boolean(d.hasConstraint);
    const alreadyScheduled = Boolean(d.alreadyScheduled);
    const pendingCancel = Boolean(d.pendingCancel);
    const potentialCustomer = Boolean(d.potentialCustomer);

    // Recompute the date-window flags fresh — pastDue30/dueSoon flip with the
    // passage of time, not a record edit, so they must be re-derived daily.
    const flags = computeFlags({
      inScope,
      serviceDue,
      customerBalance: num(d.customerBalance),
      specialScheduling: hasConstraint ? "x" : "",
      alreadyScheduled,
      pendingCancel,
      potentialCustomer,
      today,
      balanceGate: routingConfig.balanceGate,
      balanceAgeGate: routingConfig.balanceAgeGate,
      customerBalanceAgeDays: num(d.customerBalanceAge),
    });
    const { pastDue, pastDue30, dueSoon, balanceOk, autoRoutable, needsReview, overdueActionable, dueSoonActionable } = flags;

    // The interval deadline also shifts daily (today moves toward/past it).
    const serviceLine = deriveServiceLine(d.serviceType, d.fieldRoutesRouteGroup);
    const deadlineFlags = computeDeadlineFlags(
      {
        serviceLine,
        frequency: d.frequency,
        recurringFrequency: d.recurringFrequency,
        lastCompleted: str(d.subscriptionLastCompletedDate),
        scheduledDate: serviceDue,
      },
      today,
    );

    let status: string;
    if (alreadyScheduled) status = "scheduled";
    else if (autoRoutable) status = "pending";
    else if (needsReview) status = "review";
    else status = "inactive";

    if (
      pastDue !== Boolean(d.pastDue) ||
      pastDue30 !== Boolean(d.pastDue30) ||
      dueSoon !== Boolean(d.dueSoon) ||
      balanceOk !== Boolean(d.balanceOk) ||
      autoRoutable !== Boolean(d.autoRoutable) ||
      needsReview !== Boolean(d.needsReview) ||
      overdueActionable !== Boolean(d.overdueActionable) ||
      dueSoonActionable !== Boolean(d.dueSoonActionable) ||
      status !== str(d.status) ||
      serviceLine !== str(d.serviceLine) ||
      deadlineFlags.deadline !== str(d.serviceDeadline) ||
      deadlineFlags.pastDeadline !== Boolean(d.pastDeadline) ||
      deadlineFlags.flagZone !== Boolean(d.deadlineFlagZone) ||
      deadlineFlags.grEscalation !== Boolean(d.grEscalation)
    ) {
      batch.update(doc.ref, {
        pastDue,
        pastDue30,
        dueSoon,
        balanceOk,
        autoRoutable,
        needsReview,
        overdueActionable,
        dueSoonActionable,
        status,
        serviceLine,
        serviceIntervalDays: deadlineFlags.intervalDays,
        serviceDeadline: deadlineFlags.deadline,
        daysUntilDeadline: deadlineFlags.daysUntilDeadline,
        pastDeadline: deadlineFlags.pastDeadline,
        deadlineFlagZone: deadlineFlags.flagZone,
        grEscalation: deadlineFlags.grEscalation,
        updatedAt: now,
      });
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

/**
 * Delete Firestore job docs for subscriptions that are no longer ACTIVE +
 * recurring in FieldRoutes. Roots out the stale-past-due problem: a sub that was
 * cancelled/frozen long ago never reappears in an incremental change set, so its
 * job doc would otherwise linger forever showing a dead service-due date.
 *
 * Cost: one cheap `subscription` search (IDs only — no entity fetches) for the
 * full active+recurring set, gated by the daily API budget. If that set can't be
 * established (API error, budget exhausted, or an empty/zero result), the sweep
 * is SKIPPED entirely — we never delete docs against an unconfirmed set, so a
 * transient API hiccup can't wipe the jobs collection.
 */
export async function reconcileActiveSubscriptions(): Promise<{
  companyId: string;
  activeCount: number;
  scanned: number;
  deleted: number;
  skipped: boolean;
  reason?: string;
}> {
  const companyId = targetCompanyId();
  const db = adminDb();

  // Establish the authoritative active+recurring ID set before touching anything.
  const client = new FieldRoutesClient();
  const budget = await loadBudget(db, companyId);
  client.setMaxReads(budget.remaining);
  if (budget.remaining <= 0) {
    return { companyId, activeCount: 0, scanned: 0, deleted: 0, skipped: true, reason: "api cap reached" };
  }

  let activeIds: string[];
  try {
    activeIds = await client.searchIds("subscription", {
      active: 1,
      frequency: { operator: ">", value: 0 },
    });
  } catch (err) {
    if (err instanceof FieldRoutesBudgetError) {
      await recordApiUsage(db, companyId, { reads: client.readCount });
      return { companyId, activeCount: 0, scanned: 0, deleted: 0, skipped: true, reason: "api cap reached" };
    }
    // Filter unsupported → fall back to active-only (still excludes cancelled/frozen).
    try {
      activeIds = await client.searchIds("subscription", { active: 1 });
    } catch (err2) {
      await recordApiUsage(db, companyId, { reads: client.readCount });
      console.warn("[fieldroutes/reconcile] active subscription search failed; skipping sweep:", String(err2));
      return { companyId, activeCount: 0, scanned: 0, deleted: 0, skipped: true, reason: "search failed" };
    }
  }
  await recordApiUsage(db, companyId, { reads: client.readCount });

  const activeSet = new Set(activeIds.map((id) => str(id)).filter(Boolean));
  // Refuse to sweep against an empty set — that almost certainly means the search
  // came back blank, and deleting every job doc would be catastrophic.
  if (activeSet.size === 0) {
    return { companyId, activeCount: 0, scanned: 0, deleted: 0, skipped: true, reason: "empty active set" };
  }

  const snap = await db.collection(`companies/${companyId}/jobs`).where("source", "==", "api").get();
  let batch = db.batch();
  let ops = 0;
  let deleted = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    const subId = str(d.subscriptionId);
    if (subId && activeSet.has(subId)) continue; // still active + recurring — keep
    // Lawn rounds use a placeholder frequency, so they never appear in the
    // frequency>0 active set — keep them here; cancelled rounds are removed by the
    // sync loop's active!=1 check instead.
    if (deriveServiceLine(d.serviceType) === "lawn") continue;
    batch.delete(doc.ref);
    deleted++;
    ops++;
    if (ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();

  return { companyId, activeCount: activeSet.size, scanned: snap.size, deleted, skipped: false };
}

/**
 * Delete one-time / as-needed job docs so the app stays recurring-only. Detects
 * non-recurring docs by the stored raw `frequency` (<= 0) when present, falling
 * back to the human label ("One-Time" / "As Needed") for legacy docs synced
 * before `frequency` was persisted. Pure Firestore — zero FieldRoutes reads.
 */
export async function purgeNonRecurring(): Promise<{ companyId: string; scanned: number; deleted: number }> {
  const companyId = targetCompanyId();
  const db = adminDb();

  const snap = await db.collection(`companies/${companyId}/jobs`).where("source", "==", "api").get();
  let batch = db.batch();
  let ops = 0;
  let deleted = 0;

  for (const doc of snap.docs) {
    const d = doc.data();
    // Lawn rounds are recurring revenue carried with a placeholder frequency —
    // never purge them as "non-recurring".
    if (deriveServiceLine(d.serviceType) === "lawn") continue;
    const hasRawFrequency = typeof d.frequency === "number";
    const label = str(d.recurringFrequency);
    const nonRecurring = hasRawFrequency
      ? num(d.frequency) <= 0
      : label === "One-Time" || label === "As Needed";
    if (!nonRecurring) continue;

    batch.delete(doc.ref);
    deleted++;
    ops++;
    if (ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();

  return { companyId, scanned: snap.size, deleted };
}

/**
 * Delete job docs whose CUSTOMER is excluded from FieldRoutes' "Customers Due
 * For Service" report: status != 1 (Inactive / Lead / Potential) OR officeID < 0
 * (test/system accounts in office "-1", which can still be status:1 Active).
 * Catches test/demo accounts that have active subscriptions but a customer
 * record FieldRoutes hides. Costs 1 API read per 1000 unique customers.
 */
export async function purgeInactiveCustomers(): Promise<{
  companyId: string;
  scanned: number;
  deleted: number;
  customersChecked: number;
  skipped: boolean;
  reason?: string;
}> {
  const companyId = targetCompanyId();
  const db = adminDb();

  const snap = await db.collection(`companies/${companyId}/jobs`).where("source", "==", "api").get();
  if (snap.empty) {
    return { companyId, scanned: 0, deleted: 0, customersChecked: 0, skipped: false };
  }

  const customerIdSet = new Set<string>();
  for (const doc of snap.docs) {
    const cid = str(doc.data().customerId);
    if (cid) customerIdSet.add(cid);
  }
  const uniqueCustomerIds = Array.from(customerIdSet);

  const client = new FieldRoutesClient();
  const budget = await loadBudget(db, companyId);
  client.setMaxReads(budget.remaining);
  if (budget.remaining <= 0) {
    return { companyId, scanned: snap.size, deleted: 0, customersChecked: 0, skipped: true, reason: "api cap reached" };
  }

  let customers: Record<string, unknown>[];
  try {
    customers = await client.getEntities("customer", uniqueCustomerIds);
  } catch (err) {
    await recordApiUsage(db, companyId, { reads: client.readCount });
    if (err instanceof FieldRoutesBudgetError) {
      return { companyId, scanned: snap.size, deleted: 0, customersChecked: 0, skipped: true, reason: "api cap reached" };
    }
    console.warn("[fieldroutes/purgeInactiveCustomers] customer fetch failed; skipping:", String(err));
    return { companyId, scanned: snap.size, deleted: 0, customersChecked: 0, skipped: true, reason: "fetch failed" };
  }
  await recordApiUsage(db, companyId, { reads: client.readCount });

  // Match the sync-loop gate: a customer is "inactive" for our purposes when
  // status != 1 (Inactive/Lead) OR officeID < 0 (test/system account in office
  // -1, which can still be status:1 Active). Only flag customers FieldRoutes
  // actually returned and whose status field is present, so a transient miss
  // can't delete real docs.
  const inactiveCustomerIds = new Set<string>();
  for (const c of customers) {
    const cRec = rec(c);
    const cId = str(cRec.customerID);
    if (!cId) continue;
    const statusRaw = cRec.status;
    const statusPresent =
      statusRaw !== undefined && statusRaw !== null && String(statusRaw).trim() !== "";
    const status = num(statusRaw);
    const officeId = num(cRec.officeID);
    if ((statusPresent && status !== 1) || officeId < 0) {
      inactiveCustomerIds.add(cId);
    }
  }

  if (inactiveCustomerIds.size === 0) {
    return { companyId, scanned: snap.size, deleted: 0, customersChecked: uniqueCustomerIds.length, skipped: false };
  }

  let batch = db.batch();
  let ops = 0;
  let deleted = 0;
  for (const doc of snap.docs) {
    const cid = str(doc.data().customerId);
    if (!cid || !inactiveCustomerIds.has(cid)) continue;
    batch.delete(doc.ref);
    deleted++;
    ops++;
    if (ops >= 450) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();

  return { companyId, scanned: snap.size, deleted, customersChecked: uniqueCustomerIds.length, skipped: false };
}
