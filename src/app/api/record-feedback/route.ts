export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { companyId, routeId, originalRoute, modifiedRoute, modifiedBy } = body;

    if (!companyId || !routeId || !originalRoute || !modifiedRoute) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const cloudFunctionUrl = process.env.CLOUD_FUNCTIONS_URL ||
      `https://us-central1-${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID}.cloudfunctions.net`;

    const response = await fetch(`${cloudFunctionUrl}/recordRouteFeedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId, routeId, originalRoute, modifiedRoute, modifiedBy }),
    });

    if (!response.ok) {
      const error = await response.text();
      return NextResponse.json({ error: `Feedback recording failed: ${error}` }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Record feedback API error:", error);
    return NextResponse.json({ error: "Failed to record feedback" }, { status: 500 });
  }
}
