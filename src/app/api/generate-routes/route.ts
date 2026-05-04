export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { parseSchedulingRequest, CRITICAL_CLASSES } from "@/lib/scheduling-constraints";
import {
  computeRouteGeometry,
  computeRouteMatrix,
  hasGoogleRoutesApiKey,
  runRouteOptimizationShadow,
  type MatrixSource,
  type RouteOptimizationShadowResult,
  type RoutePoint,
} from "@/lib/google-routing";
import { routeAddressKey } from "@/lib/route-bundles";

const BACKEND_URL =
  process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || "";

const DEFAULT_MAX_STOPS = 16;
const DEFAULT_MAX_DRIVE_MINUTES = 240;
const JOB_CAP = 500;
const WEEKDAY_LABEL_BY_JS_DAY = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const ROUTE_SPREAD_WEIGHT = 1.35;

function _dateOffset(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function _daysBetween(start: string, end: string): number {
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1);
}

function daysBetweenDates(a: string, b: string) {
  if (!a || !b) return 0;
  const aTime = new Date(a + "T00:00:00").getTime();
  const bTime = new Date(b + "T00:00:00").getTime();
  if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return 0;
  return Math.round((aTime - bTime) / 86400000);
}

function normalizeName(s: string) {
  return s
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function techMatchTokens(tech: Record<string, unknown> & { id: string }) {
  return [
    String(tech.id || "").trim(),
    String(tech.name || "").trim(),
    String(tech.employeeId || "").trim(),
    String(tech.fieldRoutesEmployeeId || "").trim(),
    String(tech.fieldRoutesTechId || "").trim(),
  ].filter(Boolean);
}

function jobAssignedToTech(
  job: JobDoc,
  tech: Record<string, unknown> & { id: string },
) {
  const assigned = String(job.assignedTechId || "").trim();
  if (!assigned) return false;
  const assignedNormalized = normalizeName(assigned);
  return techMatchTokens(tech).some((token) => {
    return token === assigned || normalizeName(token) === assignedNormalized;
  });
}

function serviceFrequencyDays(job: JobDoc) {
  const raw = String(
    job.recurringFrequency ||
      job.serviceFrequency ||
      job.frequency ||
      job.subscriptionCategory ||
      "",
  ).toLowerCase();

  const everyNumber = raw.match(/every\s+(\d+(?:\.\d+)?)\s*(day|days|week|weeks|month|months|year|years)/);
  if (everyNumber) {
    const value = Number(everyNumber[1]);
    const unit = everyNumber[2];
    if (unit.startsWith("day")) return value;
    if (unit.startsWith("week")) return value * 7;
    if (unit.startsWith("month")) return value * 30;
    if (unit.startsWith("year")) return value * 365;
  }

  if (raw.includes("weekly")) return 7;
  if (raw.includes("biweekly") || raw.includes("bi-weekly")) return 14;
  if (raw.includes("monthly") || raw.includes("month")) return 30;
  if (raw.includes("quarterly") || raw.includes("90")) return 90;
  if (raw.includes("semi") && raw.includes("annual")) return 180;
  if (raw.includes("annual") || raw.includes("year")) return 365;
  return 999;
}

function dateMovePenaltyPerDay(job: JobDoc) {
  const days = serviceFrequencyDays(job);
  if (days <= 31) return 30;
  if (days <= 60) return 18;
  if (days <= 100) return 7;
  if (days <= 190) return 4;
  return 2;
}

function weekdayLabelForDate(dateStr: string) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  const day = date.getUTCDay();
  return WEEKDAY_LABEL_BY_JS_DAY[Number.isFinite(day) ? day : 0];
}

function weekdaySet(value: string) {
  return new Set(
    value
      .split(",")
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean),
  );
}

function jobScheduleBlockReason(job: JobDoc, slotDate: string) {
  const parsed = parseSchedulingRequest(String(job.schedulingRequest || ""));
  if (!parsed.schedulingRequestClass) return "";

  if (CRITICAL_CLASSES.has(parsed.schedulingRequestClass)) {
    return parsed.schedulingConstraintNote || parsed.schedulingRequestClass;
  }

  const weekday = weekdayLabelForDate(slotDate);
  const allowed = weekdaySet(parsed.schedulingAllowedWeekdays);
  if (allowed.size > 0 && !allowed.has(weekday)) {
    return `requires ${parsed.schedulingAllowedWeekdays}`;
  }

  const blocked = weekdaySet(parsed.schedulingBlockedWeekdays);
  if (blocked.has(weekday)) {
    return `no ${weekday}`;
  }

  return "";
}

function canScheduleJobOnDate(job: JobDoc, slotDate: string) {
  return !jobScheduleBlockReason(job, slotDate);
}

function dateTier(job: JobDoc, rangeStart: string, rangeEnd: string) {
  const sd = String(job.scheduledDate || "");
  if (!sd) return 3;
  if (sd < rangeStart) return 0;
  if (sd <= rangeEnd) return 1;
  return 2;
}

function jobPriorityComparator(rangeStart: string, rangeEnd: string) {
  return (a: JobDoc, b: JobDoc) => {
    const tierDiff = dateTier(a, rangeStart, rangeEnd) - dateTier(b, rangeStart, rangeEnd);
    if (tierDiff !== 0) return tierDiff;

    const dateDiff = String(a.scheduledDate || "").localeCompare(String(b.scheduledDate || ""));
    if (dateDiff !== 0) return dateDiff;

    const freqDiff = serviceFrequencyDays(a) - serviceFrequencyDays(b);
    if (freqDiff !== 0) return freqDiff;

    return String(a.customerName || a.docId).localeCompare(String(b.customerName || b.docId));
  };
}

function dateAssignmentPenalty(job: JobDoc, slotDate: string, rangeStart: string, rangeEnd: string) {
  const sd = String(job.scheduledDate || "");
  if (!sd) return 25;

  const perDay = dateMovePenaltyPerDay(job);
  const tier = dateTier(job, rangeStart, rangeEnd);

  if (tier === 0) {
    return Math.max(0, daysBetweenDates(slotDate, rangeStart)) * perDay * 0.75;
  }
  if (tier === 1) {
    return Math.abs(daysBetweenDates(slotDate, sd)) * perDay;
  }
  if (tier === 2) {
    return Math.abs(daysBetweenDates(slotDate, rangeEnd)) * perDay * 0.5;
  }
  return 25;
}

function shouldBundleSameAddressJob(anchor: JobDoc, candidate: JobDoc, rangeEnd: string) {
  const anchorKey = routeAddressKey(anchor);
  if (!anchorKey || routeAddressKey(candidate) !== anchorKey) return false;
  const candidateDate = String(candidate.scheduledDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidateDate)) return false;
  const anchorMonth = String(anchor.scheduledDate || "").slice(0, 7);
  const candidateMonth = candidateDate.slice(0, 7);
  return candidateDate <= _dateOffset(rangeEnd, 14) || (anchorMonth && candidateMonth === anchorMonth);
}

function expandSameAddressBundlesForSelection({
  selectedJobs,
  allJobs,
  selectedTechs,
  rangeEnd,
}: {
  selectedJobs: JobDoc[];
  allJobs: JobDoc[];
  selectedTechs: Array<Record<string, unknown> & { id: string }>;
  rangeEnd: string;
}) {
  const byId = new Map(selectedJobs.map((job) => [job.docId, job]));
  const selectedSnapshot = [...selectedJobs];

  for (const anchor of selectedSnapshot) {
    const tech = selectedTechs.find((candidateTech) => jobAssignedToTech(anchor, candidateTech));
    if (!tech) continue;
    for (const candidate of allJobs) {
      if (byId.has(candidate.docId)) continue;
      if (!jobAssignedToTech(candidate, tech)) continue;
      if (!shouldBundleSameAddressJob(anchor, candidate, rangeEnd)) continue;
      byId.set(candidate.docId, candidate);
    }
  }

  return Array.from(byId.values());
}

interface JobDoc {
  docId: string;
  customerId?: string;
  customerID?: string;
  customerName?: string;
  address?: string;
  addressRaw?: string;
  lat?: number | null;
  lng?: number | null;
  scheduledDate?: string;
  serviceType?: string;
  schedulingRequest?: string;
  duration?: number;
  subscriptionId?: string;
  subscriptionID?: string;
  assignedTechId?: string;
  recurringFrequency?: string;
  billingFrequency?: string;
  subscriptionLastServiced?: string;
  subscriptionCategory?: string;
  [key: string]: unknown;
}

interface BackendStop {
  customerID?: string;
  id?: string;
  [key: string]: unknown;
}

interface BackendRoute {
  stops?: BackendStop[];
  totalDriveMinutes?: number;
  totalServiceMinutes?: number;
  totalWorkMinutes?: number;
  routeName?: string;
  driveTimeSource?: string;
  polylineSource?: string;
  encodedPolyline?: string;
  routePolyline?: Array<{ lat: number; lng: number }>;
  polylineStatus?: string;
  failedRouteSegments?: number;
  googleRouteOptimizationShadowScore?: number;
  googleRouteOptimizationRunId?: string;
  googleRouteOptimizationSummary?: Record<string, unknown>;
  [key: string]: unknown;
}

interface RouteSlot {
  date: string;
  tech: Record<string, unknown> & { id: string };
  index: number;
}

interface SlotAssignment {
  slot: RouteSlot;
  jobs: JobDoc[];
}

interface FastRouteBuildResult {
  routes: BackendRoute[];
  deferredJobIds: string[];
  warnings: string[];
  usedMatrixSources: string[];
  usedPolylineSources: string[];
}

type DriveMatrixResult = {
  matrix: number[][];
  source: MatrixSource;
  failedElements: number;
  warnings: string[];
};

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
) {
  const radiusMiles = 3958.7613;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const rLat1 = toRadians(lat1);
  const rLat2 = toRadians(lat2);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) ** 2;
  return radiusMiles * 2 * Math.asin(Math.sqrt(a));
}

function estimateDriveMinutes(a: JobDoc, b: JobDoc) {
  if (typeof a.lat !== "number" || typeof a.lng !== "number") return 0;
  if (typeof b.lat !== "number" || typeof b.lng !== "number") return 0;
  return (haversineMiles(a.lat, a.lng, b.lat, b.lng) / 30) * 60;
}

function routeDriveMinutes(jobs: JobDoc[]) {
  let total = 0;
  for (let i = 1; i < jobs.length; i++) {
    total += estimateDriveMinutes(jobs[i - 1], jobs[i]);
  }
  return total;
}

async function getDriveMatrix(jobs: JobDoc[], routeDate?: string): Promise<DriveMatrixResult> {
  const result = await computeRouteMatrix(jobs, { routeDate });
  return {
    matrix: result.matrix,
    source: result.source,
    failedElements: result.failedElements,
    warnings: result.warnings,
  };
}

function matrixRouteCost(order: number[], matrix: number[][]) {
  let total = 0;
  for (let i = 1; i < order.length; i++) {
    total += matrix[order[i - 1]][order[i]];
  }
  return total;
}

function nearestNeighborOrderFromMatrix(matrix: number[][], startIdx: number) {
  const remaining = Array.from({ length: matrix.length }, (_, idx) => idx);
  const ordered = [remaining.splice(startIdx, 1)[0]];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let bestRemainingIdx = 0;
    for (let i = 1; i < remaining.length; i++) {
      if (matrix[last][remaining[i]] < matrix[last][remaining[bestRemainingIdx]]) {
        bestRemainingIdx = i;
      }
    }
    ordered.push(remaining.splice(bestRemainingIdx, 1)[0]);
  }
  return ordered;
}

function twoOptImproveMatrix(order: number[], matrix: number[][]) {
  if (order.length <= 3) return order;
  let best = [...order];
  let bestCost = matrixRouteCost(best, matrix);
  let improved = true;
  let passes = 0;

  while (improved && passes < 40) {
    improved = false;
    passes++;
    for (let i = 1; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, j + 1).reverse(),
          ...best.slice(j + 1),
        ];
        const cost = matrixRouteCost(candidate, matrix);
        if (cost + 0.01 < bestCost) {
          best = candidate;
          bestCost = cost;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }
  return best;
}

function orderRouteWithMatrix(jobs: JobDoc[], matrix: number[][]) {
  if (jobs.length <= 2) {
    const order = jobs.map((_, idx) => idx);
    return { ordered: jobs, totalDriveMinutes: matrixRouteCost(order, matrix) };
  }

  const center = centroid(jobs);
  const starts = new Set<number>();
  starts.add(
    jobs.reduce((bestIdx, job, idx) =>
      distanceToCentroid(job, center) < distanceToCentroid(jobs[bestIdx], center)
        ? idx
        : bestIdx,
    0),
  );
  if (jobs.length <= 22) {
    jobs.forEach((_, idx) => starts.add(idx));
  } else {
    starts.add(jobs.reduce((bestIdx, job, idx) => Number(job.lat) < Number(jobs[bestIdx].lat) ? idx : bestIdx, 0));
    starts.add(jobs.reduce((bestIdx, job, idx) => Number(job.lat) > Number(jobs[bestIdx].lat) ? idx : bestIdx, 0));
    starts.add(jobs.reduce((bestIdx, job, idx) => Number(job.lng) < Number(jobs[bestIdx].lng) ? idx : bestIdx, 0));
    starts.add(jobs.reduce((bestIdx, job, idx) => Number(job.lng) > Number(jobs[bestIdx].lng) ? idx : bestIdx, 0));
  }

  let bestOrder = twoOptImproveMatrix(nearestNeighborOrderFromMatrix(matrix, 0), matrix);
  let bestCost = matrixRouteCost(bestOrder, matrix);
  for (const startIdx of starts) {
    const candidate = twoOptImproveMatrix(nearestNeighborOrderFromMatrix(matrix, startIdx), matrix);
    const cost = matrixRouteCost(candidate, matrix);
    if (cost + 0.01 < bestCost) {
      bestOrder = candidate;
      bestCost = cost;
    }
  }

  return {
    ordered: bestOrder.map((idx) => jobs[idx]),
    totalDriveMinutes: bestCost,
  };
}

function keepSameAddressJobsTogether(ordered: JobDoc[]) {
  const byAddress = new Map<string, JobDoc[]>();
  ordered.forEach((job) => {
    const key = routeAddressKey(job);
    if (!key) return;
    byAddress.set(key, [...(byAddress.get(key) || []), job]);
  });

  const emitted = new Set<string>();
  const output: JobDoc[] = [];
  ordered.forEach((job) => {
    const key = routeAddressKey(job);
    if (!key) {
      output.push(job);
      return;
    }
    if (emitted.has(key)) return;
    emitted.add(key);
    output.push(...(byAddress.get(key) || [job]));
  });
  return output;
}

function orderedDriveMinutesFromMatrix(
  ordered: JobDoc[],
  matrixById: Map<string, number>,
  matrix: number[][],
) {
  let total = 0;
  for (let idx = 1; idx < ordered.length; idx++) {
    const prevIdx = matrixById.get(ordered[idx - 1].docId);
    const currentIdx = matrixById.get(ordered[idx].docId);
    total +=
      prevIdx !== undefined && currentIdx !== undefined
        ? matrix[prevIdx][currentIdx]
        : estimateDriveMinutes(ordered[idx - 1], ordered[idx]);
  }
  return total;
}

function orderNearestNeighbor(jobs: JobDoc[]) {
  if (jobs.length <= 2) return jobs;

  const remaining = [...jobs];
  const avgLat =
    remaining.reduce((sum, job) => sum + Number(job.lat || 0), 0) /
    remaining.length;
  const avgLng =
    remaining.reduce((sum, job) => sum + Number(job.lng || 0), 0) /
    remaining.length;

  let currentIdx = remaining.reduce((bestIdx, job, idx) => {
    const best = remaining[bestIdx];
    const dist = haversineMiles(avgLat, avgLng, Number(job.lat), Number(job.lng));
    const bestDist = haversineMiles(
      avgLat,
      avgLng,
      Number(best.lat),
      Number(best.lng),
    );
    return dist < bestDist ? idx : bestIdx;
  }, 0);

  const ordered: JobDoc[] = [remaining.splice(currentIdx, 1)[0]];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    currentIdx = remaining.reduce((bestIdx, job, idx) => {
      const best = remaining[bestIdx];
      return estimateDriveMinutes(last, job) < estimateDriveMinutes(last, best)
        ? idx
        : bestIdx;
    }, 0);
    ordered.push(remaining.splice(currentIdx, 1)[0]);
  }

  return ordered;
}

function twoOptImprove(jobs: JobDoc[]) {
  if (jobs.length <= 3) return jobs;

  let best = [...jobs];
  let bestCost = routeDriveMinutes(best);
  let improved = true;
  let passes = 0;

  while (improved && passes < 40) {
    improved = false;
    passes++;

    for (let i = 1; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, j + 1).reverse(),
          ...best.slice(j + 1),
        ];
        const cost = routeDriveMinutes(candidate);
        if (cost + 0.01 < bestCost) {
          best = candidate;
          bestCost = cost;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }

  return best;
}

function orderNearestNeighborFrom(jobs: JobDoc[], startIdx: number) {
  if (jobs.length <= 2) return jobs;

  const remaining = [...jobs];
  const ordered: JobDoc[] = [remaining.splice(startIdx, 1)[0]];

  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    const currentIdx = remaining.reduce((bestIdx, job, idx) => {
      const best = remaining[bestIdx];
      return estimateDriveMinutes(last, job) < estimateDriveMinutes(last, best)
        ? idx
        : bestIdx;
    }, 0);
    ordered.push(remaining.splice(currentIdx, 1)[0]);
  }

  return ordered;
}

function orderRoute(jobs: JobDoc[]) {
  if (jobs.length <= 2) return jobs;

  const center = centroid(jobs);
  const starts = new Set<number>();
  const centroidStart = jobs.reduce((bestIdx, job, idx) => {
    const best = jobs[bestIdx];
    return distanceToCentroid(job, center) < distanceToCentroid(best, center)
      ? idx
      : bestIdx;
  }, 0);
  starts.add(centroidStart);

  if (jobs.length <= 22) {
    jobs.forEach((_, idx) => starts.add(idx));
  } else {
    starts.add(jobs.reduce((bestIdx, job, idx) => Number(job.lat) < Number(jobs[bestIdx].lat) ? idx : bestIdx, 0));
    starts.add(jobs.reduce((bestIdx, job, idx) => Number(job.lat) > Number(jobs[bestIdx].lat) ? idx : bestIdx, 0));
    starts.add(jobs.reduce((bestIdx, job, idx) => Number(job.lng) < Number(jobs[bestIdx].lng) ? idx : bestIdx, 0));
    starts.add(jobs.reduce((bestIdx, job, idx) => Number(job.lng) > Number(jobs[bestIdx].lng) ? idx : bestIdx, 0));
  }

  let bestRoute = twoOptImprove(orderNearestNeighbor(jobs));
  let bestCost = routeDriveMinutes(bestRoute);

  for (const startIdx of starts) {
    const candidate = twoOptImprove(orderNearestNeighborFrom(jobs, startIdx));
    const cost = routeDriveMinutes(candidate);
    if (cost + 0.01 < bestCost) {
      bestRoute = candidate;
      bestCost = cost;
    }
  }

  return bestRoute;
}

function centroid(jobs: JobDoc[]) {
  return {
    lat:
      jobs.reduce((sum, job) => sum + Number(job.lat || 0), 0) /
      Math.max(1, jobs.length),
    lng:
      jobs.reduce((sum, job) => sum + Number(job.lng || 0), 0) /
      Math.max(1, jobs.length),
  };
}

function distanceToCentroid(job: JobDoc, point: { lat: number; lng: number }) {
  return haversineMiles(Number(job.lat), Number(job.lng), point.lat, point.lng);
}

function routeSpreadMinutes(jobs: JobDoc[]) {
  const withCoords = jobs.filter(
    (job) => typeof job.lat === "number" && typeof job.lng === "number",
  );
  if (withCoords.length <= 1) return 0;

  const center = centroid(withCoords);
  const distances = withCoords.map((job) => distanceToCentroid(job, center) * 2);
  const avgDistance = distances.reduce((sum, distance) => sum + distance, 0) / distances.length;
  const maxDistance = Math.max(...distances);
  const minLat = Math.min(...withCoords.map((job) => Number(job.lat)));
  const maxLat = Math.max(...withCoords.map((job) => Number(job.lat)));
  const minLng = Math.min(...withCoords.map((job) => Number(job.lng)));
  const maxLng = Math.max(...withCoords.map((job) => Number(job.lng)));
  const diagonalMinutes = haversineMiles(minLat, minLng, maxLat, maxLng) * 2;

  return avgDistance * 1.8 + maxDistance * 1.2 + diagonalMinutes * 0.8;
}

function routeClusterCost(jobs: JobDoc[]) {
  if (jobs.length <= 1) return 0;
  return routeDriveMinutes(orderRoute(jobs)) + routeSpreadMinutes(jobs) * ROUTE_SPREAD_WEIGHT;
}

function assignmentCost(
  assignment: SlotAssignment,
  rangeStart: string,
  rangeEnd: string,
) {
  if (assignment.jobs.some((job) => !canScheduleJobOnDate(job, assignment.slot.date))) {
    return Number.POSITIVE_INFINITY;
  }
  const driveCost = routeClusterCost(assignment.jobs);
  const dateCost = assignment.jobs.reduce(
    (sum, job) => sum + dateAssignmentPenalty(job, assignment.slot.date, rangeStart, rangeEnd),
    0,
  );
  return driveCost + dateCost;
}

interface JobUnit {
  id: string;
  jobs: JobDoc[];
}

interface UnitAssignment {
  slot: RouteSlot;
  units: JobUnit[];
}

function unitJobs(units: JobUnit[]) {
  return units.flatMap((unit) => unit.jobs);
}

function unitStopCount(units: JobUnit[]) {
  return units.reduce((sum, unit) => sum + unit.jobs.length, 0);
}

function jobUnitId(jobs: JobDoc[]) {
  const key = routeAddressKey(jobs[0]);
  return key || jobs.map((job) => job.docId).join("|");
}

function buildSameAddressJobUnits(jobs: JobDoc[], rangeStart: string, rangeEnd: string) {
  const byAddress = new Map<string, JobDoc[]>();
  const singles: JobUnit[] = [];
  const prioritySort = jobPriorityComparator(rangeStart, rangeEnd);

  for (const job of jobs) {
    const key = routeAddressKey(job);
    if (!key) {
      singles.push({ id: job.docId, jobs: [job] });
      continue;
    }
    byAddress.set(key, [...(byAddress.get(key) || []), job]);
  }

  const units = [
    ...singles,
    ...Array.from(byAddress.values()).map((group) => ({
      id: jobUnitId(group),
      jobs: [...group].sort(prioritySort),
    })),
  ];

  return units.sort((a, b) => prioritySort(a.jobs[0], b.jobs[0]));
}

function canScheduleUnitOnDate(unit: JobUnit, slotDate: string) {
  return unit.jobs.every((job) => canScheduleJobOnDate(job, slotDate));
}

function unitAssignmentCost(
  unit: JobUnit,
  slotJobs: JobDoc[],
  slotDate: string,
  rangeStart: string,
  rangeEnd: string,
) {
  if (!canScheduleUnitOnDate(unit, slotDate)) return Number.POSITIVE_INFINITY;
  const datePenalty = unit.jobs.reduce(
    (sum, job) => sum + dateAssignmentPenalty(job, slotDate, rangeStart, rangeEnd),
    0,
  );
  if (slotJobs.length === 0) return datePenalty;

  const nearestStopCost = Math.min(
    ...unit.jobs.flatMap((job) =>
      slotJobs.map((existing) => estimateDriveMinutes(job, existing)),
    ),
  );
  const clusterCost = Math.max(
    0,
    (routeSpreadMinutes([...slotJobs, ...unit.jobs]) - routeSpreadMinutes(slotJobs)) *
      ROUTE_SPREAD_WEIGHT,
  );
  const balancePenalty = (slotJobs.length + unit.jobs.length) * 1.5;
  return datePenalty + clusterCost + nearestStopCost * 0.35 + balancePenalty;
}

function unitAssignmentToSlotAssignment(assignment: UnitAssignment): SlotAssignment {
  return {
    slot: assignment.slot,
    jobs: unitJobs(assignment.units),
  };
}

function unitAssignmentCostForSlot(
  assignment: UnitAssignment,
  rangeStart: string,
  rangeEnd: string,
) {
  return assignmentCost(unitAssignmentToSlotAssignment(assignment), rangeStart, rangeEnd);
}

function optimizeUnitAssignments(
  assignments: UnitAssignment[],
  maxStops: number,
  rangeStart: string,
  rangeEnd: string,
) {
  let optimized = assignments.map((assignment) => ({
    slot: assignment.slot,
    units: [...assignment.units],
  }));
  let costs = optimized.map((assignment) => unitAssignmentCostForSlot(assignment, rangeStart, rangeEnd));
  const totalJobs = optimized.reduce((sum, assignment) => sum + unitStopCount(assignment.units), 0);
  const maxPasses = totalJobs <= 120 ? 12 : totalJobs <= 240 ? 6 : 3;
  const maxEvaluations = totalJobs <= 120 ? 50000 : totalJobs <= 240 ? 25000 : 10000;

  for (let pass = 0; pass < maxPasses; pass++) {
    let best:
      | {
          delta: number;
          aIdx: number;
          bIdx: number;
          nextA: JobUnit[];
          nextB: JobUnit[];
          nextACost: number;
          nextBCost: number;
        }
      | null = null;
    let evaluations = 0;

    for (let aIdx = 0; aIdx < optimized.length; aIdx++) {
      for (let bIdx = aIdx + 1; bIdx < optimized.length; bIdx++) {
        const routeA = optimized[aIdx];
        const routeB = optimized[bIdx];
        const currentCost = costs[aIdx] + costs[bIdx];
        const routeAStopCount = unitStopCount(routeA.units);
        const routeBStopCount = unitStopCount(routeB.units);

        for (let i = 0; i < routeA.units.length; i++) {
          const movingA = routeA.units[i];
          if (
            routeBStopCount + movingA.jobs.length <= maxStops &&
            routeA.units.length > 1 &&
            canScheduleUnitOnDate(movingA, routeB.slot.date)
          ) {
            const nextAUnits = routeA.units.filter((_, idx) => idx !== i);
            const nextBUnits = [...routeB.units, movingA];
            const nextA = { slot: routeA.slot, units: nextAUnits };
            const nextB = { slot: routeB.slot, units: nextBUnits };
            const nextACost = unitAssignmentCostForSlot(nextA, rangeStart, rangeEnd);
            const nextBCost = unitAssignmentCostForSlot(nextB, rangeStart, rangeEnd);
            const delta = currentCost - nextACost - nextBCost;
            evaluations++;
            if (delta > (best?.delta ?? 0)) {
              best = { delta, aIdx, bIdx, nextA: nextAUnits, nextB: nextBUnits, nextACost, nextBCost };
            }
          }

          for (let j = 0; j < routeB.units.length; j++) {
            const movingB = routeB.units[j];
            if (
              routeAStopCount - movingA.jobs.length + movingB.jobs.length > maxStops ||
              routeBStopCount - movingB.jobs.length + movingA.jobs.length > maxStops ||
              !canScheduleUnitOnDate(movingB, routeA.slot.date) ||
              !canScheduleUnitOnDate(movingA, routeB.slot.date)
            ) {
              continue;
            }
            const nextAUnits = routeA.units.map((unit, idx) => (idx === i ? movingB : unit));
            const nextBUnits = routeB.units.map((unit, idx) => (idx === j ? movingA : unit));
            const nextA = { slot: routeA.slot, units: nextAUnits };
            const nextB = { slot: routeB.slot, units: nextBUnits };
            const nextACost = unitAssignmentCostForSlot(nextA, rangeStart, rangeEnd);
            const nextBCost = unitAssignmentCostForSlot(nextB, rangeStart, rangeEnd);
            const delta = currentCost - nextACost - nextBCost;
            evaluations++;
            if (delta > (best?.delta ?? 0)) {
              best = { delta, aIdx, bIdx, nextA: nextAUnits, nextB: nextBUnits, nextACost, nextBCost };
            }
            if (evaluations >= maxEvaluations) break;
          }
          if (evaluations >= maxEvaluations) break;
        }

        if (evaluations >= maxEvaluations) break;
      }
      if (evaluations >= maxEvaluations) break;
    }

    if (!best || best.delta < 0.25) break;
    optimized = optimized.map((assignment, idx) => {
      if (idx === best.aIdx) return { slot: assignment.slot, units: best.nextA };
      if (idx === best.bIdx) return { slot: assignment.slot, units: best.nextB };
      return assignment;
    });
    costs = costs.map((cost, idx) => {
      if (idx === best.aIdx) return best.nextACost;
      if (idx === best.bIdx) return best.nextBCost;
      return cost;
    });
  }

  return optimized;
}

function assignJobsToTechSlots({
  jobs,
  slots,
  maxStops,
  rangeStart,
  rangeEnd,
}: {
  jobs: JobDoc[];
  slots: RouteSlot[];
  maxStops: number;
  rangeStart: string;
  rangeEnd: string;
}) {
  const assignments: UnitAssignment[] = slots.map((slot) => ({ slot, units: [] }));
  const unassignedJobs: Array<{ job: JobDoc; reason: string }> = [];
  const sortedUnits = buildSameAddressJobUnits(jobs, rangeStart, rangeEnd);

  for (const unit of sortedUnits) {
    if (unit.jobs.length > maxStops) {
      unit.jobs.forEach((job) => {
        unassignedJobs.push({
          job,
          reason: `same-address bundle has ${unit.jobs.length} subscriptions, over the ${maxStops}-stop route limit`,
        });
      });
      continue;
    }
    const target = assignments
      .filter((assignment) =>
        unitStopCount(assignment.units) + unit.jobs.length <= maxStops &&
        canScheduleUnitOnDate(unit, assignment.slot.date),
      )
      .map((assignment) => ({
        assignment,
        cost: unitAssignmentCost(
          unit,
          unitJobs(assignment.units),
          assignment.slot.date,
          rangeStart,
          rangeEnd,
        ),
      }))
      .sort((a, b) => a.cost - b.cost)[0]?.assignment;
    if (target) {
      target.units.push(unit);
    } else {
      unit.jobs.forEach((job) => {
        const blockedDates = slots
          .map((slot) => `${slot.date}: ${jobScheduleBlockReason(job, slot.date)}`)
          .filter((entry) => !entry.endsWith(": "));
        unassignedJobs.push({
          job,
          reason: blockedDates.length > 0
            ? blockedDates.join("; ")
            : "no route capacity",
        });
      });
    }
  }

  return {
    assignments: optimizeUnitAssignments(assignments, maxStops, rangeStart, rangeEnd)
      .map(unitAssignmentToSlotAssignment),
    unassignedJobs,
  };
}

async function buildFastFallbackRoutes({
  jobsToRoute,
  selectedTechs,
  dates,
  maxStops,
  maxDriveTime,
  rangeStart,
  rangeEnd,
}: {
  jobsToRoute: JobDoc[];
  selectedTechs: Array<Record<string, unknown> & { id: string }>;
  dates: string[];
  maxStops: number;
  maxDriveTime: number;
  rangeStart: string;
  rangeEnd: string;
}): Promise<FastRouteBuildResult> {
  const routes: BackendRoute[] = [];
  const deferredJobIds = new Set<string>();
  const constraintDeferrals: Array<{ job: JobDoc; reason: string }> = [];
  const routeWarnings = new Set<string>();
  const matrixSources = new Set<string>();
  const polylineSources = new Set<string>();
  let slotIndex = 0;

  for (const tech of selectedTechs) {
    const techJobs = jobsToRoute.filter((job) => jobAssignedToTech(job, tech));
    if (techJobs.length === 0) {
      slotIndex += dates.length;
      continue;
    }

    const techSlots = dates.map((routeDate, dateIndex) => ({
      date: routeDate,
      tech,
      index: slotIndex + dateIndex,
    }));
    slotIndex += dates.length;

    const assignmentResult = assignJobsToTechSlots({
      jobs: techJobs,
      slots: techSlots,
      maxStops,
      rangeStart,
      rangeEnd,
    });
    const assignments = assignmentResult.assignments;
    assignmentResult.unassignedJobs.forEach((entry) => {
      deferredJobIds.add(entry.job.docId);
      constraintDeferrals.push(entry);
    });

    for (const assignment of assignments) {
      const slot = assignment.slot;
      const picked = assignment.jobs;
      if (picked.length === 0) continue;

      const matrixResult = await getDriveMatrix(picked, slot.date);
      matrixSources.add(matrixResult.source);
      matrixResult.warnings.forEach((warning) => routeWarnings.add(warning));
      const orderedResult = orderRouteWithMatrix(picked, matrixResult.matrix);
      const matrixById = new Map<string, number>();
      picked.forEach((job, idx) => matrixById.set(job.docId, idx));
      const ordered = keepSameAddressJobsTogether(orderedResult.ordered);
      const orderedMatrixDriveMinutes = orderedDriveMinutesFromMatrix(
        ordered,
        matrixById,
        matrixResult.matrix,
      );
      const geometryResult = await computeRouteGeometry(ordered, { routeDate: slot.date });
      polylineSources.add(geometryResult.polylineSource);
      geometryResult.warnings.forEach((warning) => routeWarnings.add(warning));
      const totalDriveMinutes =
        geometryResult.driveTimeSource === "routes_api_polyline"
          ? geometryResult.driveMinutes
          : orderedMatrixDriveMinutes;
      const driveTimeSource =
        geometryResult.driveTimeSource === "routes_api_polyline"
          ? geometryResult.driveTimeSource
          : matrixResult.source;

      const stops = ordered.map((job, idx) => {
        const stop: BackendStop = {
          id: job.docId,
          customerID: job.docId,
          subscriptionID: String(job.subscriptionId || job.subscriptionID || job.docId),
          sequence: idx + 1,
          duration: Number(job.duration || 25),
          lat: job.lat,
          lng: job.lng,
          customerName: String(job.customerName || ""),
          address: String(job.address || ""),
          serviceType: String(job.serviceType || ""),
          serviceDue: String(job.scheduledDate || slot.date),
          recurringFrequency: String(job.recurringFrequency || ""),
          billingFrequency: String(job.billingFrequency || ""),
          subscriptionLastServiced: String(job.subscriptionLastServiced || ""),
        };
        if (idx > 0) {
          const prevIdx = matrixById.get(ordered[idx - 1].docId);
          const currentIdx = matrixById.get(job.docId);
          const legMinutes =
            prevIdx !== undefined && currentIdx !== undefined
              ? matrixResult.matrix[prevIdx][currentIdx]
              : estimateDriveMinutes(ordered[idx - 1], job);
          stop.driveMinutesFromPrev = Math.round(legMinutes * 10) / 10;
        }
        return stop;
      });

      const totalServiceMinutes = ordered.reduce(
        (sum, job) => sum + Number(job.duration || 25),
        0,
      );

      routes.push({
        routeName: `${String(slot.tech.name || "Route")} ${slot.date}`,
        routeIndex: slot.index,
        totalDriveMinutes: Math.round(totalDriveMinutes * 10) / 10,
        totalServiceMinutes,
        totalWorkMinutes:
          Math.round((totalDriveMinutes + totalServiceMinutes) * 10) / 10,
        stops,
        date: slot.date,
        techId: slot.tech.id,
        techName: String(slot.tech.name || slot.tech.id),
        driveTimeSource,
        polylineSource: geometryResult.polylineSource,
        polylineStatus: geometryResult.status,
        failedRouteSegments: geometryResult.failedSegments,
        encodedPolyline:
          geometryResult.polylineSource === "routes_api_polyline"
            ? geometryResult.encodedPolyline
            : "",
        routePolyline:
          geometryResult.polylineSource === "routes_api_polyline"
            ? geometryResult.path
            : [],
        overDriveCap: maxDriveTime > 0 && totalDriveMinutes > maxDriveTime,
      });
    }
  }

  const warnings = [
    ...Array.from(routeWarnings),
    ...(constraintDeferrals.length > 0
      ? [
          `${constraintDeferrals.length} job(s) deferred because scheduling notes or route capacity block the available dates. Example: ${String(constraintDeferrals[0].job.customerName || constraintDeferrals[0].job.docId)} (${constraintDeferrals[0].reason}).`,
        ]
      : []),
  ];

  return {
    routes,
    deferredJobIds: Array.from(deferredJobIds),
    warnings,
    usedMatrixSources: Array.from(matrixSources),
    usedPolylineSources: Array.from(polylineSources),
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      companyId,
      startDate,
      endDate,
      date,
      techIds,
      maxStops: rawMaxStops,
      maxDriveTime: rawMaxDriveTime,
      runSettings,
    } = body as {
      companyId: string;
      startDate?: string;
      endDate?: string;
      date?: string;
      techIds?: string[];
      maxStops?: number;
      maxDriveTime?: number;
      runSettings?: Record<string, unknown>;
    };

    if (!companyId) {
      return NextResponse.json(
        { error: "companyId is required" },
        { status: 400 },
      );
    }

    const rangeStart = startDate || date || "";
    const rangeEnd = endDate || date || "";

    if (!rangeStart || !rangeEnd) {
      return NextResponse.json(
        { error: "startDate and endDate (or date) are required" },
        { status: 400 },
      );
    }

    const maxStops =
      Number.isFinite(rawMaxStops) && (rawMaxStops as number) > 0
        ? Math.min(30, Math.floor(rawMaxStops as number))
        : DEFAULT_MAX_STOPS;

    const maxDriveTime =
      Number.isFinite(rawMaxDriveTime) && (rawMaxDriveTime as number) > 0
        ? Math.min(600, Math.floor(rawMaxDriveTime as number))
        : DEFAULT_MAX_DRIVE_MINUTES;

    if (!BACKEND_URL) {
      return NextResponse.json(
        {
          error:
            "Routing backend not configured. Set BACKEND_URL and run the Python service.",
        },
        { status: 503 },
      );
    }

    const db = adminDb();

    // --- Generation lock (2 min timeout, auto-cleanup) ---
    const lockRef = db.doc(`routeGeneration/${companyId}`);
    const lockSnap = await lockRef.get();
    if (lockSnap.exists) {
      const lockData = lockSnap.data();
      const lockTime = new Date(lockData?.startedAt || 0).getTime();
      if (Date.now() - lockTime < 2 * 60 * 1000) {
        return NextResponse.json(
          {
            error:
              "Another route generation is in progress. Please wait and try again.",
          },
          { status: 409 },
        );
      }
      await lockRef.delete();
    }
    await lockRef.set({ startedAt: new Date().toISOString(), companyId });

    // --- 1. Fetch selected technicians ---
    const techDocs = await db
      .collection(`companies/${companyId}/technicians`)
      .where("active", "==", true)
      .get();
    const allTechs = techDocs.docs.map((d) => ({ id: d.id, ...d.data() }));
    const selectedTechs =
      techIds && techIds.length > 0
        ? allTechs.filter((t) => techIds.includes(t.id))
        : allTechs;

    if (selectedTechs.length === 0) {
      await lockRef.delete().catch(() => {});
      return NextResponse.json(
        { success: false, error: "No active technicians selected" },
        { status: 400 },
      );
    }

    // --- 2. Stage existing unapproved routes in this range for selected techs ---
    const selectedTechIdSet = new Set(selectedTechs.map((t) => t.id));
    const releasedJobIds = new Set<string>();
    const generatedAssignmentByJobId = new Map<
      string,
      { techId: string; createdAt: string }
    >();
    const existingRoutesSnap = await db
      .collection(`companies/${companyId}/routes`)
      .where("date", ">=", rangeStart)
      .where("date", "<=", rangeEnd)
      .get();
    const routeDocsToReplace: typeof existingRoutesSnap.docs = [];

    for (const routeDoc of existingRoutesSnap.docs) {
      const route = routeDoc.data();
      if (route.approved) continue;
      if (!selectedTechIdSet.has(String(route.techId || ""))) continue;

      routeDocsToReplace.push(routeDoc);
      const stopSequence = Array.isArray(route.stopSequence)
        ? route.stopSequence
        : [];
      stopSequence.forEach((id) => {
        if (!id) return;
        const jobId = String(id);
        releasedJobIds.add(jobId);
        generatedAssignmentByJobId.set(jobId, {
          techId: String(route.techId || ""),
          createdAt: String(route.createdAt || route.updatedAt || ""),
        });
      });
    }
    const replacedRouteCount = routeDocsToReplace.length;

    // --- 3. Fetch pending jobs for selected techs ---
    const isGeneratedRouteAssignment = (d: JobDoc) => {
      const generated = generatedAssignmentByJobId.get(d.docId);
      if (!generated) return false;
      return (
        String(d.assignedTechId || "").trim() === generated.techId &&
        String(d.updatedAt || "") === generated.createdAt
      );
    };

    const isJobForSelectedTech = (d: JobDoc) => {
      if (isGeneratedRouteAssignment(d)) return false;
      return selectedTechs.some((tech) => jobAssignedToTech(d, tech));
    };

    const allPendingSnap = await db
      .collection(`companies/${companyId}/jobs`)
      .where("status", "==", "pending")
      .get();

    const jobDocMap = new Map<string, JobDoc>();
    const releasedJobDocMap = new Map<string, JobDoc>();
    allPendingSnap.docs.forEach((doc) => {
      const jobDoc = { docId: doc.id, ...doc.data() } as JobDoc;
      if (isJobForSelectedTech(jobDoc)) jobDocMap.set(doc.id, jobDoc);
    });

    const releasedJobIdList = Array.from(releasedJobIds);
    for (let i = 0; i < releasedJobIdList.length; i += 300) {
      const refs = releasedJobIdList
        .slice(i, i + 300)
        .map((jobId) => db.doc(`companies/${companyId}/jobs/${jobId}`));
      if (refs.length === 0) continue;
      const snaps = await db.getAll(...refs);
      snaps.forEach((snap) => {
        if (!snap.exists) return;
        const jobDoc = { docId: snap.id, ...snap.data() } as JobDoc;
        releasedJobDocMap.set(snap.id, jobDoc);
        if (isJobForSelectedTech(jobDoc)) jobDocMap.set(snap.id, jobDoc);
      });
    }

    const allJobDocs = Array.from(jobDocMap.values());

    if (allJobDocs.length === 0) {
      await lockRef.delete().catch(() => {});
      if (routeDocsToReplace.length > 0) {
        const now = new Date().toISOString();
        let cleanupBatch = db.batch();
        let cleanupOps = 0;

        for (const routeDoc of routeDocsToReplace) {
          cleanupBatch.delete(routeDoc.ref);
          cleanupOps++;
          if (cleanupOps >= 450) {
            await cleanupBatch.commit();
            cleanupBatch = db.batch();
            cleanupOps = 0;
          }
        }

        for (const jobId of Array.from(releasedJobIds)) {
          const releasedJobDoc = releasedJobDocMap.get(jobId);
          if (!releasedJobDoc) continue;
          const jobRef = db.doc(`companies/${companyId}/jobs/${jobId}`);
          cleanupBatch.update(jobRef, {
            status: "pending",
            ...(isGeneratedRouteAssignment(releasedJobDoc)
              ? { assignedTechId: "" }
              : {}),
            updatedAt: now,
          });
          cleanupOps++;
          if (cleanupOps >= 450) {
            await cleanupBatch.commit();
            cleanupBatch = db.batch();
            cleanupOps = 0;
          }
        }

        if (cleanupOps > 0) {
          await cleanupBatch.commit();
        }

        return NextResponse.json({
          success: true,
          routeCount: 0,
          stopCount: 0,
          warnings: [
            `Removed ${routeDocsToReplace.length} unapproved route(s) for the selected technician/date range.`,
            "No pending jobs are assigned to the selected technician(s).",
          ],
        });
      }

      return NextResponse.json(
        {
          success: false,
          error: "No pending jobs assigned to the selected technician(s)",
        },
        { status: 404 },
      );
    }

    // --- 4. Tiered selection: overdue → in-window → future → no-date.
    // scheduledDate is normalized to YYYY-MM-DD, so lexicographic sort equals chronological sort.
    const overdue: JobDoc[] = [];
    const inWindow: JobDoc[] = [];
    const future: JobDoc[] = [];
    const noDate: JobDoc[] = [];

    for (const j of allJobDocs) {
      const sd = String(j.scheduledDate || "");
      if (!sd) {
        noDate.push(j);
        continue;
      }
      if (sd < rangeStart) overdue.push(j);
      else if (sd <= rangeEnd) inWindow.push(j);
      else future.push(j);
    }

    const numDays = _daysBetween(rangeStart, rangeEnd);
    const totalSlots = selectedTechs.length * numDays;
    const capacity = Math.min(JOB_CAP, totalSlots * maxStops);
    const perTechCapacity = numDays * maxStops;
    const prioritySort = jobPriorityComparator(rangeStart, rangeEnd);

    const selectedByTech = new Map<string, JobDoc[]>();
    const deferredByTech = new Map<string, JobDoc[]>();
    for (const tech of selectedTechs) {
      const techJobs = allJobDocs
        .filter((job) => jobAssignedToTech(job, tech))
        .sort(prioritySort);
      selectedByTech.set(tech.id, techJobs.slice(0, perTechCapacity));
      deferredByTech.set(tech.id, techJobs.slice(perTechCapacity));
    }

    let jobsToRoute = selectedTechs.flatMap((tech) => selectedByTech.get(tech.id) || []);
    let capacityDeferred = selectedTechs.flatMap((tech) => deferredByTech.get(tech.id) || []);
    if (jobsToRoute.length > capacity) {
      jobsToRoute = jobsToRoute.sort(prioritySort);
      capacityDeferred = [...jobsToRoute.slice(capacity), ...capacityDeferred];
      jobsToRoute = jobsToRoute.slice(0, capacity);
    }
    jobsToRoute = expandSameAddressBundlesForSelection({
      selectedJobs: jobsToRoute,
      allJobs: allJobDocs,
      selectedTechs,
      rangeEnd,
    }).sort(prioritySort);
    const jobsToRouteIds = new Set(jobsToRoute.map((job) => job.docId));
    capacityDeferred = capacityDeferred.filter((job) => !jobsToRouteIds.has(job.docId));
    const jobsDeferred = capacityDeferred.length;

    const selectedOverdueCount = jobsToRoute.filter((j) => {
      const sd = String(j.scheduledDate || "");
      return sd && sd < rangeStart;
    }).length;
    const selectedInWindowCount = jobsToRoute.filter((j) => {
      const sd = String(j.scheduledDate || "");
      return sd && sd >= rangeStart && sd <= rangeEnd;
    }).length;
    const selectedFutureCount = jobsToRoute.filter((j) => {
      const sd = String(j.scheduledDate || "");
      return sd && sd > rangeEnd;
    }).length;

    console.log(
      "ROUTE DEBUG:",
      JSON.stringify({
        poolTotal: allJobDocs.length,
        tierTotals: {
          overdue: overdue.length,
          inWindow: inWindow.length,
          future: future.length,
          noDate: noDate.length,
        },
        selected: {
          overdue: selectedOverdueCount,
          inWindow: selectedInWindowCount,
          future: selectedFutureCount,
          noDate: jobsToRoute.length
            - selectedOverdueCount
            - selectedInWindowCount
            - selectedFutureCount,
        },
        capacity,
        deferred: jobsDeferred,
        params: { maxStops, maxDriveTime, numDays, numTechs: selectedTechs.length },
      }),
    );

    // --- 5. Build backend payload.
    // Use docId as customerID so the backend's echoed customerID maps 1:1 to Firestore docs.
    const jobs = jobsToRoute.map((d) => ({
      id: d.docId,
      customerID: d.docId,
      subscriptionID: String(d.subscriptionId || d.subscriptionID || d.docId),
      address: String(d.address || ""),
      lat: d.lat ?? null,
      lng: d.lng ?? null,
      serviceDue: String(d.scheduledDate || rangeStart),
      schedulingRequest: String(d.schedulingRequest || ""),
      duration: Number(d.duration || 25),
      serviceType: String(d.serviceType || ""),
      customerName: String(d.customerName || ""),
      recurringFrequency: String(d.recurringFrequency || ""),
      billingFrequency: String(d.billingFrequency || ""),
      subscriptionLastServiced: String(d.subscriptionLastServiced || ""),
    }));

    const dates: string[] = [];
    for (let d = 0; d < numDays; d++) {
      dates.push(_dateOffset(rangeStart, d));
    }

    // --- 6. Call Python routing backend ---
    const mergedSettings: Record<string, unknown> = {
      ...runSettings,
      maxStopsPerRoute: maxStops,
      maxDriveMinutesPerRoute: maxDriveTime,
      numRoutes: totalSlots,
    };

    let result: {
      runId?: string;
      routes?: BackendRoute[];
      warnings?: string[];
      summary?: Record<string, unknown>;
      deferredJobIds?: string[];
    };

    const shouldUseCustomRouting = true;
    if (shouldUseCustomRouting) {
      const fastResult = await buildFastFallbackRoutes({
        jobsToRoute,
        selectedTechs,
        dates,
        maxStops,
        maxDriveTime,
        rangeStart,
        rangeEnd,
      });
      result = {
        runId: `fast-${Date.now()}`,
        routes: fastResult.routes,
        deferredJobIds: fastResult.deferredJobIds,
        warnings: [
          hasGoogleRoutesApiKey()
            ? "Used hard tech/date route generation with Routes API matrix drive times and road polylines where available."
            : "Used hard tech/date route generation. Add GOOGLE_MAPS_API_KEY for Routes API road drive times and polylines.",
          ...fastResult.warnings,
        ],
        summary: {
          driveTimeSource: fastResult.usedMatrixSources.join(",") || "haversine_fallback",
          polylineSource: fastResult.usedPolylineSources.join(",") || "haversine_fallback",
          jobsRequested: jobsToRoute.length,
        },
      };
    } else {
      const backendRes = await fetch(`${BACKEND_URL}/routeiq/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobs, companyId, runSettings: mergedSettings }),
        signal: AbortSignal.timeout(120000),
      });

      if (!backendRes.ok) {
        const text = await backendRes.text();
        const fastResult = await buildFastFallbackRoutes({
          jobsToRoute,
          selectedTechs,
          dates,
          maxStops,
          maxDriveTime,
          rangeStart,
          rangeEnd,
        });
        result = {
          runId: `fast-${Date.now()}`,
          routes: fastResult.routes,
          deferredJobIds: fastResult.deferredJobIds,
          warnings: [
            `Routing engine returned ${backendRes.status}; used fast route generation instead.`,
            ...fastResult.warnings,
            text.slice(0, 300),
          ].filter(Boolean),
          summary: {
            driveTimeSource: fastResult.usedMatrixSources.join(",") || "haversine_fallback",
            polylineSource: fastResult.usedPolylineSources.join(",") || "haversine_fallback",
            jobsRequested: jobsToRoute.length,
          },
        };
      } else {
        result = (await backendRes.json()) as typeof result;
      }
    }

    const routes = result.routes || [];

    if (routes.length === 0) {
      await lockRef.delete().catch(() => {});
      return NextResponse.json({
        success: true,
        runId: result.runId,
        routeCount: 0,
        stopCount: 0,
        tiers: {
          overdueAvailable: overdue.length,
          inWindowAvailable: inWindow.length,
          futureAvailable: future.length,
          overdueSelected: selectedOverdueCount,
          inWindowSelected: selectedInWindowCount,
          futureSelected: selectedFutureCount,
        },
        warnings: result.warnings || [
          "No routes generated — check if jobs have valid coordinates",
        ],
      });
    }

    const shadowVehicleSlots = selectedTechs.flatMap((tech) =>
      dates.map((routeDate) => ({ date: routeDate, tech })),
    );
    let routeOptimizationShadow: RouteOptimizationShadowResult = {
      status: "disabled",
      runId: `shadow-${result.runId || Date.now()}`,
      routeCount: routes.length,
      warnings: [],
    };

    try {
      routeOptimizationShadow = await runRouteOptimizationShadow({
        runId: `shadow-${result.runId || Date.now()}`,
        jobs: jobsToRoute.map((job) => ({
          id: job.docId,
          lat: typeof job.lat === "number" ? job.lat : null,
          lng: typeof job.lng === "number" ? job.lng : null,
          duration: Number(job.duration || 25),
          assignedTechId: String(job.assignedTechId || ""),
          allowedVehicleIndices: shadowVehicleSlots
            .map((slot, index) =>
              jobAssignedToTech(job, slot.tech) && canScheduleJobOnDate(job, slot.date)
                ? index
                : -1,
            )
            .filter((index) => index >= 0),
        })) satisfies RoutePoint[],
        vehicles: shadowVehicleSlots.map((slot) => ({
          date: slot.date,
          techId: slot.tech.id,
          techName: String((slot.tech as Record<string, unknown>).name || slot.tech.id),
          maxStops,
        })),
        customRoutes: routes.map((route, index) => ({
          id: String(route.routeName || index),
          date: String(route.date || ""),
          techId: String(route.techId || ""),
          techName: String(route.techName || ""),
          totalDriveMinutes: Number(route.totalDriveMinutes || 0),
          totalWorkMinutes: Number(route.totalWorkMinutes || 0),
          stops: (route.stops || []).map((stop) => ({
            id: String(stop.id || stop.customerID || ""),
            lat: typeof stop.lat === "number" ? stop.lat : null,
            lng: typeof stop.lng === "number" ? stop.lng : null,
            duration: typeof stop.duration === "number" ? stop.duration : null,
          })),
        })),
        maxStops,
        maxDriveMinutes: maxDriveTime,
      });
    } catch (error) {
      routeOptimizationShadow = {
        status: "failed",
        runId: `shadow-${result.runId || Date.now()}`,
        routeCount: routes.length,
        warnings: [
          `Route Optimization shadow mode failed. ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }

    // --- 7. Save routes + mark jobs scheduled ---
    const now = new Date().toISOString();
    const scheduledJobIds = new Set<string>();
    const routeWrites: Array<{
      routeRef: typeof lockRef;
      data: Record<string, unknown>;
    }> = [];

    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      const stops = route.stops || [];

      const dayIndex = Math.floor(i / selectedTechs.length) % numDays;
      const techIndex = i % selectedTechs.length;
      const routeDate = String(route.date || dates[dayIndex]);
      const tech = selectedTechs[techIndex];
      const techId = String(route.techId || tech?.id || `route-${i}`);
      const techName =
        route.techName ||
        (tech as Record<string, unknown>)?.name ||
        route.routeName ||
        `Route ${i + 1}`;

      const stopIds = stops.map((s) => String(s.id || s.customerID || ""));
      stopIds.forEach((id) => {
        if (!id) return;
        scheduledJobIds.add(id);
      });

      const routeRef = db
        .collection(`companies/${companyId}/routes`)
        .doc(`${routeDate}-${techId}-${i}`);

      routeWrites.push({
        routeRef,
        data: {
          date: routeDate,
          techId,
          techName,
          stopSequence: stopIds,
          totalStops: stops.length,
          totalDriveTimeMinutes: Math.round(
            Number(route.totalDriveMinutes) || 0,
          ),
          totalWorkMinutes: Math.round(
            Number(route.totalWorkMinutes) ||
              Number(route.totalDriveMinutes) ||
              0,
          ),
          totalServiceMinutes: Math.round(Number(route.totalServiceMinutes) || 0),
          driveTimeSource: String(route.driveTimeSource || "haversine_fallback"),
          polylineSource: String(route.polylineSource || "haversine_fallback"),
          encodedPolyline: String(route.encodedPolyline || ""),
          routePolyline: Array.isArray(route.routePolyline) ? route.routePolyline : [],
          polylineStatus: String(route.polylineStatus || ""),
          failedRouteSegments: Number(route.failedRouteSegments || 0),
          googleRouteOptimizationRunId: routeOptimizationShadow.runId || "",
          ...(typeof routeOptimizationShadow.score === "number"
            ? { googleRouteOptimizationShadowScore: routeOptimizationShadow.score }
            : {}),
          googleRouteOptimizationSummary: {
            status: routeOptimizationShadow.status,
            score: routeOptimizationShadow.score ?? null,
            googleDriveMinutes: routeOptimizationShadow.googleDriveMinutes ?? null,
            customDriveMinutes: routeOptimizationShadow.customDriveMinutes ?? null,
            routeCount: routeOptimizationShadow.routeCount ?? routes.length,
            rawStatus: routeOptimizationShadow.rawStatus || "",
            warnings: routeOptimizationShadow.warnings,
          },
          maxStopsParam: maxStops,
          maxDriveTimeParam: maxDriveTime,
          confidence: 0.85,
          generatedBy: "ai",
          approved: false,
          stops,
          companyId,
          createdAt: now,
          updatedAt: now,
        },
      });
    }

    const routeWritePaths = new Set(
      routeWrites.map((write) => write.routeRef.path),
    );
    let batch = db.batch();
    let batchOps = 0;

    for (const routeDoc of routeDocsToReplace) {
      if (routeWritePaths.has(routeDoc.ref.path)) continue;
      batch.delete(routeDoc.ref);
      batchOps++;

      if (batchOps >= 450) {
        await batch.commit();
        batch = db.batch();
        batchOps = 0;
      }
    }

    for (const write of routeWrites) {
      batch.set(write.routeRef, write.data);
      batchOps++;

      if (batchOps >= 450) {
        await batch.commit();
        batch = db.batch();
        batchOps = 0;
      }
    }

    for (const jobId of Array.from(releasedJobIds)) {
      if (scheduledJobIds.has(jobId)) continue;
      const jobRef = db.doc(`companies/${companyId}/jobs/${jobId}`);
      const releasedJobDoc = releasedJobDocMap.get(jobId);
      batch.update(jobRef, {
        status: "pending",
        ...(releasedJobDoc && isGeneratedRouteAssignment(releasedJobDoc)
          ? { assignedTechId: "" }
          : {}),
        updatedAt: now,
      });
      batchOps++;
      if (batchOps >= 450) {
        await batch.commit();
        batch = db.batch();
        batchOps = 0;
      }
    }

    for (const jobId of Array.from(scheduledJobIds)) {
      const jobRef = db.doc(`companies/${companyId}/jobs/${jobId}`);
      batch.update(jobRef, {
        status: "scheduled",
        updatedAt: now,
      });
      batchOps++;
      if (batchOps >= 450) {
        await batch.commit();
        batch = db.batch();
        batchOps = 0;
      }
    }

    if (batchOps > 0) {
      await batch.commit();
    }

    await lockRef.delete().catch(() => {});

    const backendDeferred = new Set(result.deferredJobIds || []);
    const totalDeferred = jobsDeferred + backendDeferred.size;

    return NextResponse.json({
      success: true,
      runId: result.runId,
      routeCount: routes.length,
      stopCount: scheduledJobIds.size,
      jobsInPool: allJobDocs.length,
      tiers: {
        overdueAvailable: overdue.length,
        inWindowAvailable: inWindow.length,
        futureAvailable: future.length,
        overdueSelected: selectedOverdueCount,
        inWindowSelected: selectedInWindowCount,
        futureSelected: selectedFutureCount,
      },
      params: { maxStops, maxDriveTime },
      deferredCount: totalDeferred,
      warnings: [
        ...(replacedRouteCount > 0
          ? [
              `Replaced ${replacedRouteCount} existing unapproved route(s) in this date range.`,
            ]
          : []),
        ...(result.warnings || []),
        ...(jobsDeferred > 0
          ? [
              `${jobsDeferred} job(s) deferred — capacity limit reached. Re-generate to include them.`,
            ]
          : []),
        ...(backendDeferred.size > 0
          ? [
              `${backendDeferred.size} stop(s) dropped to stay within ${maxDriveTime}-min drive-time cap.`,
            ]
          : []),
        ...(routeOptimizationShadow.status === "failed"
          ? routeOptimizationShadow.warnings
          : []),
      ],
      summary: {
        ...(result.summary || {}),
        googleRouteOptimizationShadow: routeOptimizationShadow,
      },
    });
  } catch (error) {
    try {
      const cleanupDb = adminDb();
      const body2 = await request
        .clone()
        .json()
        .catch(() => ({}) as { companyId?: string });
      if (body2.companyId)
        await cleanupDb.doc(`routeGeneration/${body2.companyId}`).delete();
    } catch {
      // best effort
    }

    console.error("Generate routes API error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to generate routes",
      },
      { status: 500 },
    );
  }
}
