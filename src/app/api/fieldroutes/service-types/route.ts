import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldRoutesClient } from "@/lib/fieldroutes/client";

const FIELDROUTES_DEFAULT_BASE_URL = "https://flexpc.fieldroutes.com/api";

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
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

    const ids = await client.searchIds("serviceType");
    if (ids.length === 0) {
      return NextResponse.json({ serviceTypes: [] });
    }

    // serviceType/get breaks convention: the ID param is `typeIDs` (not
    // `serviceTypeIDs`), and entities expose `typeID` + `description`.
    const entities = await client.getEntities("serviceType", ids, { idParam: "typeIDs" });
    const serviceTypes = entities
      .map((e) => ({
        id: String(e.typeID ?? e.serviceTypeID ?? e.id ?? ""),
        description: String(e.description ?? e.name ?? ""),
      }))
      .filter((s) => s.id && s.description);

    serviceTypes.sort((a, b) => a.description.localeCompare(b.description));

    return NextResponse.json({ serviceTypes, apiCalls: client.readCount });
  } catch (err) {
    console.error("[fieldroutes/service-types] Error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
