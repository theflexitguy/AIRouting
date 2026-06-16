export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

function authorized(request: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) return false;
  const auth = request.headers.get("authorization") || "";
  if (auth === `Bearer ${secret}`) return true;
  if ((request.headers.get("x-cron-secret") || "") === secret) return true;
  if (new URL(request.url).searchParams.get("secret") === secret) return true;
  return false;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const companyId = (process.env.FIELDROUTES_COMPANY_ID || "").trim();
  if (!companyId) {
    return NextResponse.json({ error: "FIELDROUTES_COMPANY_ID not set" }, { status: 500 });
  }

  const db = adminDb();
  let phantomTechsDeleted = 0;
  let staleRoutesDeleted = 0;

  // 1. Delete all auto-created phantom technician docs (fr_* prefix).
  const techSnap = await db.collection(`companies/${companyId}/technicians`).get();
  let batch = db.batch();
  let ops = 0;
  for (const doc of techSnap.docs) {
    if (doc.id.startsWith("fr_")) {
      batch.delete(doc.ref);
      phantomTechsDeleted++;
      ops++;
      if (ops >= 450) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
  }

  // 2. Delete all FieldRoutes-generated route docs (they'll be rebuilt correctly).
  const routeSnap = await db.collection(`companies/${companyId}/routes`).get();
  for (const doc of routeSnap.docs) {
    const data = doc.data();
    if (data.source === "fieldroutes" || data.generatedBy === "fieldroutes") {
      batch.delete(doc.ref);
      staleRoutesDeleted++;
      ops++;
      if (ops >= 450) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
  }

  // 3. Clear the cached sync run state so the next sync starts completely fresh.
  const syncRef = db.doc(`companies/${companyId}/fieldRoutesState/sync`);
  batch.set(syncRef, { run: { active: false } }, { merge: true });
  ops++;

  // 4. Reset the daily manual sync counter.
  const limitRef = db.doc(`companies/${companyId}/fieldRoutesState/manualSync`);
  batch.set(limitRef, { date: "", count: 0 }, { merge: true });
  ops++;

  if (ops > 0) await batch.commit();

  return NextResponse.json({
    success: true,
    companyId,
    phantomTechsDeleted,
    staleRoutesDeleted,
    syncRunCleared: true,
    syncCounterReset: true,
    message: "Cleanup done. You now have 3 fresh manual syncs. Go to the Jobs page and run a sync.",
  });
}
