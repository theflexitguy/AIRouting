import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const companyId = searchParams.get("companyId");
    const date = searchParams.get("date");
    const techId = searchParams.get("techId");

    if (!companyId) {
      return NextResponse.json({ error: "companyId is required" }, { status: 400 });
    }

    const db = adminDb();
    let query = db.collection(`companies/${companyId}/routes`) as FirebaseFirestore.Query;

    if (date) {
      query = query.where("date", "==", date);
    }
    if (techId) {
      query = query.where("techId", "==", techId);
    }

    query = query.orderBy("createdAt", "desc").limit(100);

    const snapshot = await query.get();
    const routes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    return NextResponse.json({ routes, total: routes.length });
  } catch (error) {
    console.error("Get routes API error:", error);
    return NextResponse.json({ error: "Failed to fetch routes" }, { status: 500 });
  }
}
