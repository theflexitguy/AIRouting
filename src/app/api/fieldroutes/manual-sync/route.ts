export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth } from "@/lib/firebase-admin";
import { runSync, recomputePastDue, purgeNonRecurring, reconcileActiveSubscriptions } from "@/lib/fieldroutes/sync";

const MAX_MANUAL_SYNCS_PER_DAY = 3;

function todayCentral(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

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

  const today = todayCentral();
  const limitRef = db.doc(`companies/${companyId}/fieldRoutesState/manualSync`);
  const limitSnap = await limitRef.get();
  const limitData = limitSnap.data() || {};

  let usedToday = 0;
  if (limitData.date === today) {
    usedToday = limitData.count || 0;
  }

  // The sync is resumable: one user-initiated sync may take several POSTs to
  // finish. Only the first call of a session (when no run is in progress) counts
  // against the daily limit and is rate-limited — continuations always proceed.
  const syncStateSnap = await db.doc(`companies/${companyId}/fieldRoutesState/sync`).get();
  const runActive = Boolean((syncStateSnap.data()?.run as { active?: boolean } | undefined)?.active);
  const isNewSession = !runActive;

  if (isNewSession) {
    if (usedToday >= MAX_MANUAL_SYNCS_PER_DAY) {
      return NextResponse.json(
        {
          error: "Daily sync limit reached",
          limit: MAX_MANUAL_SYNCS_PER_DAY,
          used: usedToday,
          remaining: 0,
        },
        { status: 429 },
      );
    }
    usedToday += 1;
    await limitRef.set({ date: today, count: usedToday }, { merge: true });
  }

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
      // 2) Purge any one-time/as-needed docs (keeps the app recurring-only).
      try {
        await purgeNonRecurring();
      } catch (purgeErr) {
        console.error("[fieldroutes/manual-sync] purge non-recurring after sync failed:", purgeErr);
      }
      // 3) Refresh derived date-window flags on the surviving recurring docs.
      try {
        await recomputePastDue();
      } catch (recomputeErr) {
        console.error("[fieldroutes/manual-sync] recompute after sync failed:", recomputeErr);
      }
    }
    return NextResponse.json({
      success: true,
      ...result,
      syncLimit: {
        limit: MAX_MANUAL_SYNCS_PER_DAY,
        used: usedToday,
        remaining: Math.max(0, MAX_MANUAL_SYNCS_PER_DAY - usedToday),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[fieldroutes/manual-sync] failed:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
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

  const today = todayCentral();
  const limitRef = db.doc(`companies/${companyId}/fieldRoutesState/manualSync`);
  const limitSnap = await limitRef.get();
  const limitData = limitSnap.data() || {};

  let usedToday = 0;
  if (limitData.date === today) {
    usedToday = limitData.count || 0;
  }

  return NextResponse.json({
    limit: MAX_MANUAL_SYNCS_PER_DAY,
    used: usedToday,
    remaining: MAX_MANUAL_SYNCS_PER_DAY - usedToday,
  });
}
