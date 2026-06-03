export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

const BACKEND_URL =
  process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || "";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { companyId } = body as { companyId?: string };

  console.log(`[reset-routing] START companyId=${companyId || "MISSING"}`);

  if (!companyId) {
    console.log(`[reset-routing] ERROR: no companyId`);
    return NextResponse.json(
      { success: false, error: "companyId is required" },
      { status: 400 },
    );
  }

  const results: { firestoreLock?: string; lockData?: unknown; backend?: string } = {};
  let hasError = false;

  try {
    const db = adminDb();
    console.log(`[reset-routing] Firebase Admin initialized OK`);

    const lockRef = db.doc(`routeGeneration/${companyId}`);
    const lockSnap = await lockRef.get();
    if (lockSnap.exists) {
      const lockData = lockSnap.data();
      console.log(`[reset-routing] Lock found:`, JSON.stringify(lockData));
      results.lockData = lockData;
      await lockRef.delete();
      console.log(`[reset-routing] Lock deleted`);
      results.firestoreLock = "cleared";
    } else {
      console.log(`[reset-routing] No lock document found`);
      results.firestoreLock = "no lock found";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[reset-routing] Firestore error:`, err);
    results.firestoreLock = `failed: ${msg}`;
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

  console.log(`[reset-routing] DONE success=${!hasError}`, JSON.stringify(results));
  return NextResponse.json(
    { success: !hasError, ...results },
    { status: hasError ? 502 : 200 },
  );
}
