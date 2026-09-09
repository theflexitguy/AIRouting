export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import {
  computeRouteMatrix,
  googleApisPaused,
  googleMapsApiKeyConfigured,
  hasGoogleRoutesApiKey,
} from "@/lib/google-routing";
import { optimizeTours, routeOptimizationConfig } from "@/lib/google-route-optimization";
import { routingStatusSummaryPayload } from "@/lib/routing/drive-time-honesty";

// Live health check for the two Google services routing depends on. These are
// DIFFERENT products with DIFFERENT auth, which is easy to get wrong:
//   Routes API             -> drive-time matrix + polylines, Maps Platform API key
//   Route Optimization API -> assignment + sequencing, OAuth service account
//                             (a Maps API key does NOT work here)
//
//   GET /api/admin/routing-status?summary=1
//     Public, cheap: { paused, probed, generateRefused, summary } only.
//     No company data, no GCP identity, no Google calls.
//
//   GET /api/admin/routing-status[?companyId=...]
//     Full probe + recentRoutes. Requires CRON_SECRET (same as other admin
//     cron routes). Never returns this payload to unauthenticated callers.

const PROBE_A = { lat: 36.3729, lng: -94.2088 };
const PROBE_B = { lat: 36.3345, lng: -94.1574 };

function authorized(request: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) return false;
  const auth = request.headers.get("authorization") || "";
  if (auth === `Bearer ${secret}`) return true;
  if ((request.headers.get("x-cron-secret") || "") === secret) return true;
  if (new URL(request.url).searchParams.get("secret") === secret) return true;
  return false;
}

async function loadRecentRoutes(companyIdParam: string) {
  try {
    const db = adminDb();
    let companyId = companyIdParam;
    if (!companyId) {
      const companies = await db.collection("companies").limit(2).get();
      if (companies.size === 1) companyId = companies.docs[0].id;
      else if (companies.size > 1) {
        return { note: "Multiple companies — pass ?companyId=", companyIds: companies.docs.map((d) => d.id) };
      }
    }
    if (!companyId) return null;
    const snap = await db
      .collection(`companies/${companyId}/routes`)
      .orderBy("createdAt", "desc")
      .limit(5)
      .get();
    return snap.docs.map((d) => {
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
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const summaryOnly = url.searchParams.get("summary") === "1" || url.searchParams.get("probe") === "0";
  const paused = googleApisPaused();

  if (summaryOnly) {
    return NextResponse.json(routingStatusSummaryPayload(paused));
  }

  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const companyIdParam = url.searchParams.get("companyId") || "";
  const config = routeOptimizationConfig();
  const lastRoutes = await loadRecentRoutes(companyIdParam);

  const routesApiBase = {
    apiKeyConfigured: hasGoogleRoutesApiKey(),
    mapsKeyPresent: googleMapsApiKeyConfigured(),
  };
  const optimizationBase: Record<string, unknown> = {
    configured: config.configured,
    credentialSource: config.source,
    projectId: config.projectId,
    serviceAccountEmail: config.serviceAccountEmail,
  };

  if (paused) {
    return NextResponse.json({
      healthy: false,
      paused: true,
      probed: false,
      generateRefused: true,
      summary: routingStatusSummaryPayload(true).summary,
      routesApi: routesApiBase,
      routeOptimization: {
        ...optimizationBase,
        ok: false,
        hint: "Route Optimization is not called while GOOGLE_APIS_PAUSED is set.",
      },
      recentRoutes: lastRoutes,
    });
  }

  const matrixProbe: Record<string, unknown> = { ...routesApiBase };
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

  const optimizationProbe: Record<string, unknown> = { ...optimizationBase };
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
      const detail = plan.warnings.join(" ");
      if (/has not been used in project|is disabled/i.test(detail)) {
        optimizationProbe.remedy = `Enable the Route Optimization API on project ${config.projectId}, then allow a few minutes to propagate.`;
      } else if (/permission|denied|PERMISSION_DENIED/i.test(detail)) {
        optimizationProbe.remedy = `Grant roles/routeoptimization.editor on project ${config.projectId} to ${config.serviceAccountEmail || "the service account above"} (IAM & Admin -> Grant access).`;
      }
    } catch (error) {
      optimizationProbe.ok = false;
      optimizationProbe.error = error instanceof Error ? error.message : String(error);
    }
  } else {
    optimizationProbe.ok = false;
    optimizationProbe.hint =
      "Set GOOGLE_ROUTE_OPTIMIZATION_SERVICE_ACCOUNT (or rely on FIREBASE_SERVICE_ACCOUNT when Route Optimization is enabled on the same Google Cloud project), grant that service account roles/routeoptimization.editor, and enable billing. A Maps Platform API key cannot authenticate this API.";
  }

  const healthy = matrixProbe.ok === true && optimizationProbe.ok === true;
  return NextResponse.json({
    healthy,
    paused: false,
    probed: true,
    generateRefused: false,
    summary: healthy
      ? "Routes API and Route Optimization API are both live; generation assigns and sequences with Google."
      : "One or more Google routing services are not live — see routesApi / routeOptimization below. Generation falls back to the built-in engine when Route Optimization is unavailable.",
    routesApi: matrixProbe,
    routeOptimization: optimizationProbe,
    recentRoutes: lastRoutes,
  });
}
