export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { guarded, type ApiAuth } from "@/lib/api-guard";

// Resets a company's FieldRoutes sync state:
//  - clears the daily manual-sync counter (the 3/day rate limit)
//  - clears any stuck in-progress run so a fresh sync can start
//
// Supports both POST (companyId in JSON body) and GET (companyId in query
// string) so it can be triggered straight from the browser address bar, e.g.
//   /api/fieldroutes/reset-sync?companyId=company_xxx
async function resetSync(companyIdParam: string | undefined, clearRun: boolean, clearCursor: boolean = false) {
  // Default to the company the FieldRoutes sync writes to, so the URL only needs the secret.
  const companyId = companyIdParam || (process.env.FIELDROUTES_COMPANY_ID || "").trim() || undefined;
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
        // update() REPLACES run (dropping any legacy inline ids/apptMap that
        // blew past Firestore's 40k index-entry limit); set-merge would
        // recursively preserve them and the write would be rejected on an
        // already-bloated doc.
        await syncRef.update({ run: { active: false } });
        results.run = "cleared";
      } else {
        results.run = "no active run";
      }
    }

    // Clear the sync cursor so the next sync does a full pull from scratch
    // instead of an incremental one. Needed after reset-jobs to rebuild all data.
    if (clearCursor) {
      const syncRef = db.doc(`companies/${companyId}/fieldRoutesState/sync`);
      await syncRef.set({ cursor: "" }, { merge: true });
      (results as Record<string, string>).cursor = "cleared";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[fieldroutes/reset-sync] failed:`, err);
    results.counter = results.counter || `failed: ${msg}`;
    hasError = true;
  }

  return NextResponse.json({ success: !hasError, companyId, ...results }, { status: hasError ? 502 : 200 });
}

// A signed-in user resets THEIR OWN company (the Jobs page's "Reset" button); only the operator may name another
// company or clear the cursor (which forces an expensive full re-pull from FieldRoutes).
async function POSTHandler(request: NextRequest, auth: ApiAuth) {
  const body = await request.json().catch(() => ({}));
  const { companyId, clearRun = true, clearCursor = false } = body as {
    companyId?: string;
    clearRun?: boolean;
    clearCursor?: boolean;
  };
  const operator = auth.kind === "operator";
  return resetSync(operator ? companyId : auth.companyId, clearRun, operator && clearCursor);
}

async function GETHandler(request: NextRequest, auth: ApiAuth) {
  const params = new URL(request.url).searchParams;
  const operator = auth.kind === "operator";
  const companyId = operator ? params.get("companyId") || undefined : auth.companyId;
  const clearRun = params.get("clearRun") !== "false";
  const clearCursor = operator && params.get("clearCursor") === "true";
  return resetSync(companyId, clearRun, clearCursor);
}

export const POST = guarded("company-write", POSTHandler, { implicitCompany: true });
export const GET = guarded("company-write", GETHandler, { implicitCompany: true });
