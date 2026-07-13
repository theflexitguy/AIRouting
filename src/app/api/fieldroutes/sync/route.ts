export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { runSync, type SyncMode } from "@/lib/fieldroutes/sync";

// Guards the route with CRON_SECRET. Vercel Cron automatically sends
// `Authorization: Bearer ${CRON_SECRET}`; manual callers may use that header,
// `x-cron-secret`, or `?secret=`.
function authorized(request: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) return false; // fail closed — never run unguarded
  const auth = request.headers.get("authorization") || "";
  if (auth === `Bearer ${secret}`) return true;
  if ((request.headers.get("x-cron-secret") || "") === secret) return true;
  if (new URL(request.url).searchParams.get("secret") === secret) return true;
  return false;
}

async function handle(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);

  // ?action=cleanup wipes all stale FieldRoutes-derived data so the next sync
  // rebuilds it cleanly: phantom fr_* technician docs, FieldRoutes route docs,
  // the cached resumable-run state, and the daily manual-sync counter.
  if (url.searchParams.get("action") === "cleanup") {
    const companyId = (process.env.FIELDROUTES_COMPANY_ID || "").trim();
    if (!companyId) return NextResponse.json({ error: "no company id" }, { status: 500 });
    const db = adminDb();
    let phantomTechsDeleted = 0;
    let staleRoutesDeleted = 0;
    let batch = db.batch();
    let ops = 0;
    const flush = async (force = false) => {
      if (ops >= 450 || (force && ops > 0)) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    };

    const techSnap = await db.collection(`companies/${companyId}/technicians`).get();
    for (const doc of techSnap.docs) {
      if (doc.id.startsWith("fr_")) {
        batch.delete(doc.ref);
        phantomTechsDeleted++;
        ops++;
        await flush();
      }
    }

    const routeSnap = await db.collection(`companies/${companyId}/routes`).get();
    for (const doc of routeSnap.docs) {
      const data = doc.data();
      if (data.source === "fieldroutes" || data.generatedBy === "fieldroutes") {
        batch.delete(doc.ref);
        staleRoutesDeleted++;
        ops++;
        await flush();
      }
    }

    batch.set(db.doc(`companies/${companyId}/fieldRoutesState/manualSync`), { date: "", count: 0 }, { merge: true });
    ops++;
    await flush(true);

    // Clear the run OUTSIDE the batch via update() so `run` is REPLACED, not
    // deep-merged — a legacy bloated run.ids/apptMap would otherwise survive and
    // keep the doc over Firestore's 40k index-entry limit (set-merge on an
    // already-bloated doc is itself rejected). set() fallback creates it if absent.
    const syncStateRef = db.doc(`companies/${companyId}/fieldRoutesState/sync`);
    try {
      await syncStateRef.update({ run: { active: false } });
    } catch {
      await syncStateRef.set({ run: { active: false } }, { merge: true });
    }

    return NextResponse.json({
      success: true,
      phantomTechsDeleted,
      staleRoutesDeleted,
      syncRunCleared: true,
      syncCounterReset: true,
      message: "Cleanup complete. Run a sync (Jobs page or the sync URL) to rebuild cleanly.",
    });
  }

  // ?action=reset-sync-counter resets the manual sync daily limit.
  if (url.searchParams.get("action") === "reset-sync-counter") {
    const companyId = (process.env.FIELDROUTES_COMPANY_ID || "").trim();
    if (!companyId) return NextResponse.json({ error: "no company id" }, { status: 500 });
    const db = adminDb();
    await db.doc(`companies/${companyId}/fieldRoutesState/manualSync`).set({ date: "", count: 0 }, { merge: true });
    return NextResponse.json({ success: true, message: "Sync counter reset. You have 3 fresh syncs." });
  }

  let mode = (url.searchParams.get("mode") || "").toLowerCase();
  if (mode !== "full" && mode !== "incremental") {
    // Cron default is incremental; full is opt-in.
    const body = await request.json().catch(() => ({}));
    mode = String(body.mode || "incremental").toLowerCase();
  }
  if (mode !== "full" && mode !== "incremental") mode = "incremental";

  try {
    const result = await runSync(mode as SyncMode);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[fieldroutes/sync] failed:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
