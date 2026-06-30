export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldRoutesClient } from "@/lib/fieldroutes/client";
import { loadBudget, recordApiUsage } from "@/lib/fieldroutes/usage";
import { computeMonthlyDone } from "@/lib/fieldroutes/monthly-done";

const FIELDROUTES_DEFAULT_BASE_URL = "https://flexpc.fieldroutes.com/api";
const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// POST { companyId? } -> compute this month's completed-appointment aggregate
// (Initials / Specialty / Wildlife / recurring done per line), cache it under
// companies/{id}/fieldRoutesState/monthlyDone, and return it + a verification
// sample. companyId is optional when there's a single company doc.
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

    // Respect the daily API budget.
    const budget = await loadBudget(db, companyId);
    client.setMaxReads(budget.remaining);
    if (budget.remaining <= 0) {
      return NextResponse.json({ error: "FieldRoutes API daily cap reached" }, { status: 429 });
    }

    let result;
    try {
      result = await computeMonthlyDone(client);
    } finally {
      await recordApiUsage(db, companyId, { reads: client.readCount });
    }

    await db.doc(`companies/${companyId}/fieldRoutesState/monthlyDone`).set(result.done, { merge: true });

    return NextResponse.json({ ...result.done, sample: result.sample, apiReads: client.readCount });
  } catch (err) {
    console.error("[fieldroutes/monthly-done] Error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
