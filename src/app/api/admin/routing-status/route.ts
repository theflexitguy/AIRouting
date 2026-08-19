export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { computeRouteMatrix, hasGoogleRoutesApiKey } from "@/lib/google-routing";
import { optimizeTours, routeOptimizationConfig } from "@/lib/google-route-optimization";

// Live health check for the two Google services routing depends on. These are
// DIFFERENT products with DIFFERENT auth, which is easy to get wrong:
//   Routes API             -> drive-time matrix + polylines, Maps Platform API key
//   Route Optimization API -> assignment + sequencing, OAuth service account
//                             (a Maps API key does NOT work here)
//
//   GET /api/admin/routing-status[?companyId=...]
//
// Answers "what is actually running in production right now?" without needing a
// redeploy or a Firestore console.

// Two real coordinates ~4 miles apart in NWA, enough to prove a live call works.
const PROBE_A = { lat: 36.3729, lng: -94.2088 };
const PROBE_B = { lat: 36.3345, lng: -94.1574 };

export async function GET(request: NextRequest) {
  const companyIdParam = new URL(request.url).searchParams.get("companyId") || "";

  // --- Routes API (drive times) ---
  const matrixProbe: Record<string, unknown> = { apiKeyConfigured: hasGoogleRoutesApiKey() };
  try {
    const result = await computeRouteMatrix([
      { id: "probe-a", ...PROBE_A },
      { id: "probe-b", ...PROBE_B },
    ]);
    matrixProbe.source = result.source;
    matrixProbe.ok = result.source !== "haversine_fallback";
    matrixProbe.sampleDriveMinutes = Math.round((result.matrix?.[0]?.[1] ?? 0) * 10) / 10;
    if (result.warnings?.length) matrixProbe.warnings = result.warnings;
  } catch (error) {
    matrixProbe.ok = false;
    matrixProbe.error = error instanceof Error ? error.message : String(error);
  }

  // --- Route Optimization API (the actual optimizer) ---
  const config = routeOptimizationConfig();
  const optimizationProbe: Record<string, unknown> = {
    configured: config.configured,
    credentialSource: config.source,
    projectId: config.projectId,
  };
  if (config.configured) {
    try {
      const plan = await optimizeTours({
        stops: [
          { id: "probe-a", ...PROBE_A, durationMinutes: 25, allowedVehicleIndices: [] },
          { id: "probe-b", ...PROBE_B, durationMinutes: 25, allowedVehicleIndices: [] },
        ],
        vehicles: [{ slotKey: "probe::vehicle", maxStops: 5, start: PROBE_A, end: PROBE_A }],
        maxDriveMinutes: 240,
        timeoutSeconds: 10,
      });
      optimizationProbe.status = plan.status;
      optimizationProbe.ok = plan.status === "ok";
      optimizationProbe.googleDriveMinutes = plan.googleDriveMinutes ?? null;
      if (plan.warnings.length) optimizationProbe.warnings = plan.warnings;
    } catch (error) {
      optimizationProbe.ok = false;
      optimizationProbe.error = error instanceof Error ? error.message : String(error);
    }
  } else {
    optimizationProbe.ok = false;
    optimizationProbe.hint =
      "Set GOOGLE_ROUTE_OPTIMIZATION_SERVICE_ACCOUNT (or rely on FIREBASE_SERVICE_ACCOUNT when Route Optimization is enabled on the same Google Cloud project), grant that service account roles/routeoptimization.editor, and enable billing. A Maps Platform API key cannot authenticate this API.";
  }

  // --- What the most recent generated routes actually used ---
  let lastRoutes: unknown = null;
  try {
    const db = adminDb();
    let companyId = companyIdParam;
    if (!companyId) {
      const companies = await db.collection("companies").limit(2).get();
      if (companies.size === 1) companyId = companies.docs[0].id;
      else if (companies.size > 1) {
        lastRoutes = { note: "Multiple companies — pass ?companyId=", companyIds: companies.docs.map((d) => d.id) };
      }
    }
    if (companyId) {
      const snap = await db
        .collection(`companies/${companyId}/routes`)
        .orderBy("createdAt", "desc")
        .limit(5)
        .get();
      lastRoutes = snap.docs.map((d) => {
        const r = d.data();
        return {
          date: String(r.date || ""),
          techName: String(r.techName || ""),
          optimizerEngine: String(r.optimizerEngine || "(pre-dates this field)"),
          driveTimeSource: String(r.driveTimeSource || ""),
          totalDriveMinutes: Number(r.totalDriveTimeMinutes ?? r.totalDriveMinutes ?? 0),
          stops: Number(r.totalStops || 0),
          routeOptimization: r.googleRouteOptimizationSummary ?? null,
        };
      });
    }
  } catch (error) {
    lastRoutes = { error: error instanceof Error ? error.message : String(error) };
  }

  const healthy = matrixProbe.ok === true && optimizationProbe.ok === true;
  return NextResponse.json({
    healthy,
    summary: healthy
      ? "Routes API and Route Optimization API are both live; generation assigns and sequences with Google."
      : "One or more Google routing services are not live — see routesApi / routeOptimization below. Generation falls back to the built-in engine when Route Optimization is unavailable.",
    routesApi: matrixProbe,
    routeOptimization: optimizationProbe,
    recentRoutes: lastRoutes,
  });
}
