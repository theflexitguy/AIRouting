export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { recomputePastDue, purgeNonRecurring, reconcileActiveSubscriptions, purgeInactiveCustomers } from "@/lib/fieldroutes/sync";

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
  try {
    // Sweep cancelled/frozen subs (one cheap API search) and one-time/as-needed
    // stragglers, then refresh derived date-window flags.
    let reconciled: Awaited<ReturnType<typeof reconcileActiveSubscriptions>> | null = null;
    try {
      reconciled = await reconcileActiveSubscriptions();
    } catch (reconcileErr) {
      console.error("[fieldroutes/recompute-past-due] active-subscription reconcile failed:", reconcileErr);
    }
    let purgedInactive: Awaited<ReturnType<typeof purgeInactiveCustomers>> | null = null;
    try {
      purgedInactive = await purgeInactiveCustomers();
    } catch (purgeInactiveErr) {
      console.error("[fieldroutes/recompute-past-due] purge inactive customers failed:", purgeInactiveErr);
    }
    let purged: Awaited<ReturnType<typeof purgeNonRecurring>> | null = null;
    try {
      purged = await purgeNonRecurring();
    } catch (purgeErr) {
      console.error("[fieldroutes/recompute-past-due] purge non-recurring failed:", purgeErr);
    }
    const result = await recomputePastDue();
    return NextResponse.json({ success: true, ...result, reconciled, purgedInactive, purged });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[fieldroutes/recompute-past-due] failed:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
