export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
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
