export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldRoutesClient } from "@/lib/fieldroutes/client";

const FIELDROUTES_DEFAULT_BASE_URL = "https://flexpc.fieldroutes.com/api";

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function str(v: unknown): string {
  return String(v ?? "").trim();
}
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

// Read-only diagnostic for the "everything shows Unassigned" problem. For a given
// date it dumps, per appointment: the appointment's own assignedTech, the
// assignedTech of the ROUTE it sits on (what sync currently uses), the route
// group, and how each would resolve to a technician name. Compare the two tech
// columns to see where the real tech lives.
//
//   /api/fieldroutes/debug-appointments?companyId=company_xxx&date=2026-06-29
async function handle(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const companyId = clean(params.get("companyId"));
  const date = clean(params.get("date"));
  if (!companyId || !date) {
    return NextResponse.json({ error: "pass ?companyId=...&date=YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const db = adminDb();
    const companySnap = await db.doc(`companies/${companyId}`).get();
    const company = companySnap.data() || {};
    const authKey = clean(company.fieldRoutesApiKey || process.env.FIELDROUTES_AUTH_KEY);
    const authToken = clean(
      company.fieldRoutesApiToken ||
        company.fieldRoutesApiSecret ||
        process.env.FIELDROUTES_AUTH_TOKEN ||
        process.env.FIELDROUTES_API_SECRET,
    );
    const baseUrl = clean(
      company.fieldRoutesNwaBaseUrl ||
        company.fieldRoutesNWAApiBaseUrl ||
        process.env.FIELDROUTES_NWA_BASE_URL ||
        FIELDROUTES_DEFAULT_BASE_URL,
    );
    if (!authKey || !authToken) {
      return NextResponse.json({ error: "FieldRoutes API credentials not configured" }, { status: 400 });
    }

    const client = new FieldRoutesClient({ baseUrl, authKey, authToken, timeoutMs: 45_000 });

    // Appointments on the given date.
    const apptIds = await client.searchIds("appointment", { date });
    const appts = apptIds.length ? await client.getEntities("appointment", apptIds) : [];

    // Routes those appointments belong to.
    const routeIds = Array.from(
      new Set(appts.map((a) => str(rec(a).routeID)).filter((r) => r && r !== "0")),
    );
    const routes = routeIds.length ? await client.getEntities("route", routeIds) : [];
    const routeById = new Map(routes.map((r) => [str(rec(r).routeID), rec(r)]));

    // Employee names for tech resolution.
    const empIds = new Set<string>();
    for (const a of appts) {
      const at = str(rec(a).assignedTech);
      if (at && at !== "0") empIds.add(at);
    }
    for (const r of routes) {
      const rt = str(rec(r).assignedTech);
      if (rt && rt !== "0") empIds.add(rt);
    }
    const employees = empIds.size ? await client.getEntities("employee", Array.from(empIds)) : [];
    const empName = new Map<string, string>();
    for (const e of employees) {
      const er = rec(e);
      const id = str(er.employeeID || er.employeeId);
      const name = [str(er.fname), str(er.lname)].filter(Boolean).join(" ") || str(er.name);
      if (id) empName.set(id, name);
    }

    let apptAssignedCount = 0;
    let routeAssignedCount = 0;
    let neitherCount = 0;
    const rows = appts.map((a) => {
      const ar = rec(a);
      const routeId = str(ar.routeID);
      const route = routeById.get(routeId) || {};
      const apptTech = str(ar.assignedTech);
      const routeTech = str(route.assignedTech);
      const apptHas = Boolean(apptTech && apptTech !== "0");
      const routeHas = Boolean(routeTech && routeTech !== "0");
      if (apptHas) apptAssignedCount++;
      if (routeHas) routeAssignedCount++;
      if (!apptHas && !routeHas) neitherCount++;
      return {
        appointmentID: str(ar.appointmentID),
        subscriptionID: str(ar.subscriptionID),
        customerID: str(ar.customerID),
        date: str(ar.date),
        status: str(ar.status),
        routeID: routeId,
        routeGroupTitle: str(route.groupTitle),
        appointmentAssignedTech: apptTech,
        appointmentTechName: apptHas ? empName.get(apptTech) || apptTech : "",
        routeAssignedTech: routeTech,
        routeTechName: routeHas ? empName.get(routeTech) || routeTech : "",
        // What sync stores today (route-based only) vs. appt-first fallback.
        resolvedByCurrentLogic: routeHas ? empName.get(routeTech) || routeTech : "(unassigned)",
        resolvedByApptFirst: apptHas
          ? empName.get(apptTech) || apptTech
          : routeHas
            ? empName.get(routeTech) || routeTech
            : "(unassigned)",
      };
    });

    return NextResponse.json({
      success: true,
      date,
      apptCount: appts.length,
      summary: {
        withAppointmentTech: apptAssignedCount,
        withRouteTech: routeAssignedCount,
        withNeither: neitherCount,
      },
      apiReads: client.readCount,
      appointments: rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[fieldroutes/debug-appointments] failed:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}
export async function POST(request: NextRequest) {
  return handle(request);
}
