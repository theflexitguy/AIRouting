import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  try {
    const { companyId } = await request.json();
    if (!companyId) {
      return NextResponse.json({ error: "companyId required" }, { status: 400 });
    }

    const db = adminDb();

    // Check if company has FieldRoutes credentials
    const companyDoc = await db.doc(`companies/${companyId}`).get();
    if (!companyDoc.exists) {
      return NextResponse.json({ error: "Company not found" }, { status: 404 });
    }

    const company = companyDoc.data();
    const apiKey = company?.fieldRoutesApiKey;
    const apiSecret = company?.fieldRoutesApiSecret;

    if (!apiKey || !apiSecret) {
      return NextResponse.json({ error: "FieldRoutes credentials not configured", total: 0 }, { status: 200 });
    }

    // Try to sync via Python backend (which has the FieldRoutes client)
    const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

    try {
      const res = await fetch(`${BACKEND_URL}/routeiq/sync-fieldroutes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          apiKey,
          apiSecret,
          baseUrl: process.env.FIELDROUTES_NWA_BASE_URL || "https://flexpc.fieldroutes.com/api",
        }),
        signal: AbortSignal.timeout(90000),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error("Backend sync error:", text);
        return NextResponse.json({ error: "Sync failed — backend returned error", total: 0 }, { status: 502 });
      }

      const data = await res.json();
      return NextResponse.json({
        success: true,
        total: data.total || 0,
        created: data.created || 0,
        updated: data.updated || 0,
      });
    } catch (backendError) {
      // Backend not available — return graceful error
      console.error("Backend not available for sync:", backendError);
      return NextResponse.json({
        error: "Routing backend not available. Upload jobs via CSV instead.",
        total: 0,
      }, { status: 200 });
    }
  } catch (error) {
    console.error("Sync jobs error:", error);
    return NextResponse.json({ error: "Failed to sync jobs" }, { status: 500 });
  }
}
