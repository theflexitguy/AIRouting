export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

// Resets a company's FieldRoutes sync state:
//  - clears the daily manual-sync counter (the 3/day rate limit)
//  - clears any stuck in-progress run so a fresh sync can start
//
// Follows the same companyId-in-body shape as /api/reset-routing.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { companyId, clearRun = true } = body as { companyId?: string; clearRun?: boolean };

  if (!companyId) {
    return NextResponse.json({ success: false, error: "companyId is required" }, { status: 400 });
  }

  const results: { counter?: string; run?: string } = {};
  let hasError = false;

  try {
    const db = adminDb();

    // Clear the daily manual-sync counter so usedToday resets to 0.
    const limitRef = db.doc(`companies/${companyId}/fieldRoutesState/manualSync`);
    await limitRef.delete();
    results.counter = "cleared";

    // Clear any in-progress (possibly stuck) run so a new sync can begin.
    if (clearRun) {
      const syncRef = db.doc(`companies/${companyId}/fieldRoutesState/sync`);
      const syncSnap = await syncRef.get();
      if (syncSnap.exists && syncSnap.data()?.run) {
        await syncRef.set({ run: { active: false } }, { merge: true });
        results.run = "cleared";
      } else {
        results.run = "no active run";
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[fieldroutes/reset-sync] failed:`, err);
    results.counter = results.counter || `failed: ${msg}`;
    hasError = true;
  }

  return NextResponse.json({ success: !hasError, companyId, ...results }, { status: hasError ? 502 : 200 });
}
