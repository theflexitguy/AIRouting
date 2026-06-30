export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldRoutesClient } from "@/lib/fieldroutes/client";
import { loadBudget, recordApiUsage } from "@/lib/fieldroutes/usage";
import { centralTodayISO, toDateOnly, num } from "@/lib/fieldroutes/scope";
import { deriveServiceLine, serviceLineMeta, ServiceLine } from "@/lib/routing/service-line";

// Live reconciliation for a service line's monthly target: pulls ACTIVE
// subscriptions straight from FieldRoutes, classifies them, and shows exactly
// where the active-count drops to the in-scope count and then to the expected
// monthly-services target — so "315 active but target 221" becomes explainable.
//
//   POST { companyId?, line? }   (line defaults to "mosquito")

const FIELDROUTES_DEFAULT_BASE_URL = "https://flexpc.fieldroutes.com/api";
const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const str = (v: unknown): string => String(v ?? "").trim();
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

const monthOf = (iso: string): number | null => {
  const m = /^\d{4}-(\d{2})-\d{2}$/.exec(iso);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 12 ? n : null;
};

const AVG_DAYS_PER_MONTH = 30.4;

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { companyId?: string; line?: string };
    const line = (body.line || "mosquito").toLowerCase() as ServiceLine;
    const db = adminDb();

    let companyId = body.companyId && body.companyId !== "YOUR_COMPANY_ID" ? body.companyId : "";
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
    const budget = await loadBudget(db, companyId);
    client.setMaxReads(budget.remaining);
    if (budget.remaining <= 0) return NextResponse.json({ error: "FieldRoutes API daily cap reached" }, { status: 429 });

    const today = centralTodayISO();
    const monthIndex = Number(today.slice(5, 7));

    let subs: Record<string, unknown>[] = [];
    try {
      // ALL active subscriptions (active:1), classified client-side by serviceType.
      const ids = await client.searchIds("subscription", { active: 1 });
      subs = ids.length ? await client.getEntities("subscription", ids) : [];
    } finally {
      await recordApiUsage(db, companyId, { reads: client.readCount });
    }

    let activeInLine = 0;
    let onHoldCount = 0;
    let noChargeCount = 0;
    let nonRecurringCount = 0; // frequency <= 0
    let inScope = 0;
    let seasonalCount = 0;
    let offSeasonThisMonth = 0;
    let expectedTarget = 0;
    const byFrequency: Record<string, number> = {};
    const byServiceType: Record<string, number> = {};

    for (const s of subs) {
      const sr = rec(s);
      const serviceType = str(sr.serviceType);
      if (deriveServiceLine(serviceType) !== line) continue;
      activeInLine++;
      byServiceType[serviceType || "(blank)"] = (byServiceType[serviceType || "(blank)"] || 0) + 1;

      const onHold = num(sr.onHold);
      const charge = num(sr.recurringCharge);
      const frequency = num(sr.frequency);
      if (onHold !== 0) onHoldCount++;
      if (!(charge > 0)) noChargeCount++;
      if (!(frequency > 0)) nonRecurringCount++;

      const subInScope = onHold === 0 && charge > 0 && frequency > 0;
      if (!subInScope) continue;
      inScope++;

      // Effective interval (days): raw frequency, else the line default.
      const freqDays = frequency > 0 ? frequency : serviceLineMeta(line).defaultIntervalDays;
      byFrequency[String(freqDays)] = (byFrequency[String(freqDays)] || 0) + 1;

      // Seasonality: count only in active months (mosquito = its season window).
      const startMonth = monthOf(toDateOnly(sr.seasonalStart));
      const endMonth = monthOf(toDateOnly(sr.seasonalEnd));
      const isSeasonal = startMonth !== null && endMonth !== null;
      if (isSeasonal) seasonalCount++;
      const activeThisMonth = !isSeasonal
        ? true
        : startMonth <= endMonth
          ? monthIndex >= startMonth && monthIndex <= endMonth
          : monthIndex >= startMonth || monthIndex <= endMonth;
      if (!activeThisMonth) {
        offSeasonThisMonth++;
        continue;
      }
      expectedTarget += AVG_DAYS_PER_MONTH / freqDays;
    }

    return NextResponse.json({
      line,
      today,
      monthIndex,
      activeSubscriptionsInLine: activeInLine,
      droppedToInScope: {
        onHold: onHoldCount,
        noRecurringCharge: noChargeCount,
        nonRecurringFrequency: nonRecurringCount,
        inScope,
      },
      seasonality: { seasonalCount, offSeasonThisMonth, countedThisMonth: inScope - offSeasonThisMonth },
      expectedMonthlyTarget: Math.round(expectedTarget),
      byFrequencyDays: byFrequency,
      byServiceType,
      note: "active = all active subs in this line; inScope = active & charged & recurring; target = sum(30.4/intervalDays) over in-scope, in-season subs.",
      apiReads: client.readCount,
    });
  } catch (err) {
    console.error("[fieldroutes/debug-line-target] Error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
