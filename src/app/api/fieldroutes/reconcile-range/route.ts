export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { reconcileRouteRange } from "@/lib/fieldroutes/sync";
import { guarded, type ApiAuth } from "@/lib/api-guard";

// On-demand "make this date range exact": rebuilds a PAST window's route docs
// from the actual FieldRoutes appointments so a custom date-range view always
// matches FieldRoutes — cancellations/reschedules after the fact drop off,
// emptied routes disappear. Fired by the dashboard when a custom range is
// selected. A short TTL keeps repeated picks of the same range from spending
// FieldRoutes API budget.
//
//   POST { startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD" }

const TTL_MINUTES = 10;
// Bump when the rebuild logic changes so a re-pick after a deploy re-verifies
// instead of returning a result computed by the old logic.
const REBUILD_VERSION = "v5";

async function POSTHandler(request: Request, auth: ApiAuth) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      startDate?: string;
      endDate?: string;
      force?: boolean;
    };
    const startDate = String(body.startDate || "");
    const endDate = String(body.endDate || "");
    // Escape hatch: re-verify FINALIZED days too (late FieldRoutes edits) and
    // bypass the TTL cache. Never set by the dashboard's automatic call.
    const force = body.force === true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
      return NextResponse.json({ error: "startDate and endDate (YYYY-MM-DD, start <= end) are required" }, { status: 400 });
    }

    // TTL guard BEFORE any FieldRoutes spend.
    const db = adminDb();
    // A signed-in user's own company; only the operator (no company of their own) falls back to the first one.
    const companyId = auth.companyId || (await db.collection("companies").limit(2).get()).docs[0]?.id || "";
    const key = `${REBUILD_VERSION}_${startDate}_${endDate}`;
    const ttlRef = companyId ? db.doc(`companies/${companyId}/fieldRoutesState/rangeReconcile`) : null;
    if (ttlRef && !force) {
      const ttlSnap = await ttlRef.get();
      const d = ttlSnap.exists ? ttlSnap.data() : undefined;
      const at = Date.parse(String(d?.at || "")) || 0;
      if (d?.key === key && Date.now() - at < TTL_MINUTES * 60 * 1000) {
        return NextResponse.json({ success: true, cached: true, key, verifiedAt: d?.at });
      }
    }

    const result = await reconcileRouteRange(startDate, endDate, { force });

    if (ttlRef && !result.skipped) {
      await ttlRef.set({ key, at: new Date().toISOString(), result }, { merge: true });
    }

    return NextResponse.json({ success: true, cached: false, ...result });
  } catch (err) {
    console.error("[fieldroutes/reconcile-range] Error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = guarded("company-write", POSTHandler, { implicitCompany: true });
