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

// Live health check for the two Google services routing depends on. These are
// DIFFERENT products with DIFFERENT auth, which is easy to get wrong:
//   Routes API             -> drive-time matrix + polylines, Maps Platform API key
//   Route Optimization API -> assignment + sequencing, OAuth service account
//                             (a Maps API key does NOT work here)
//
//   GET /api/admin/routing-status[?companyId=...][&summary=1]
//
// summary=1 (or GOOGLE_APIS_PAUSED) never makes a billable Google call — the
// Routes tab uses that mode so loading the panel cannot spend.

const PROBE_A = { lat: 36.3729, lng: -94.2088 };
const PROBE_B = { lat: 36.3345, lng: -94.1574 };

const PAUSED_SUMMARY =
  "Google APIs are PAUSED (GOOGLE_APIS_PAUSED). No billable calls are being made. " +
  "Drive times on Routes are ESTIMATE (straight-line), polylines are dashed stop-to-stop — never fake snapped roads. " +
  "Route generation is refused so we never return a silent haversine success. " +
  "The FieldRoutes sync and the dashboard are unaffected. Remove the variable in Vercel and redeploy to resume.";

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
  const companyIdParam = url.searchParams.get("companyId") || "";
  const summaryOnly = url.searchParams.get("summary") === "1" || url.searchParams.get("probe") === "0";
  const paused = googleApisPaused();
  const skipProbes = paused || summaryOnly;
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

  if (skipProbes) {
    return NextResponse.json({
      healthy: false,
      paused,
      probed: false,
      generateRefused: paused,
      summary: paused
        ? PAUSED_SUMMARY
        : "Summary only — live Google probes skipped so this request cannot bill. Pass without ?summary=1 to probe (unpaused deployments only).",
      routesApi: routesApiBase,
      routeOptimization: {
        ...optimizationBase,
        ok: false,
        hint: paused
          ? "Route Optimization is not called while GOOGLE_APIS_PAUSED is set."
          : "Live probe skipped (summary mode).",
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
