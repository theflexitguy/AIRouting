export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

const BACKEND_URL =
  process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || "";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { companyId } = body as { companyId?: string };

  const results: { firestoreLock?: string; backend?: string } = {};

  // 1. Clear Firestore generation lock for this company
  if (companyId) {
    try {
      const db = adminDb();
      await db.doc(`routeGeneration/${companyId}`).delete();
      results.firestoreLock = "cleared";
    } catch {
      results.firestoreLock = "not found or already cleared";
    }
  }

  // 2. Reset the Python backend job state (if configured)
  if (BACKEND_URL) {
    try {
      const res = await fetch(`${BACKEND_URL}/reset`, { method: "POST" });
      const data = await res.json();
      results.backend = res.ok ? "reset" : (data.error || "failed");
    } catch {
      results.backend = "unreachable";
    }
  }

  return NextResponse.json({ success: true, ...results });
}
