import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldRoutesClient } from "@/lib/fieldroutes/client";
import {
  extractSkillRefs,
  resolveSkillNames,
  fetchSkillCatalogRows,
  skillCatalogIdToName,
  requiredSkillsByServiceTypeDescription,
} from "@/lib/fieldroutes/skills";

// Read-only diagnostic: discover how FieldRoutes exposes the Skills feature so we
// can wire skill-aware routing precisely (technician skills + service-type
// required skills). Returns the field NAMES present on employee/serviceType plus
// the values of any skill-ish field — no PII dump — AND what the production code
// (sync.ts) resolves them to, so a single run both discovers the shape and
// verifies the real implementation against it. Confirmed shape: the `skill`
// catalog carries skill -> serviceTypeIds (which service types need it); the
// service type record itself has no skill field.
//
//   POST { companyId? }  or  GET ?companyId=...
//   -> { employeeKeys, employeeSkillSamples, employeeResolved, serviceTypeKeys,
//        requiredSkillsByServiceType, skillCatalog, notes }

const FIELDROUTES_DEFAULT_BASE_URL = "https://flexpc.fieldroutes.com/api";

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

const isSkillKey = (k: string) => /skill/i.test(k);

/** Pull just the skill-related keys (+ a couple of identifiers) off an entity. */
function skillView(e: Record<string, unknown>, idKeys: string[]): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  for (const k of idKeys) if (k in e) view[k] = e[k];
  for (const k of Object.keys(e)) if (isSkillKey(k)) view[k] = e[k];
  return view;
}

async function handle(companyIdParam: string | undefined) {
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
    const notes: string[] = [];

    // Same catalog + extraction code production sync.ts uses — verifies the
    // real implementation, not just a raw field dump.
    const skillCatalogRows = await fetchSkillCatalogRows(client);
    const skillCatalogMap = skillCatalogIdToName(skillCatalogRows);

    // --- Employees (sample up to 8) ---
    const employeeKeys = new Set<string>();
    const employeeSkillSamples: Record<string, unknown>[] = [];
    const employeeResolved: Array<{ employeeId: string; name: string; refs: string[]; resolvedSkillNames: string[] }> = [];
    try {
      const empIds = (await client.searchIds("employee", {})).slice(0, 8);
      const employees = empIds.length ? await client.getEntities("employee", empIds) : [];
      for (const e of employees) {
        Object.keys(e).forEach((k) => employeeKeys.add(k));
        employeeSkillSamples.push(skillView(e, ["employeeID", "employeeId", "fname", "lname"]));
        const refs = extractSkillRefs(e);
        employeeResolved.push({
          employeeId: String(e.employeeID ?? e.employeeId ?? ""),
          name: [e.fname, e.lname].filter(Boolean).join(" ") || String(e.name ?? ""),
          refs,
          resolvedSkillNames: resolveSkillNames(refs, skillCatalogMap),
        });
      }
    } catch (err) {
      notes.push(`employee pull failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // --- Service types: the catalog (not the serviceType entity) carries the
    // skill link, via each skill row's serviceTypeIds -> typeID. ---
    const serviceTypeKeys = new Set<string>();
    let requiredSkillsByServiceType: Record<string, string[]> = {};
    try {
      const serviceTypes = await client.searchWithData("serviceType");
      const typeIdToDescription = new Map<string, string>();
      for (const s of serviceTypes) {
        Object.keys(s).forEach((k) => serviceTypeKeys.add(k));
        const typeId = String(s.typeID ?? "");
        const description = String(s.description ?? "");
        if (typeId && description) typeIdToDescription.set(typeId, description);
      }
      requiredSkillsByServiceType = requiredSkillsByServiceTypeDescription(skillCatalogRows, typeIdToDescription);
      if (Object.keys(requiredSkillsByServiceType).length === 0) {
        notes.push("No service type currently has a required skill (skill catalog rows carry empty/unmatched serviceTypeIds, or the catalog itself is empty).");
      }
    } catch (err) {
      notes.push(`serviceType pull failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (skillCatalogRows.length === 0) {
      notes.push("No `skill` catalog module exposed — employee/job skill fields will be empty until FieldRoutes exposes one.");
    }

    return NextResponse.json({
      employeeKeys: Array.from(employeeKeys).sort(),
      employeeSkillSamples,
      employeeResolved, // what production sync.ts will actually stamp on technician docs (skillNames)
      serviceTypeKeys: Array.from(serviceTypeKeys).sort(),
      requiredSkillsByServiceType, // what production sync.ts will actually stamp as job.requiredSkills
      skillCatalog: skillCatalogRows,
      notes,
      apiCalls: client.readCount,
    });
  } catch (err) {
    console.error("[fieldroutes/debug-skills] Error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { companyId?: string };
  return handle(body.companyId);
}

export async function GET(request: NextRequest) {
  const companyId = new URL(request.url).searchParams.get("companyId") || undefined;
  return handle(companyId);
}
