export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldRoutesClient } from "@/lib/fieldroutes/client";
import { loadBudget, recordApiUsage } from "@/lib/fieldroutes/usage";
import { centralTodayISO, toDateOnly, num } from "@/lib/fieldroutes/scope";
import { deriveServiceLine, serviceLineMeta, isInScopeForLine, lawnRoundSeasonalWindow, ServiceLine } from "@/lib/routing/service-line";
import { TARGET_SERVICE_LINES, TARGET_SERVICE_LINE_LABELS } from "@/lib/metrics/operational";

// Live reconciliation for ALL service-line monthly targets in ONE FieldRoutes
// pull: fetches every active subscription once, classifies each by line, and
// for every tracked line (General Pest / Mosquito / Lawn / Termite / Commercial)
// reports active -> in-scope -> expected-target, PLUS what's currently stored in
// Firestore for that line — so a stale-sync drift is visible directly, not
// guessed at. GR and Wildlife are included for visibility (excluded from the
// dashboard's monthly target by design).
//
//   POST { companyId? }   — single call, no `line` param needed.

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
const ALL_LINES: ServiceLine[] = ["general", "mosquito", "lawn", "termite", "commercial", "gr", "wildlife"];

interface LineAgg {
  line: ServiceLine;
  label: string;
  tracked: boolean; // counted in the dashboard's Monthly Targets / Total
  activeSubscriptions: number;
  onHold: number;
  nonRecurringFrequency: number;
  zeroChargeIncluded: number; // active $0 subs (e.g. bundled) — counted, not dropped
  inScope: number;
  seasonalCount: number;
  offSeasonThisMonth: number;
  liveExpectedTarget: number;
  storedInScopeJobs: number; // what's currently in Firestore for this line
  storedTarget: number; // same target math, run over the STORED docs
  driftFlag: boolean; // live target vs stored target differ by >5%
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { companyId?: string };
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

    // 1) ONE live pull of every active subscription.
    let subs: Record<string, unknown>[] = [];
    let servicePlanRoundById = new Map<string, Record<string, unknown>>();
    try {
      const ids = await client.searchIds("subscription", { active: 1 });
      subs = ids.length ? await client.getEntities("subscription", ids) : [];
      // Lawn "Round N" rows are servicePlanRound entities with the REAL
      // per-customer/per-cycle startDate/endDate (a separate resource from the
      // generic subscription record) — fetch it so this matches what production
      // sync now stamps, instead of a flat/hardcoded window.
      const lawnRoundIds = subs
        .map((s) => rec(s))
        .filter((sr) => deriveServiceLine(str(sr.serviceType)) === "lawn")
        .map((sr) => str(sr.subscriptionID))
        .filter(Boolean);
      if (lawnRoundIds.length) {
        const rounds = await client.getEntities("servicePlanRound", lawnRoundIds, { idParam: "subscriptionIDs" });
        servicePlanRoundById = new Map(rounds.map((r) => [str(rec(r).subscriptionID), rec(r)]));
      }
    } finally {
      await recordApiUsage(db, companyId, { reads: client.readCount });
    }

    // 2) ONE read of every synced job doc, for the stored-vs-live comparison.
    const jobsSnap = await db.collection(`companies/${companyId}/jobs`).where("source", "==", "api").get();
    const storedByLine = new Map<string, Record<string, unknown>[]>();
    for (const doc of jobsSnap.docs) {
      const d = doc.data();
      // Mirror the dashboard's client-side fallback: most docs predate the
      // serviceLine stamping, so derive it the same way the UI does rather than
      // dumping everything without a stored field into "general".
      const ln = str(d.serviceLine) || deriveServiceLine(d.serviceType, d.fieldRoutesRouteGroup);
      if (!storedByLine.has(ln)) storedByLine.set(ln, []);
      storedByLine.get(ln)!.push(d);
    }

    const tracked = new Set<string>(TARGET_SERVICE_LINES as readonly string[]);
    const lines: LineAgg[] = ALL_LINES.map((line) => ({
      line,
      label: (TARGET_SERVICE_LINE_LABELS as Record<string, string>)[line] || line,
      tracked: tracked.has(line),
      activeSubscriptions: 0,
      onHold: 0,
      nonRecurringFrequency: 0,
      zeroChargeIncluded: 0,
      inScope: 0,
      seasonalCount: 0,
      offSeasonThisMonth: 0,
      liveExpectedTarget: 0,
      storedInScopeJobs: 0,
      storedTarget: 0,
      driftFlag: false,
    }));
    const byLine = new Map(lines.map((l) => [l.line, l]));

    for (const s of subs) {
      const sr = rec(s);
      const serviceType = str(sr.serviceType);
      const line = deriveServiceLine(serviceType);
      const agg = byLine.get(line);
      if (!agg) continue; // shouldn't happen — ALL_LINES covers every ServiceLine
      agg.activeSubscriptions++;

      const onHold = num(sr.onHold);
      const charge = num(sr.recurringCharge);
      const frequency = num(sr.frequency);
      if (onHold !== 0) agg.onHold++;
      if (!(charge > 0)) agg.zeroChargeIncluded++;
      if (!(frequency > 0)) agg.nonRecurringFrequency++;

      // Same scope rule production uses, INCLUDING the Lawn carve-out (active +
      // not-on-hold lawn rounds count despite their placeholder frequency).
      const subInScope = isInScopeForLine({
        line,
        onHold: sr.onHold,
        recurringCharge: sr.recurringCharge,
        frequency: sr.frequency,
        active: sr.active,
      });
      if (!subInScope) continue;
      agg.inScope++;

      // Lawn rounds: prefer the REAL per-cycle window from servicePlanRound,
      // falling back to the hardcoded round-number table — same precedence
      // production sync uses. The effective interval scales with the window
      // length (a round fires ONCE within its ~6-week window, not on a flat
      // 365-day cycle), matching the production target-math fix.
      const planRound = servicePlanRoundById.get(str(sr.subscriptionID));
      const planRoundStart = planRound ? monthOf(toDateOnly(planRound.startDate)) : null;
      const planRoundEnd = planRound ? monthOf(toDateOnly(planRound.endDate)) : null;
      const lawnWindow =
        line === "lawn"
          ? planRoundStart !== null && planRoundEnd !== null
            ? { startMonth: planRoundStart, endMonth: planRoundEnd }
            : lawnRoundSeasonalWindow(serviceType)
          : null;
      const startMonth = lawnWindow ? lawnWindow.startMonth : monthOf(toDateOnly(sr.seasonalStart));
      const endMonth = lawnWindow ? lawnWindow.endMonth : monthOf(toDateOnly(sr.seasonalEnd));
      const isSeasonal = startMonth !== null && endMonth !== null;
      const windowMonths = isSeasonal ? endMonth - startMonth + 1 : 0;
      const freqDays =
        frequency > 0
          ? frequency
          : lawnWindow && windowMonths > 0
            ? windowMonths * AVG_DAYS_PER_MONTH
            : serviceLineMeta(line).defaultIntervalDays;
      if (isSeasonal) agg.seasonalCount++;
      const activeThisMonth = !isSeasonal
        ? true
        : startMonth <= endMonth
          ? monthIndex >= startMonth && monthIndex <= endMonth
          : monthIndex >= startMonth || monthIndex <= endMonth;
      if (!activeThisMonth) {
        agg.offSeasonThisMonth++;
        continue;
      }
      agg.liveExpectedTarget += AVG_DAYS_PER_MONTH / freqDays;
    }

    // Stored-data target, computed the SAME way the dashboard does, over whatever
    // is currently sitting in Firestore — this is what the UI is actually showing.
    for (const agg of lines) {
      const docs = storedByLine.get(agg.line) || [];
      let storedInScope = 0;
      let storedTarget = 0;
      for (const d of docs) {
        if (d.inScope !== true || d.pendingCancel === true) continue;
        storedInScope++;
        const freq = num(d.frequency);
        const days = freq > 0 ? freq : serviceLineMeta(agg.line).defaultIntervalDays;
        if (!(days > 0)) continue;
        const startMonth = Number(d.seasonalStartMonth) || null;
        const endMonth = Number(d.seasonalEndMonth) || null;
        const isSeasonal = Boolean(d.isSeasonal) && startMonth && endMonth;
        const activeThisMonth = !isSeasonal
          ? true
          : (startMonth as number) <= (endMonth as number)
            ? monthIndex >= (startMonth as number) && monthIndex <= (endMonth as number)
            : monthIndex >= (startMonth as number) || monthIndex <= (endMonth as number);
        if (!activeThisMonth) continue;
        storedTarget += AVG_DAYS_PER_MONTH / days;
      }
      agg.storedInScopeJobs = storedInScope;
      agg.storedTarget = Math.round(storedTarget);
      agg.liveExpectedTarget = Math.round(agg.liveExpectedTarget);
      const live = agg.liveExpectedTarget;
      const stored = agg.storedTarget;
      const denom = Math.max(1, live);
      agg.driftFlag = Math.abs(live - stored) / denom > 0.05;
    }

    const trackedLines = lines.filter((l) => l.tracked);
    const totals = {
      liveExpectedTarget: trackedLines.reduce((s, l) => s + l.liveExpectedTarget, 0),
      storedTarget: trackedLines.reduce((s, l) => s + l.storedTarget, 0),
      activeSubscriptions: trackedLines.reduce((s, l) => s + l.activeSubscriptions, 0),
      inScope: trackedLines.reduce((s, l) => s + l.inScope, 0),
    };

    return NextResponse.json({
      today,
      monthIndex,
      totalActiveSubscriptionsPulled: subs.length,
      totalStoredJobDocs: jobsSnap.size,
      lines,
      trackedTotals: totals,
      driftedLines: lines.filter((l) => l.driftFlag).map((l) => l.line),
      note:
        "live* = computed fresh from FieldRoutes right now. stored* = what the dashboard currently shows " +
        "(synced Firestore data). A mismatch means the synced docs are stale — run a full Sync (after " +
        "resetting the cursor) to bring them in line with live*.",
      apiReads: client.readCount,
    });
  } catch (err) {
    console.error("[fieldroutes/debug-line-target] Error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
