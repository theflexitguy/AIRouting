import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const companyId = searchParams.get("companyId");

    if (!companyId) {
      return NextResponse.json({ error: "companyId is required" }, { status: 400 });
    }

    const db = adminDb();
    const metricsDoc = await db.doc(`companies/${companyId}/modelMetrics/current`).get();

    if (!metricsDoc.exists) {
      return NextResponse.json({
        metrics: {
          lastTrainedAt: null,
          accuracy: 0,
          totalRoutesLearned: 0,
          avgConfidence: 0,
          accuracyHistory: [],
        }
      });
    }

    return NextResponse.json({ metrics: metricsDoc.data() });
  } catch (error) {
    console.error("Get metrics API error:", error);
    return NextResponse.json({ error: "Failed to fetch metrics" }, { status: 500 });
  }
}
