import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const companyId = searchParams.get("companyId");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const techId = searchParams.get("techId");
    const status = searchParams.get("status");

    if (!companyId) {
      return NextResponse.json({ error: "companyId is required" }, { status: 400 });
    }

    const db = adminDb();
    let query = db.collection(`companies/${companyId}/jobs`) as FirebaseFirestore.Query;

    if (startDate) {
      query = query.where("scheduledDate", ">=", startDate);
    }
    if (endDate) {
      query = query.where("scheduledDate", "<=", endDate);
    }
    if (techId) {
      query = query.where("assignedTechId", "==", techId);
    }
    if (status) {
      query = query.where("status", "==", status);
    }

    query = query.orderBy("scheduledDate", "desc").limit(500);

    const snapshot = await query.get();
    const jobs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    return NextResponse.json({ jobs, total: jobs.length });
  } catch (error) {
    console.error("Get jobs API error:", error);
    return NextResponse.json({ error: "Failed to fetch jobs" }, { status: 500 });
  }
}
