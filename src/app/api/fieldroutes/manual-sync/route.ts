export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth } from "@/lib/firebase-admin";
import { runSync, recomputePastDue, purgeNonRecurring, reconcileActiveSubscriptions, purgeInactiveCustomers } from "@/lib/fieldroutes/sync";

async function getUidFromRequest(request: NextRequest): Promise<string | null> {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  try {
    const decoded = await adminAuth().verifyIdToken(token);
    return decoded.uid;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const uid = await getUidFromRequest(request);
  if (!uid) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = adminDb();
  const userDoc = await db.doc(`users/${uid}`).get();
  const companyId = userDoc.data()?.companyId;
  if (!companyId) {
    return NextResponse.json({ error: "no company associated" }, { status: 403 });
  }

  // No daily limit on manual syncs. The sync is resumable (one click may take several POSTs to finish) and is
  // still bounded by the FieldRoutes daily API budget, which it checks before every run.
  try {
    const result = await runSync("incremental");
    // Incremental syncs only rewrite changed subscriptions, so derived flags
    // (pastDue, overdueActionable) drift on untouched docs. When a run finishes,
    // recompute them across ALL jobs — pure Firestore, zero FieldRoutes reads —
    // so dashboard counts stay accurate without spending API quota.
    if (result.done) {
      // 1) Sweep job docs for subscriptions no longer active+recurring in
      //    FieldRoutes (cancelled/frozen). One cheap ID-only search; the rest is
      //    Firestore. This is what clears the stale past-dues for dead subs.
      try {
        const reconciled = await reconcileActiveSubscriptions();
        console.log(
          `[fieldroutes/manual-sync] reconciled active subs: deleted ${reconciled.deleted} stale, ` +
            `${reconciled.activeCount} active, ${reconciled.scanned} scanned` +
            (reconciled.skipped ? ` (SKIPPED: ${reconciled.reason})` : ""),
        );
      } catch (reconcileErr) {
        console.error("[fieldroutes/manual-sync] active-subscription reconcile failed:", reconcileErr);
      }
      // 2) Purge docs for inactive customers (test/demo accounts whose
      //    subscriptions are still active but the customer record is deactivated).
      try {
        const purgedCustomers = await purgeInactiveCustomers();
        if (purgedCustomers.deleted > 0) {
          console.log(
            `[fieldroutes/manual-sync] purged ${purgedCustomers.deleted} docs for inactive customers` +
              ` (${purgedCustomers.customersChecked} customers checked)`,
          );
        }
      } catch (purgeCustomerErr) {
        console.error("[fieldroutes/manual-sync] purge inactive customers failed:", purgeCustomerErr);
      }
      // 3) Purge any one-time/as-needed docs (keeps the app recurring-only).
      try {
        await purgeNonRecurring();
      } catch (purgeErr) {
        console.error("[fieldroutes/manual-sync] purge non-recurring after sync failed:", purgeErr);
      }
      // 4) Refresh derived date-window flags on the surviving recurring docs.
      try {
        await recomputePastDue();
      } catch (recomputeErr) {
        console.error("[fieldroutes/manual-sync] recompute after sync failed:", recomputeErr);
      }
    }
    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[fieldroutes/manual-sync] failed:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
