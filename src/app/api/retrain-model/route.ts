export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { companyId } = body;

    if (!companyId) {
      return NextResponse.json({ error: "companyId is required" }, { status: 400 });
    }

    const pythonFunctionUrl = process.env.PYTHON_CLOUD_FUNCTIONS_URL ||
      `https://us-central1-${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID}.run.app`;

    const response = await fetch(`${pythonFunctionUrl}/train_routing_model`, {
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
