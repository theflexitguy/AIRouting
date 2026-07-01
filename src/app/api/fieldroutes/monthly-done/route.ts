export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldRoutesClient } from "@/lib/fieldroutes/client";
import { loadBudget, recordApiUsage } from "@/lib/fieldroutes/usage";
import { computeMonthlyDone } from "@/lib/fieldroutes/monthly-done";
import { centralTodayISO } from "@/lib/fieldroutes/scope";

const FIELDROUTES_DEFAULT_BASE_URL = "https://flexpc.fieldroutes.com/api";
const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// Computes completed-appointment aggregates (Initials / Specialty / Wildlife /
// recurring done per line) and caches them per month under
// companies/{id}/monthlyDone/{YYYY-MM} (plus the legacy current-month doc at
// fieldRoutesState/monthlyDone). Powers the dashboard's history range selector.
//   POST { companyId?, month?, months? } or GET ?companyId=&month=&months=
//     month  = "YYYY-MM" to (re)compute a specific month (default: current)
//     months = N to backfill the last N months (current + N-1 prior), capped 24
// GET lets this be fetched directly (e.g. via a Vercel-protected fetch tool).

/** The last N month keys (YYYY-MM) ending at `today`'s month, newest first. */
function recentMonthKeys(today: string, n: number): string[] {
  const m = /^(\d{4})-(\d{2})/.exec(today);
  if (!m) return [today.slice(0, 7)];
  let year = Number(m[1]);
  let month = Number(m[2]); // 1-12
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    keys.push(`${year}-${String(month).padStart(2, "0")}`);
    month--;
    if (month === 0) { month = 12; year--; }
  }
  return keys;
}

async function handle(companyIdParam: string | undefined, monthParam?: string, monthsParam?: string) {
  try {
    const db = adminDb();

    let companyId = companyIdParam && companyIdParam !== "YOUR_COMPANY_ID" ? companyIdParam : "";
    if (!companyId) {
      const companies = await db.collection("companies").limit(5).get();
      if (companies.empty) return NextResponse.json({ error: "No company docs found" }, { status: 404 });
      if (companies.size > 1) {
        return NextResponse.json(
          { error: "Multiple companies — pass companyId", companyIds: companies.docs.map((d) => d.id) },
          { status: 400 },
        );
      }
      companyId = companies.docs[0].id;
    }

    const companySnap = await db.doc(`companies/${companyId}`).get();
    if (!companySnap.exists) return NextResponse.json({ error: "Company not found" }, { status: 404 });
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

    const client = new FieldRoutesClient({ baseUrl, authKey, authToken, timeoutMs: 45_000 });

    // Respect the daily API budget.
    const budget = await loadBudget(db, companyId);
    client.setMaxReads(budget.remaining);
    if (budget.remaining <= 0) {
      return NextResponse.json({ error: "FieldRoutes API daily cap reached" }, { status: 429 });
    }

    const today = centralTodayISO();
    // Which months to compute: an explicit month, a backfill of the last N, or
    // just the current month. Only backfill months not already cached (unless a
    // specific month was requested, which always recomputes).
    let monthsToCompute: string[];
    const backfillN = Math.min(24, Math.max(0, Number(monthsParam) || 0));
    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      monthsToCompute = [monthParam];
    } else if (backfillN > 0) {
      const keys = recentMonthKeys(today, backfillN);
      const existing = await Promise.all(
        keys.map((k) => db.doc(`companies/${companyId}/monthlyDone/${k}`).get()),
      );
      // Always refresh the current month; only fill gaps for prior months.
      monthsToCompute = keys.filter((k, i) => k === today.slice(0, 7) || !existing[i].exists);
    } else {
      monthsToCompute = [today.slice(0, 7)];
    }

    const results: Array<Record<string, unknown>> = [];
    try {
      for (const mk of monthsToCompute) {
        if (client.readCount >= budget.remaining) break; // out of budget — stop cleanly
        const { done, sample } = await computeMonthlyDone(client, today, mk);
        await db.doc(`companies/${companyId}/monthlyDone/${done.month}`).set(done);
        if (done.month === today.slice(0, 7)) {
          await db.doc(`companies/${companyId}/fieldRoutesState/monthlyDone`).set(done);
        }
        results.push(mk === monthsToCompute[0] ? { ...done, sample } : done);
      }
    } finally {
      await recordApiUsage(db, companyId, { reads: client.readCount });
    }

    return NextResponse.json({
      computedMonths: results.map((r) => r.month),
      results,
      apiReads: client.readCount,
    });
  } catch (err) {
    console.error("[fieldroutes/monthly-done] Error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { companyId?: string; month?: string; months?: string | number };
  return handle(body.companyId, body.month, body.months !== undefined ? String(body.months) : undefined);
}

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  return handle(params.get("companyId") || undefined, params.get("month") || undefined, params.get("months") || undefined);
}
