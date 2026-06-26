export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { FieldRoutesClient } from "@/lib/fieldroutes/client";

// Read-only diagnostic: dump the RAW FieldRoutes customer (and optionally
// subscription) JSON for a handful of IDs so we can see the exact field names
// and values that distinguish inactive / test / lead accounts. No writes.
//
//   /api/fieldroutes/debug-customer?ids=36037,36038,35057
//   /api/fieldroutes/debug-customer?ids=36037&subs=26838
//
// Returns each entity's full field set plus a "keys" list for quick scanning.
async function handle(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const ids = (params.get("ids") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const subIds = (params.get("subs") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (ids.length === 0 && subIds.length === 0) {
    return NextResponse.json(
      { error: "pass ?ids=customerID1,customerID2 (and/or ?subs=subID1,subID2)" },
      { status: 400 },
    );
  }

  try {
    const client = new FieldRoutesClient();
    const customers = ids.length ? await client.getEntities("customer", ids) : [];
    const subscriptions = subIds.length ? await client.getEntities("subscription", subIds) : [];

    return NextResponse.json({
      success: true,
      requestedCustomerIds: ids,
      requestedSubscriptionIds: subIds,
      customerKeys: customers[0] ? Object.keys(customers[0]).sort() : [],
      subscriptionKeys: subscriptions[0] ? Object.keys(subscriptions[0]).sort() : [],
      customers,
      subscriptions,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[fieldroutes/debug-customer] failed:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
