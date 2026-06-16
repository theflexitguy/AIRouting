export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { FieldRoutesClient } from "@/lib/fieldroutes/client";

// Temporary diagnostic: dumps the raw fields of a few pending appointments and
// the route entities they reference, so we can see exactly which field holds the
// assigned field technician (vs. the office person who created the appointment).
// Guarded by CRON_SECRET. Safe to delete once the tech-resolution field is known.
function authorized(request: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) return false;
  const auth = request.headers.get("authorization") || "";
  if (auth === `Bearer ${secret}`) return true;
  if ((request.headers.get("x-cron-secret") || "") === secret) return true;
  if (new URL(request.url).searchParams.get("secret") === secret) return true;
  return false;
}

function todayCentral(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const client = new FieldRoutesClient();
  const today = todayCentral();

  try {
    // A handful of pending future appointments.
    const apptIds = await client.searchIds("appointment", {
      status: 0,
      date: { operator: ">=", value: today },
    });
    const sampleApptIds = apptIds.slice(0, 5);
    const appts = sampleApptIds.length ? await client.getEntities("appointment", sampleApptIds) : [];

    // The route entities those appointments reference.
    const routeIds = Array.from(
      new Set(
        appts
          .map((a) => String((a as Record<string, unknown>).routeID ?? "").trim())
          .filter((v) => v && v !== "0"),
      ),
    );
    const routes = routeIds.length ? await client.getEntities("route", routeIds) : [];

    return NextResponse.json({
      today,
      totalPendingAppts: apptIds.length,
      sampleAppointmentFieldKeys: appts[0] ? Object.keys(appts[0]).sort() : [],
      sampleRouteFieldKeys: routes[0] ? Object.keys(routes[0]).sort() : [],
      appointments: appts,
      routes,
      apiReads: client.readCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
