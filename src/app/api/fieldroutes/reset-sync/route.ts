export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

// Resets a company's FieldRoutes sync state:
//  - clears the daily manual-sync counter (the 3/day rate limit)
//  - clears any stuck in-progress run so a fresh sync can start
//
// Supports both POST (companyId in JSON body) and GET (companyId in query
// string) so it can be triggered straight from the browser address bar, e.g.
//   /api/fieldroutes/reset-sync?companyId=company_xxx
async function resetSync(companyId: string | undefined, clearRun: boolean) {
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

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { companyId, clearRun = true } = body as { companyId?: string; clearRun?: boolean };
  return resetSync(companyId, clearRun);
}

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const companyId = params.get("companyId") || undefined;
  const clearRun = params.get("clearRun") !== "false";
  return resetSync(companyId, clearRun);
}
