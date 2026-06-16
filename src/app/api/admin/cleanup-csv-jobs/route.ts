export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

// Stop deleting once we approach the function time budget; the caller repeats
// the request until the response reports done:true.
const SOFT_DEADLINE_MS = 45_000;

// Same fail-closed guard as the sync routes.
function authorized(request: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) return false;
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
  const companyId = (
    url.searchParams.get("companyId") ||
    process.env.FIELDROUTES_COMPANY_ID ||
    ""
  ).trim();
  if (!companyId) {
    return NextResponse.json(
      { error: "companyId is required (set FIELDROUTES_COMPANY_ID or pass ?companyId=)" },
      { status: 400 },
    );
  }
  // Preview without deleting when ?dryRun=1.
  const dryRun =
    url.searchParams.get("dryRun") === "1" || url.searchParams.get("dryRun") === "true";

  const startMs = Date.now();
  const db = adminDb();
  const col = db.collection(`companies/${companyId}/jobs`);

  const snap = await col.get();

  let scanned = 0;
  let matched = 0;
  let deleted = 0;
  let batch = db.batch();
  let ops = 0;
  let timedOut = false;

  for (const doc of snap.docs) {
    scanned++;
    // Keep only jobs the live sync wrote. Everything else (CSV uploads, manual
    // entries, docs with no source field) is stale and removed.
    if (doc.data().source !== "api") {
      matched++;
      if (!dryRun) {
        batch.delete(doc.ref);
        ops++;
        deleted++;
        if (ops >= 450) {
          await batch.commit();
          batch = db.batch();
          ops = 0;
        }
      }
    }
    if (Date.now() - startMs > SOFT_DEADLINE_MS) {
      timedOut = true;
      break;
    }
  }
  if (ops > 0) await batch.commit();

  const done = !timedOut;
  const message = dryRun
    ? `Dry run: ${matched} of ${scanned} jobs are non-api (nothing deleted).`
    : done
      ? `Cleanup complete: deleted ${deleted} non-api jobs (kept ${scanned - matched}).`
      : `Deleted ${deleted} non-api jobs so far; time budget reached. Call again to continue.`;

  return NextResponse.json({ success: true, companyId, dryRun, scanned, matched, deleted, done, message });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
