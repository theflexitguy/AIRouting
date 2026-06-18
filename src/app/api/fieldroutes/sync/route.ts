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

  // ?action=inspect-employees dumps a few employee records so we can see fields.
  if (url.searchParams.get("action") === "inspect-employees") {
    const { FieldRoutesClient } = await import("@/lib/fieldroutes/client");
    const client = new FieldRoutesClient();
    const empIds = await client.searchIds("employee", {});
    const emps = empIds.length ? await client.getEntities("employee", empIds.slice(0, 10)) : [];
    return NextResponse.json({
      totalEmployees: empIds.length,
      sampleFieldKeys: emps[0] ? Object.keys(emps[0] as Record<string, unknown>).sort() : [],
      employees: emps,
      apiReads: client.readCount,
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
