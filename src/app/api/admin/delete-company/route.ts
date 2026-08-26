export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

// Permanently remove a company and everything under it. This is IRREVERSIBLE,
// so it is deliberately hard to fire by accident:
//
//   POST /api/admin/delete-company
//   { "companyId": "x", "confirm": "x" }            -> dry run (counts only)
//   { "companyId": "x", "confirm": "x", "dryRun": false } -> actually deletes
//
// Guards, all of which refuse the delete outright:
//   * confirm must repeat the companyId exactly
//   * no user profile may still point at it (an orphaned login can't sign in)
//   * it must not be the company the FieldRoutes sync writes to — checked
//     against FIELDROUTES_COMPANY_ID and, failing that, against which company
//     synced most recently
//
// Deletes companies/{id} with every subcollection, plus the routeGeneration
// lock — the only two places keyed by company id.

interface Body {
  companyId?: string;
  confirm?: string;
  dryRun?: boolean;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const companyId = String(body.companyId || "").trim();
  const confirm = String(body.confirm || "").trim();
  // Deleting is opt-IN: anything other than an explicit false stays a dry run.
  const dryRun = body.dryRun !== false;

  if (!companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }
  if (confirm !== companyId) {
    return NextResponse.json(
      { error: "confirm must repeat companyId exactly", companyId, confirm },
      { status: 400 },
    );
  }

  try {
    const db = adminDb();
    const companyRef = db.doc(`companies/${companyId}`);
    const companySnap = await companyRef.get();
    if (!companySnap.exists) {
      return NextResponse.json({ error: `Company ${companyId} does not exist` }, { status: 404 });
    }

    // --- Guard 1: no login may be left pointing at a company that's gone ---
    const usersSnap = await db.collection("users").where("companyId", "==", companyId).get();
    if (!usersSnap.empty) {
      return NextResponse.json(
        {
          error: "Refusing to delete: user profiles still point at this company",
          companyId,
          users: usersSnap.docs.map((d) => ({ uid: d.id, email: d.data().email || "(no email)" })),
          hint: "Reassign them first: POST /api/admin/diagnose-user { email, targetCompanyId }",
        },
        { status: 409 },
      );
    }

    // --- Guard 2: never delete the company the sync feeds ---
    const envCompanyId = String(process.env.FIELDROUTES_COMPANY_ID || "").trim();
    if (envCompanyId && envCompanyId === companyId) {
      return NextResponse.json(
        { error: "Refusing to delete: this is the company FIELDROUTES_COMPANY_ID points at", companyId },
        { status: 409 },
      );
    }
    const companies = await db.collection("companies").get();
    const lastRuns = await Promise.all(
      companies.docs.map(async (d) => {
        const sync = await db.doc(`companies/${d.id}/fieldRoutesState/sync`).get();
        return { id: d.id, lastRunAt: String(sync.data()?.lastRunAt || "") };
      }),
    );
    const mostRecent = lastRuns.reduce((a, b) => (b.lastRunAt > a.lastRunAt ? b : a), lastRuns[0]);
    if (mostRecent && mostRecent.id === companyId && mostRecent.lastRunAt) {
      return NextResponse.json(
        {
          error: "Refusing to delete: this company synced most recently, so it looks like the live one",
          companyId,
          lastRuns,
        },
        { status: 409 },
      );
    }

    // --- What is actually in here ---
    const subcollections = await companyRef.listCollections();
    const counts: Record<string, number> = {};
    for (const col of subcollections) {
      const agg = await col.count().get();
      counts[col.id] = agg.data().count;
    }
    const lockRef = db.doc(`routeGeneration/${companyId}`);
    const lockExists = (await lockRef.get()).exists;

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        companyId,
        companyName: companySnap.data()?.name || "(unnamed)",
        wouldDelete: { company: 1, routeGenerationLock: lockExists ? 1 : 0, subcollections: counts },
        lastRuns,
        note: "Nothing was deleted. Re-send with \"dryRun\": false to perform the deletion.",
      });
    }

    // recursiveDelete walks every descendant, so subcollections go with it.
    await db.recursiveDelete(companyRef);
    if (lockExists) await lockRef.delete();

    return NextResponse.json({
      deleted: true,
      companyId,
      companyName: companySnap.data()?.name || "(unnamed)",
      removed: { company: 1, routeGenerationLock: lockExists ? 1 : 0, subcollections: counts },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[admin/delete-company] failed:", message);
    return NextResponse.json({ error: message, companyId }, { status: 500 });
  }
}
