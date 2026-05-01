export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { computeRouteGeometry, type RoutePoint } from "@/lib/google-routing";

type RouteGeometryRequest = {
  companyId?: string;
  routeDate?: string;
  trafficMode?: string;
  jobIds?: string[];
  jobs?: Array<RoutePoint & { id?: string }>;
};

function cleanJobPoint(job: RoutePoint & { id?: string }): RoutePoint {
  return {
    id: String(job.id || ""),
    lat: typeof job.lat === "number" ? job.lat : null,
    lng: typeof job.lng === "number" ? job.lng : null,
    duration: typeof job.duration === "number" ? job.duration : null,
  };
}

async function loadJobPoints(companyId: string, jobIds: string[]) {
  const db = adminDb();
  const points: RoutePoint[] = [];
  for (const jobId of jobIds) {
    const snap = await db.doc(`companies/${companyId}/jobs/${jobId}`).get();
    if (!snap.exists) {
      points.push({ id: jobId, lat: null, lng: null });
      continue;
    }
    const data = snap.data() || {};
    points.push({
      id: jobId,
      lat: typeof data.lat === "number" ? data.lat : null,
      lng: typeof data.lng === "number" ? data.lng : null,
      duration: typeof data.duration === "number" ? data.duration : null,
    });
  }
  return points;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RouteGeometryRequest;
    const jobIds = Array.isArray(body.jobIds) ? body.jobIds.filter(Boolean) : [];
    const inlineJobs = Array.isArray(body.jobs) ? body.jobs : [];

    let points: RoutePoint[];
    if (jobIds.length > 0) {
      if (!body.companyId) {
        return NextResponse.json(
          { success: false, error: "companyId is required when jobIds are used" },
          { status: 400 },
        );
      }
      points = await loadJobPoints(body.companyId, jobIds);
    } else {
      points = inlineJobs.map(cleanJobPoint);
    }

    const result = await computeRouteGeometry(points, {
      routeDate: body.routeDate,
      trafficMode: body.trafficMode,
    });

    return NextResponse.json({
      success: true,
      encodedPolyline: result.encodedPolyline,
      path: result.path,
      driveMinutes: Math.round(result.driveMinutes * 10) / 10,
      distanceMeters: result.distanceMeters,
      status: result.status,
      failedSegments: result.failedSegments,
      driveTimeSource: result.driveTimeSource,
      polylineSource: result.polylineSource,
      warnings: result.warnings,
    });
  } catch (error) {
    console.error("Route geometry API error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to compute route geometry",
      },
      { status: 500 },
    );
  }
}
