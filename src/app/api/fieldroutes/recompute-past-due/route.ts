export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { recomputePastDue, purgeNonRecurring, reconcileActiveSubscriptions, purgeInactiveCustomers } from "@/lib/fieldroutes/sync";
import { guarded } from "@/lib/api-guard";

async function handle() {
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

async function GETHandler() {
  return handle();
}

async function POSTHandler() {
  return handle();
}

export const GET = guarded("operator", GETHandler);
export const POST = guarded("operator", POSTHandler);
