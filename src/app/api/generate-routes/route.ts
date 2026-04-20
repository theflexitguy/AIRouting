export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300; // 5 minutes for large route generation

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

const BACKEND_URL = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || "";
const MAX_STOPS_PER_ROUTE = 16;

/** Add N days to a YYYY-MM-DD string and return YYYY-MM-DD */
function _dateOffset(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Count calendar days between two YYYY-MM-DD strings (inclusive) */
function _daysBetween(start: string, end: string): number {
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  return Math.max(1, Math.round((e.getTime() - s.getTime()) / 86400000) + 1);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { companyId, startDate, endDate, date, techIds, runSettings } = body as {
      companyId: string;
      startDate?: string;
      endDate?: string;
      date?: string;
      techIds?: string[];
      runSettings?: Record<string, unknown>;
    };

    if (!companyId) {
      return NextResponse.json({ error: "companyId is required" }, { status: 400 });
    }

    const rangeStart = startDate || date || "";
    const rangeEnd = endDate || date || "";

    if (!rangeStart || !rangeEnd) {
      return NextResponse.json({ error: "startDate and endDate (or date) are required" }, { status: 400 });
    }

    if (!BACKEND_URL) {
      return NextResponse.json(
        { error: "Routing backend not configured. Run docker-compose up." },
        { status: 503 }
      );
    }

    const db = adminDb();

    // --- Generation lock to prevent double-booking (2 min timeout, auto-cleanup) ---
    const lockRef = db.doc(`routeGeneration/${companyId}`);
    const lockSnap = await lockRef.get();
    if (lockSnap.exists) {
      const lockData = lockSnap.data();
      const lockTime = new Date(lockData?.startedAt || 0).getTime();
      if (Date.now() - lockTime < 2 * 60 * 1000) {
        return NextResponse.json(
          { error: "Another route generation is in progress. Please wait a moment and try again." },
          { status: 409 }
        );
      }
      // Lock is stale (>2 min) — clear it and proceed
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
      return NextResponse.json(
        { success: false, error: "No active technicians selected" },
        { status: 400 }
      );
    }

    // Build lookup sets for matching jobs to techs.
    // assignedTechId on jobs may contain the tech's Firestore ID OR their name
    // (from CSV "Preferred Tech" column), so we match against both.
    const selectedTechIdSet = new Set(selectedTechs.map((t) => t.id));
    const selectedTechNameSet = new Set(
      selectedTechs.map((t) => String((t as Record<string, unknown>).name || "").trim().toLowerCase())
        .filter(Boolean)
    );

    // --- 2. Fetch pending jobs assigned to the selected techs ---
    const allPendingSnap = await db
      .collection(`companies/${companyId}/jobs`)
      .where("status", "==", "pending")
      .get();

    // Normalize a name for matching: lowercase, strip quotes, collapse spaces
    const normalizeName = (s: string) => s.toLowerCase().replace(/['"]/g, "").replace(/\s+/g, " ").trim();
    const selectedTechNamesNormalized = new Set(
      [...selectedTechNameSet].map(normalizeName)
    );

    const allJobDocs = allPendingSnap.docs
      .map((doc) => ({ docId: doc.id, ...doc.data() }))
      .filter((d) => {
        const val = String(d.assignedTechId || "").trim();
        // Include UNASSIGNED jobs — they can be routed by any selected tech
        if (!val) return true;
        // Match by Firestore doc ID or by tech name (normalized)
        return selectedTechIdSet.has(val)
          || selectedTechNameSet.has(val.toLowerCase())
          || selectedTechNamesNormalized.has(normalizeName(val));
      });

    const unassignedCount = allJobDocs.filter((d) => !String(d.assignedTechId || "").trim()).length;
    const assignedCount = allJobDocs.length - unassignedCount;

    console.log("ROUTE DEBUG:", JSON.stringify({
      totalPendingJobs: allPendingSnap.size,
      matchedJobs: allJobDocs.length,
      unassignedIncluded: unassignedCount,
      assignedMatched: assignedCount,
      selectedTechIds: [...selectedTechIdSet],
      selectedTechNames: [...selectedTechNameSet],
    }));

    if (allJobDocs.length === 0) {
      const sampleAssignedTechIds = Array.from(
        new Set(
          allPendingSnap.docs
            .map((doc) => String((doc.data() as { assignedTechId?: unknown }).assignedTechId || "").trim())
            .filter((v) => v.length > 0)
        )
      ).slice(0, 10);

      return NextResponse.json(
        {
          success: false,
          error: "No pending jobs for the selected technician(s)",
          debug: {
            totalPendingJobs: allPendingSnap.size,
            selectedTechIds: [...selectedTechIdSet],
            selectedTechNames: [...selectedTechNameSet],
            sampleAssignedTechIds,
          },
        },
        { status: 404 }
      );
    }

    // --- 3. Calculate route capacity ---
    const numDays = _daysBetween(rangeStart, rangeEnd);
    const totalSlots = selectedTechs.length * numDays;
    const maxJobsToRoute = totalSlots * MAX_STOPS_PER_ROUTE;

    // Cap at 500 jobs per generation to avoid timeouts
    const JOB_CAP = 500;

    // --- 4. Sort jobs: oldest scheduledDate first ---
    allJobDocs.sort((a, b) =>
      String(a.scheduledDate || "").localeCompare(String(b.scheduledDate || ""))
    );

    const jobsToRoute = allJobDocs.slice(0, Math.min(maxJobsToRoute, JOB_CAP));
    const jobsDeferred = allJobDocs.length - jobsToRoute.length;

    // --- 5. Build jobs payload ---
    const docIdMap = new Map<string, string>();
    const jobs = jobsToRoute.map((d) => {
      const customerId = String(d.customerId || d.customerID || d.docId);
      const docId = d.docId as string;
      docIdMap.set(customerId, docId);

      return {
        id: docId,
        customerID: customerId,
        subscriptionID: String(d.subscriptionId || d.subscriptionID || docId),
        address: String(d.address || ""),
        lat: d.lat ?? null,
        lng: d.lng ?? null,
        serviceDue: String(d.scheduledDate || rangeStart),
        schedulingRequest: String(d.schedulingRequest || ""),
        duration: Number(d.duration || 25),
        serviceType: String(d.serviceType || ""),
        customerName: String(d.customerName || ""),
      };
    });

    // --- 6. Call Python routing backend ---
    // Tell the engine exactly how many routes we want (= totalSlots)
    const mergedSettings: Record<string, unknown> = {
      ...runSettings,
      maxStopsPerRoute: MAX_STOPS_PER_ROUTE,
      numRoutes: totalSlots,
    };

    const backendRes = await fetch(`${BACKEND_URL}/routeiq/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobs, companyId, runSettings: mergedSettings }),
      signal: AbortSignal.timeout(300000),
    });

    if (!backendRes.ok) {
      const text = await backendRes.text();
      return NextResponse.json(
        { success: false, error: `Routing engine returned ${backendRes.status}: ${text}` },
        { status: 502 }
      );
    }

    const result = await backendRes.json();

    // --- 7. Save routes to Firestore and mark jobs as scheduled ---
    const routes = (result.routes || []) as Array<Record<string, unknown>>;
    if (routes.length === 0) {
      return NextResponse.json({
        success: true,
        runId: result.runId,
        routeCount: 0,
        stopCount: 0,
        warnings: result.warnings || [
          "No routes generated — check if jobs have valid coordinates",
        ],
      });
    }

    // --- 7a. Get AI confidence predictions (fallback to 0.85) ---
    let confidenceScores: number[] = [];
    try {
      const predRes = await fetch(`${BACKEND_URL}/routeiq/predict-confidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, routes }),
        signal: AbortSignal.timeout(10000),
      });
      if (predRes.ok) {
        const predData = await predRes.json();
        confidenceScores = (predData.predictions || []).map(
          (p: { confidence?: number }) => p.confidence ?? 0.85
        );
      }
    } catch {
      // Prediction service unavailable — use default
    }

    const now = new Date().toISOString();
    const scheduledJobIds = new Set<string>();
    let batch = db.batch();
    let batchOps = 0;

    // Build date list for the range
    const dates: string[] = [];
    for (let d = 0; d < numDays; d++) {
      dates.push(_dateOffset(rangeStart, d));
    }

    // Distribute routes evenly: cycle through dates, then techs
    // So route 0 → day 0 tech 0, route 1 → day 0 tech 1, ...
    // route numTechs → day 1 tech 0, etc.
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      const stops = (route.stops as Array<Record<string, unknown>>) || [];

      const dayIndex = Math.floor(i / selectedTechs.length) % numDays;
      const techIndex = i % selectedTechs.length;
      const routeDate = dates[dayIndex];
      const tech = selectedTechs[techIndex];
      const techId = tech?.id || `route-${i}`;
      const techName =
        (tech as Record<string, unknown>)?.name ||
        route.routeName ||
        `Route ${i + 1}`;

      // Build stop sequence using Firestore doc IDs
      const stopIds = stops.map((s) => {
        const cid = String(s.customerID || "");
        return docIdMap.get(cid) || cid;
      });

      stopIds.forEach((id) => scheduledJobIds.add(id));

      const routeRef = db
        .collection(`companies/${companyId}/routes`)
        .doc(`${routeDate}-${techId}-${i}`);

      batch.set(routeRef, {
        date: routeDate,
        techId,
        techName,
        stopSequence: stopIds,
        totalStops: stops.length,
        totalDriveTimeMinutes: Math.round(
          Number(route.totalDriveMinutes) || 0
        ),
        totalWorkMinutes: Math.round(
          Number(route.totalWorkMinutes) || Number(route.totalDriveMinutes) || 0
        ),
        confidence: confidenceScores[i] ?? 0.85,
        generatedBy: "ai",
        approved: false,
        stops,
        companyId,
        createdAt: now,
        updatedAt: now,
      });
      batchOps++;

      if (batchOps >= 450) {
        await batch.commit();
        batch = db.batch();
        batchOps = 0;
      }
    }

    // Mark all scheduled jobs
    for (const jobId of scheduledJobIds) {
      const jobRef = db.doc(`companies/${companyId}/jobs/${jobId}`);
      batch.update(jobRef, { status: "scheduled", updatedAt: now });
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

    // Release generation lock
    await lockRef.delete().catch(() => {});

    return NextResponse.json({
      success: true,
      runId: result.runId,
      routeCount: routes.length,
      stopCount: scheduledJobIds.size,
      jobsInPool: allJobDocs.length,
      warnings: [
        ...(result.warnings || []),
        ...(unassignedCount > 0 ? [`${unassignedCount} unassigned job(s) included in routing pool`] : []),
        ...(jobsDeferred > 0 ? [`${jobsDeferred} job(s) deferred — run Generate again to route the next batch`] : []),
      ],
      summary: result.summary,
    });
  } catch (error) {
    // Always release lock on failure
    try {
      const cleanupDb = adminDb();
      const body2 = await request.clone().json().catch(() => ({}));
      if (body2.companyId) await cleanupDb.doc(`routeGeneration/${body2.companyId}`).delete();
    } catch { /* best effort */ }

    console.error("Generate routes API error:", error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to generate routes",
      },
      { status: 500 }
    );
  }
}
