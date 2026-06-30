import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldRoutesClient } from "@/lib/fieldroutes/client";

// Read-only diagnostic: discover how FieldRoutes exposes the Skills feature so we
// can wire skill-aware routing precisely (technician skills + service-type
// required skills). Returns the field NAMES present on employee/serviceType plus
// the values of any skill-ish field — no PII dump. Also probes for a skill
// catalog (skillID -> name like "termite" / "wildlife" / "WI-I").
//
//   POST { companyId } -> { employeeKeys, employeeSkillSamples, serviceTypeKeys,
//                           serviceTypeSkillSamples, skillCatalog, notes }

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
    const notes: string[] = [];

    // --- Employees (sample up to 8) ---
    const employeeKeys = new Set<string>();
    const employeeSkillSamples: Record<string, unknown>[] = [];
    try {
      const empIds = (await client.searchIds("employee", {})).slice(0, 8);
      const employees = empIds.length ? await client.getEntities("employee", empIds) : [];
      for (const e of employees) {
        Object.keys(e).forEach((k) => employeeKeys.add(k));
        employeeSkillSamples.push(skillView(e, ["employeeID", "employeeId", "fname", "lname"]));
      }
    } catch (err) {
      notes.push(`employee pull failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // --- Service types (all; usually few) ---
    const serviceTypeKeys = new Set<string>();
    const serviceTypeSkillSamples: Record<string, unknown>[] = [];
    try {
      const serviceTypes = await client.searchWithData("serviceType");
      for (const s of serviceTypes) {
        Object.keys(s).forEach((k) => serviceTypeKeys.add(k));
        serviceTypeSkillSamples.push(skillView(s, ["typeID", "description"]));
      }
    } catch (err) {
      notes.push(`serviceType pull failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // --- Skill catalog probe (skillID -> name). May not be exposed. ---
    let skillCatalog: unknown = null;
    try {
      const skills = await client.searchWithData("skill");
      skillCatalog = skills.slice(0, 50);
      if (skills.length === 0) notes.push("skill/search returned no rows (catalog may be empty or unsupported).");
    } catch (err) {
      notes.push(`skill catalog not available via /skill: ${err instanceof Error ? err.message : String(err)}`);
    }

    return NextResponse.json({
      employeeKeys: Array.from(employeeKeys).sort(),
      employeeSkillSamples,
      serviceTypeKeys: Array.from(serviceTypeKeys).sort(),
      serviceTypeSkillSamples,
      skillCatalog,
      notes,
      apiCalls: client.readCount,
    });
  } catch (err) {
    console.error("[fieldroutes/debug-skills] Error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
