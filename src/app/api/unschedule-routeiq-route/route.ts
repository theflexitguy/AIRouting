export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function syncDetailsFromRoute(route: FirebaseFirestore.DocumentData) {
  const sync = isRecord(route.fieldRoutesSync) ? route.fieldRoutesSync : {};
  return {
    routeId: clean(sync.routeId || route.fieldRoutesRouteId),
    routeStatus: clean(sync.routeStatus),
    routeDate: clean(sync.routeDate || sync.dateInputUsed || route.date),
    routeTime: clean(sync.routeTime),
    assignedTech: clean(sync.assignedTech),
    uploadedAt: clean(sync.uploadedAt),
    verifiedAt: clean(sync.verifiedAt),
  };
}

export async function POST(request: NextRequest) {
  try {
    const { companyId, routeId, requestedBy } = await request.json();
    if (!companyId || !routeId) {
      return NextResponse.json({ error: "companyId and routeId are required" }, { status: 400 });
    }

    const db = adminDb();
    const routeRef = db.doc(`companies/${companyId}/routes/${routeId}`);
    const routeDoc = await routeRef.get();
    if (!routeDoc.exists) return NextResponse.json({ error: "Route not found" }, { status: 404 });

    const route = routeDoc.data() || {};
    const stopSequence = Array.isArray(route.stopSequence) ? route.stopSequence.map(clean).filter(Boolean) : [];
    const now = new Date().toISOString();
    const syncDetails = syncDetailsFromRoute(route);

    const batch = db.batch();
    batch.update(routeRef, {
      approved: false,
      approvedAt: FieldValue.delete(),
      approvedBy: FieldValue.delete(),
      fieldRoutesSync: FieldValue.delete(),
      fieldRoutesClearedSync: {
        clearedAt: now,
        requestedBy: clean(requestedBy),
        reason: "routiq local unschedule only; FieldRoutes was not changed.",
        ...syncDetails,
      },
      updatedAt: now,
    });

    for (const jobId of stopSequence) {
      batch.update(db.doc(`companies/${companyId}/jobs/${jobId}`), {
        status: "pending",
        fieldRoutesRouteId: FieldValue.delete(),
        fieldRoutesSequence: FieldValue.delete(),
        fieldRoutesUploadedAt: FieldValue.delete(),
        updatedAt: now,
      });
    }
    await batch.commit();

    return NextResponse.json({
      success: true,
      routeId,
      unscheduledAt: now,
      stopCount: stopSequence.length,
      fieldRoutes: syncDetails,
    });
  } catch (error) {
    console.error("Unschedule routiq route error:", error);
    return NextResponse.json({ error: "Failed to unschedule routiq route", details: String(error) }, { status: 500 });
  }
}
