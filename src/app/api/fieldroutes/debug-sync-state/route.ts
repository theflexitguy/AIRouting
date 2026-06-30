export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

// Read-only: dumps fieldRoutesState/sync + fieldRoutesState/manualSync +
// job/technician counts for one or more company docs, so we can tell which
// companyId production's automated sync (driven by the server-side
// FIELDROUTES_COMPANY_ID env var, independent of any companyId passed around
// the app) is actually writing to — by comparing recency of lastRunAt across
// every company doc in Firestore.
//
//   GET /api/fieldroutes/debug-sync-state            -> all company docs
//   GET /api/fieldroutes/debug-sync-state?companyId=x -> just that one

export async function GET(request: NextRequest) {
  try {
    const db = adminDb();
    const companyId = new URL(request.url).searchParams.get("companyId") || "";

    const companyIds = companyId
      ? [companyId]
      : (await db.collection("companies").limit(20).get()).docs.map((d) => d.id);

    const results = await Promise.all(
      companyIds.map(async (id) => {
        const [syncSnap, manualSnap, jobsCountSnap, techsCountSnap] = await Promise.all([
          db.doc(`companies/${id}/fieldRoutesState/sync`).get(),
          db.doc(`companies/${id}/fieldRoutesState/manualSync`).get(),
          db.collection(`companies/${id}/jobs`).count().get(),
          db.collection(`companies/${id}/technicians`).count().get(),
        ]);
        const sync = syncSnap.exists ? syncSnap.data() : null;
        const manual = manualSnap.exists ? manualSnap.data() : null;
        return {
          companyId: id,
          jobsCount: jobsCountSnap.data().count,
          techniciansCount: techsCountSnap.data().count,
          lastRunMode: sync?.lastRunMode ?? null,
          lastRunAt: sync?.lastRunAt ?? null,
          lastFullSyncAt: sync?.lastFullSyncAt ?? null,
          lastIncrementalAt: sync?.lastIncrementalAt ?? null,
          lastRunWritten: sync?.lastRunWritten ?? null,
          lastInScopeCount: sync?.lastInScopeCount ?? null,
          runActive: Boolean((sync?.run as { active?: boolean } | undefined)?.active),
          cursor: sync?.cursor ?? null,
          manualSyncDate: manual?.date ?? null,
          manualSyncCount: manual?.count ?? null,
        };
      }),
    );

    results.sort((a, b) => String(b.lastRunAt || "").localeCompare(String(a.lastRunAt || "")));

    return NextResponse.json({
      results,
      note: "Whichever companyId has the most recent lastRunAt is the one production's automated sync (FIELDROUTES_COMPANY_ID env var) actually writes to.",
    });
  } catch (err) {
    console.error("[fieldroutes/debug-sync-state] Error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
