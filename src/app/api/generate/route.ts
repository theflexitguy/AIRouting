export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || process.env.BACKEND_URL || "";

/**
 * POST /api/generate
 *
 * Pulls pending jobs from Firestore for the given company, sends them to the
 * production routing backend (OGRouting FastAPI), and writes the resulting
 * routes back into Firestore.
 *
 * If BACKEND_URL is not set the endpoint returns a clear error — the JS
 * fallback solver was removed in favour of the Python engine.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { companyId, date, runSettings } = body as {
      companyId: string;
      date?: string;
      runSettings?: Record<string, unknown>;
    };

    if (!companyId) {
      return NextResponse.json({ error: "companyId is required" }, { status: 400 });
    }

    if (!BACKEND_URL) {
      return NextResponse.json(
        {
          error:
            "Routing backend not configured. Set BACKEND_URL (or NEXT_PUBLIC_BACKEND_URL) " +
            "to your FastAPI backend URL (e.g. http://localhost:8000 when running docker-compose).",
        },
        { status: 503 }
      );
    }

    // --- 1. Fetch jobs from Firestore ---
    const db = adminDb();
    let jobsQuery = db.collection(`companies/${companyId}/jobs`) as FirebaseFirestore.Query;
    if (date) {
      jobsQuery = jobsQuery.where("scheduledDate", "==", date);
    }
    jobsQuery = jobsQuery.where("status", "in", ["pending", "unassigned"]).limit(500);

    const snapshot = await jobsQuery.get();
    const jobs = snapshot.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        customerID: d.customerId || d.customerID || doc.id,
        subscriptionID: d.subscriptionId || d.subscriptionID || doc.id,
        address: d.address || "",
        lat: d.lat ?? d.latitude ?? null,
        lng: d.lng ?? d.longitude ?? null,
        preferredTech: d.assignedTechId || d.preferredTech || "",
        serviceDue: d.scheduledDate || date || "",
        schedulingRequest: d.schedulingRequest || "",
        duration: d.estimatedDuration || 25,
        serviceType: d.serviceType || "",
      };
    });

    if (jobs.length === 0) {
      return NextResponse.json({ error: "No pending jobs found for this date/company" }, { status: 404 });
    }

    // --- 2. Call the Python routing backend ---
    const backendRes = await fetch(`${BACKEND_URL}/routeiq/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobs, companyId, runSettings: runSettings || {} }),
    });

    if (!backendRes.ok) {
      const text = await backendRes.text();
      return NextResponse.json(
        { error: `Routing backend returned ${backendRes.status}: ${text}` },
        { status: 502 }
      );
    }

    const result = await backendRes.json();

    // --- 3. Write routes back to Firestore ---
    if (db && result.routes?.length > 0) {
      const batch = db.batch();
      const now = new Date().toISOString();

      for (const route of result.routes) {
        const routeRef = db
          .collection(`companies/${companyId}/routes`)
          .doc(`${route.routeName}-${result.runId}`);

        batch.set(routeRef, {
          name: route.routeName,
          date: route.routeDate,
          routeIndex: route.routeIndex,
          fieldRoutesTemplateID: route.fieldRoutesTemplateID,
          totalDriveMinutes: route.totalDriveMinutes,
          stopCount: route.stops?.length || 0,
          stops: route.stops || [],
          status: "draft",
          generatedBy: "routeiq-engine",
          runId: result.runId,
          companyId,
          createdAt: now,
          updatedAt: now,
        });
      }

      await batch.commit();
    }

    return NextResponse.json({
      runId: result.runId,
      routeCount: result.routes?.length || 0,
      stopCount: result.stops?.length || 0,
      summary: result.summary,
      warnings: result.warnings || [],
    });
  } catch (error) {
    console.error("Generate routes API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate routes" },
      { status: 500 }
    );
  }
}
