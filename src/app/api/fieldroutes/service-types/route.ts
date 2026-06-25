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

    // Use includeData=1 on search to get fully resolved entities in one call.
    // This avoids the serviceType/get endpoint which uses non-standard param
    // names and response keys.
    const body = await client.searchWithData("serviceType");
    const serviceTypes = body
      .map((e) => ({
        id: String(e.typeID ?? ""),
        description: String(e.description ?? ""),
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
