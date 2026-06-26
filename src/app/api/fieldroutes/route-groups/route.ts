import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldRoutesClient } from "@/lib/fieldroutes/client";

const FIELDROUTES_DEFAULT_BASE_URL = "https://flexpc.fieldroutes.com/api";

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// YYYY-MM-DD for `days` ago in America/Chicago (matches the rest of the app).
function centralDaysAgo(days: number): string {
  const now = new Date();
  const past = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return past.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

// Returns the distinct route-group titles (e.g. "GPC", "Specialty", "Wildlife",
// "Lawn") seen on recent FieldRoutes routes. FieldRoutes has no clean "list all
// groups" endpoint that returns titles, but each route carries a stable
// `groupTitle`, so we derive the list from routes in a recent window.
export async function POST(request: Request) {
  try {
    const { companyId } = (await request.json()) as { companyId?: string };
    if (!companyId) {
      return NextResponse.json({ error: "companyId is required" }, { status: 400 });
    }

    const db = adminDb();
    const companySnap = await db.doc(`companies/${companyId}`).get();
    if (!companySnap.exists) {
      return NextResponse.json({ error: "Company not found" }, { status: 404 });
    }

    const company = companySnap.data() || {};
    const authKey = clean(company.fieldRoutesApiKey || process.env.FIELDROUTES_AUTH_KEY);
    const authToken = clean(
      company.fieldRoutesApiToken ||
        company.fieldRoutesApiSecret ||
        process.env.FIELDROUTES_AUTH_TOKEN ||
        process.env.FIELDROUTES_API_SECRET,
    );
    if (!authKey || !authToken) {
      return NextResponse.json({ error: "FieldRoutes API credentials not configured" }, { status: 400 });
    }

    const baseUrl = clean(
      company.fieldRoutesNwaBaseUrl ||
        company.fieldRoutesNWAApiBaseUrl ||
        process.env.FIELDROUTES_NWA_BASE_URL ||
        FIELDROUTES_DEFAULT_BASE_URL,
    );

    const client = new FieldRoutesClient({ baseUrl, authKey, authToken, timeoutMs: 30_000 });

    // Pull recent routes (resolved) and collect distinct group titles. A ~21-day
    // window stays well under the 1,000-record includeData cap while still
    // surfacing every active group (each recurs across the days).
    const routes = await client.searchWithData("route", {
      date: { operator: ">=", value: centralDaysAgo(21) },
    });
    const titles = new Set<string>();
    for (const r of routes) {
      const t = clean((r as Record<string, unknown>).groupTitle);
      if (t) titles.add(t);
    }
    const routeGroups = Array.from(titles).sort((a, b) => a.localeCompare(b));

    return NextResponse.json({ routeGroups, apiCalls: client.readCount });
  } catch (err) {
    console.error("[fieldroutes/route-groups] Error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
