import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { centralTodayISO } from "@/lib/fieldroutes/scope";
import { deriveServiceLine } from "@/lib/routing/service-line";

// Read-only diagnostic over already-synced job docs (Firestore only — no
// FieldRoutes API calls). Answers two questions:
//   1. Why is a service line (e.g. Lawn) showing 0 done? -> see how each
//      serviceType buckets + how many completed this month.
//   2. How do "Initial" services appear? -> distinct serviceType strings + an
//      initial-label flag, so we can split new-signup initials from recurring.
//
//   POST { companyId } -> per-serviceType breakdown + initial summary.

const isInitialLabel = (s: string) => /initial/i.test(s);

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { companyId?: string };
    const db = adminDb();

    // companyId is optional: when omitted, auto-detect the only company doc so
    // this read-only diagnostic can be run with an empty body from the browser.
    let companyId = body.companyId && body.companyId !== "YOUR_COMPANY_ID" ? body.companyId : "";
    if (!companyId) {
      const companies = await db.collection("companies").limit(5).get();
      if (companies.empty) {
        return NextResponse.json({ error: "No company docs found" }, { status: 404 });
      }
      if (companies.size > 1) {
        return NextResponse.json(
          { error: "Multiple companies — pass companyId", companyIds: companies.docs.map((d) => d.id) },
          { status: 400 },
        );
      }
      companyId = companies.docs[0].id;
    }
    const today = centralTodayISO();
    const monthStart = `${today.slice(0, 7)}-01`;

    const snap = await db
      .collection(`companies/${companyId}/jobs`)
      .where("source", "==", "api")
      .get();

    interface Agg {
      serviceType: string;
      storedServiceLine: string;
      derivedServiceLine: string;
      isInitial: boolean;
      total: number;
      inScope: number;
      withLastCompleted: number;
      completedThisMonth: number;
      sampleStatuses: Record<string, number>;
      sampleRecurringFrequency: Record<string, number>;
    }

    const byType = new Map<string, Agg>();
    const bump = (m: Record<string, number>, k: string) => {
      if (!k) return;
      m[k] = (m[k] || 0) + 1;
    };

    for (const doc of snap.docs) {
      const d = doc.data();
      const serviceType = String(d.serviceType ?? "");
      const key = serviceType || "(blank)";
      let a = byType.get(key);
      if (!a) {
        a = {
          serviceType: key,
          storedServiceLine: String(d.serviceLine ?? ""),
          derivedServiceLine: deriveServiceLine(serviceType, d.fieldRoutesRouteGroup),
          isInitial: isInitialLabel(serviceType),
          total: 0,
          inScope: 0,
          withLastCompleted: 0,
          completedThisMonth: 0,
          sampleStatuses: {},
          sampleRecurringFrequency: {},
        };
        byType.set(key, a);
      }
      a.total++;
      if (d.inScope === true) a.inScope++;
      const last = String(d.subscriptionLastCompletedDate ?? "");
      if (/^\d{4}-\d{2}-\d{2}$/.test(last)) {
        a.withLastCompleted++;
        if (last >= monthStart && last <= today) a.completedThisMonth++;
      }
      bump(a.sampleStatuses, String(d.status ?? ""));
      bump(a.sampleRecurringFrequency, String(d.recurringFrequency ?? ""));
    }

    const rows = Array.from(byType.values()).sort((a, b) => b.total - a.total);

    // Roll up by derived service line so the Lawn / Mosquito / etc. picture is clear.
    const byLine = new Map<string, { line: string; total: number; inScope: number; completedThisMonth: number; serviceTypes: string[] }>();
    for (const r of rows) {
      const line = r.derivedServiceLine;
      let l = byLine.get(line);
      if (!l) {
        l = { line, total: 0, inScope: 0, completedThisMonth: 0, serviceTypes: [] };
        byLine.set(line, l);
      }
      l.total += r.total;
      l.inScope += r.inScope;
      l.completedThisMonth += r.completedThisMonth;
      l.serviceTypes.push(r.serviceType);
    }

    const initials = rows.filter((r) => r.isInitial);

    return NextResponse.json({
      today,
      monthStart,
      totalJobs: snap.size,
      lineRollup: Array.from(byLine.values()).sort((a, b) => b.total - a.total),
      serviceTypes: rows,
      initialServiceTypes: initials,
      initialSummary: {
        distinctInitialTypes: initials.length,
        totalInitialJobs: initials.reduce((s, r) => s + r.total, 0),
        initialCompletedThisMonth: initials.reduce((s, r) => s + r.completedThisMonth, 0),
      },
    });
  } catch (err) {
    console.error("[fieldroutes/debug-classification] Error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
