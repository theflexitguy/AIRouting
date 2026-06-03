export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

const BACKEND_URL =
  process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || "";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { companyId } = body as { companyId?: string };

  if (!companyId) {
    return NextResponse.json(
      { success: false, error: "companyId is required" },
      { status: 400 },
    );
  }

  const results: { firestoreLock?: string; backend?: string } = {};
  let hasError = false;

  try {
    const db = adminDb();
    await db.doc(`routeGeneration/${companyId}`).delete();
    results.firestoreLock = "cleared";
  } catch (err) {
    results.firestoreLock = `failed: ${err instanceof Error ? err.message : "unknown error"}`;
    hasError = true;
  }

  if (BACKEND_URL) {
    try {
      const res = await fetch(`${BACKEND_URL}/reset`, { method: "POST" });
      const data = await res.json();
      results.backend = res.ok ? "reset" : (data.error || "failed");
      if (!res.ok) hasError = true;
    } catch {
      results.backend = "unreachable";
      hasError = true;
    }
  }

  return NextResponse.json(
    { success: !hasError, ...results },
    { status: hasError ? 502 : 200 },
  );
}
