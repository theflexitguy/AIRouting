export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

// Deletes ALL FieldRoutes-sourced job docs (source == "api") for a company so a
// subsequent full sync rebuilds them clean — clearing any stragglers left by an
// older code version. Leaves CSV-uploaded / manual jobs and route docs intact.
//
// Destructive, so it requires an explicit confirm token:
//   /api/fieldroutes/reset-jobs?companyId=company_xxx&confirm=DELETE
//
// After running, trigger a normal sync from the Jobs tab to repopulate.
async function resetJobs(companyId: string | undefined, confirm: string | undefined) {
  if (!companyId) {
    return NextResponse.json({ success: false, error: "companyId is required" }, { status: 400 });
  }
  if (confirm !== "DELETE") {
    return NextResponse.json(
      { success: false, error: "add &confirm=DELETE to confirm this destructive reset" },
      { status: 400 },
    );
  }

  try {
    const db = adminDb();
    const col = db.collection(`companies/${companyId}/jobs`);
    const snap = await col.where("source", "==", "api").get();

    let batch = db.batch();
    let ops = 0;
    let deleted = 0;
    for (const doc of snap.docs) {
      batch.delete(doc.ref);
      deleted++;
      ops++;
      if (ops >= 450) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();

    return NextResponse.json({ success: true, companyId, scanned: snap.size, deleted });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[fieldroutes/reset-jobs] failed:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  return resetJobs(params.get("companyId") || undefined, params.get("confirm") || undefined);
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { companyId?: string; confirm?: string };
  return resetJobs(body.companyId, body.confirm);
}
