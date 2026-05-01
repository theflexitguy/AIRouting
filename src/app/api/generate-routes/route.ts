export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

const BACKEND_URL =
  process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || "";

const DEFAULT_MAX_STOPS = 16;
const DEFAULT_MAX_DRIVE_MINUTES = 240;
const JOB_CAP = 500;

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

interface JobDoc {
  docId: string;
  customerId?: string;
  customerID?: string;
  customerName?: string;
  address?: string;
  lat?: number | null;
  lng?: number | null;
  scheduledDate?: string;
  serviceType?: string;
  schedulingRequest?: string;
  duration?: number;
  subscriptionId?: string;
  subscriptionID?: string;
  assignedTechId?: string;
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
  totalWorkMinutes?: number;
  routeName?: string;
  [key: string]: unknown;
}

interface RouteSlot {
  date: string;
  tech: Record<string, unknown> & { id: string };
  index: number;
}

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

function clusterJobsForRoutes(
  jobs: JobDoc[],
  routeCount: number,
  maxStops: number,
) {
  if (jobs.length === 0) return [];
  if (routeCount <= 1) return [jobs.slice(0, maxStops)];

  const allCenter = centroid(jobs);
  const seeds: JobDoc[] = [];
  const firstSeed = jobs.reduce(
    (best, job) =>
      distanceToCentroid(job, allCenter) > distanceToCentroid(best, allCenter)
        ? job
        : best,
    jobs[0],
  );
  seeds.push(firstSeed);

  while (seeds.length < routeCount) {
    const nextSeed = jobs.reduce((best, job) => {
      if (seeds.includes(job)) return best;
      const nearestSeedDistance = Math.min(
        ...seeds.map((seed) => estimateDriveMinutes(job, seed)),
      );
      const bestDistance = seeds.includes(best)
        ? -1
        : Math.min(...seeds.map((seed) => estimateDriveMinutes(best, seed)));
      return nearestSeedDistance > bestDistance ? job : best;
    }, jobs[0]);
    if (seeds.includes(nextSeed)) break;
    seeds.push(nextSeed);
  }

  const clusterCount = seeds.length;
  const baseSize = Math.floor(jobs.length / clusterCount);
  const extra = jobs.length % clusterCount;
  const clusters = seeds.map((seed, index) => ({
    seed,
    targetSize: Math.min(maxStops, baseSize + (index < extra ? 1 : 0)),
    jobs: [] as JobDoc[],
  }));

  const assignmentOrder = [...jobs].sort((a, b) => {
    const aDistances = seeds
      .map((seed) => estimateDriveMinutes(a, seed))
      .sort((x, y) => x - y);
    const bDistances = seeds
      .map((seed) => estimateDriveMinutes(b, seed))
      .sort((x, y) => x - y);
    const aGap = (aDistances[1] ?? aDistances[0] ?? 0) - (aDistances[0] ?? 0);
    const bGap = (bDistances[1] ?? bDistances[0] ?? 0) - (bDistances[0] ?? 0);
    return bGap - aGap;
  });

  for (const job of assignmentOrder) {
    const candidates = clusters
      .filter((cluster) => cluster.jobs.length < cluster.targetSize)
      .sort(
        (a, b) =>
          estimateDriveMinutes(job, a.seed) - estimateDriveMinutes(job, b.seed),
      );
    const target =
      candidates[0] || clusters.find((c) => c.jobs.length < maxStops);
    if (target) target.jobs.push(job);
  }

  return clusters
    .map((cluster) => cluster.jobs)
    .filter((clusterJobs) => clusterJobs.length > 0)
    .sort((a, b) => {
      const ca = centroid(a);
      const cb = centroid(b);
      return ca.lng === cb.lng ? cb.lat - ca.lat : ca.lng - cb.lng;
    });
}

function buildFastFallbackRoutes({
  jobsToRoute,
  selectedTechs,
  dates,
  maxStops,
  maxDriveTime,
}: {
  jobsToRoute: JobDoc[];
  selectedTechs: Array<Record<string, unknown> & { id: string }>;
  dates: string[];
  maxStops: number;
  maxDriveTime: number;
}): BackendRoute[] {
  const slots: RouteSlot[] = [];
  for (const date of dates) {
    for (const tech of selectedTechs) {
      slots.push({ date, tech, index: slots.length });
    }
  }

  const neededRoutes = Math.max(1, Math.ceil(jobsToRoute.length / maxStops));
  const routeCount = Math.min(slots.length, neededRoutes);
  const clusters = clusterJobsForRoutes(jobsToRoute, routeCount, maxStops);
  const routes: BackendRoute[] = [];

  clusters.forEach((picked, index) => {
    const slot = slots[index];
    if (!slot) return;
    if (picked.length === 0) return;

    const ordered = twoOptImprove(orderNearestNeighbor(picked));
    const totalDriveMinutes = routeDriveMinutes(ordered);

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
      };
      if (idx > 0) {
        stop.driveMinutesFromPrev = Math.round(
          estimateDriveMinutes(ordered[idx - 1], job) * 10,
        ) / 10;
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
      driveTimeSource: "fast_estimate",
      overDriveCap: maxDriveTime > 0 && totalDriveMinutes > maxDriveTime,
    });
  });

  return routes;
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
        if (id) releasedJobIds.add(String(id));
      });
    }
    const replacedRouteCount = routeDocsToReplace.length;

    // --- 3. Fetch pending jobs for selected techs (or unassigned) ---
    const selectedTechNameSet = new Set(
      selectedTechs
        .map((t) =>
          String((t as Record<string, unknown>).name || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    );
    const normalizeName = (s: string) =>
      s
        .toLowerCase()
        .replace(/['"]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const selectedTechNamesNormalized = new Set(
      Array.from(selectedTechNameSet).map(normalizeName),
    );

    const isJobForSelectedTech = (d: JobDoc) => {
      const val = String(d.assignedTechId || "").trim();
      if (!val) return true; // include unassigned
      return (
        selectedTechIdSet.has(val) ||
        selectedTechNameSet.has(val.toLowerCase()) ||
        selectedTechNamesNormalized.has(normalizeName(val))
      );
    };

    const allPendingSnap = await db
      .collection(`companies/${companyId}/jobs`)
      .where("status", "==", "pending")
      .get();

    const jobDocMap = new Map<string, JobDoc>();
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
        if (isJobForSelectedTech(jobDoc)) jobDocMap.set(snap.id, jobDoc);
      });
    }

    const allJobDocs = Array.from(jobDocMap.values());

    if (allJobDocs.length === 0) {
      await lockRef.delete().catch(() => {});
      return NextResponse.json(
        {
          success: false,
          error: "No pending jobs for the selected technician(s)",
        },
        { status: 404 },
      );
    }

    // --- 3. Tiered selection: overdue → in-window → future ---
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

    const byDateAsc = (a: JobDoc, b: JobDoc) =>
      String(a.scheduledDate || "").localeCompare(String(b.scheduledDate || ""));
    overdue.sort(byDateAsc);
    inWindow.sort(byDateAsc);
    future.sort(byDateAsc);

    // Tier order: in-window first for the date range the user explicitly chose,
    // then overdue/future/no-date only if there is leftover capacity.
    const tieredPool = [...inWindow, ...overdue, ...future, ...noDate];

    // --- 4. Capacity calculation ---
    const numDays = _daysBetween(rangeStart, rangeEnd);
    const totalSlots = selectedTechs.length * numDays;
    const capacity = Math.min(JOB_CAP, totalSlots * maxStops);

    const jobsToRoute = tieredPool.slice(0, capacity);
    const jobsDeferred = tieredPool.length - jobsToRoute.length;

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

    const shouldUseFastFallback = jobsToRoute.length > 24 || numDays > 1;
    if (shouldUseFastFallback) {
      result = {
        runId: `fast-${Date.now()}`,
        routes: buildFastFallbackRoutes({
          jobsToRoute,
          selectedTechs,
          dates,
          maxStops,
          maxDriveTime,
        }),
        warnings: [
          "Used fast route generation for this multi-day or large batch. Drive times are estimates.",
        ],
        summary: {
          driveTimeSource: "fast_estimate",
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
        result = {
          runId: `fast-${Date.now()}`,
          routes: buildFastFallbackRoutes({
            jobsToRoute,
            selectedTechs,
            dates,
            maxStops,
            maxDriveTime,
          }),
          warnings: [
            `Routing engine returned ${backendRes.status}; used fast route generation instead.`,
            text.slice(0, 300),
          ].filter(Boolean),
          summary: {
            driveTimeSource: "fast_estimate",
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

    // --- 7. Save routes + mark jobs scheduled ---
    const now = new Date().toISOString();
    const scheduledJobIds = new Set<string>();
    const scheduledJobTechIds = new Map<string, string>();
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
        scheduledJobTechIds.set(id, techId);
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
      batch.update(jobRef, {
        status: "pending",
        assignedTechId: "",
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
        assignedTechId: scheduledJobTechIds.get(jobId) || "",
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
      ],
      summary: result.summary,
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
