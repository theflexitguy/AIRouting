export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL || "";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { companyId } = body;

    if (!companyId) {
      return NextResponse.json({ error: "companyId is required" }, { status: 400 });
    }

    if (!BACKEND_URL) {
      return NextResponse.json({ error: "Routing backend not configured" }, { status: 503 });
    }

    const response = await fetch(`${BACKEND_URL}/routeiq/train`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId }),
    });

    if (!response.ok) {
      const error = await response.text();
      return NextResponse.json({ error: `Retraining failed: ${error}` }, { status: response.status });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Retrain model API error:", error);
    return NextResponse.json({ error: "Failed to retrain model" }, { status: 500 });
  }
}
