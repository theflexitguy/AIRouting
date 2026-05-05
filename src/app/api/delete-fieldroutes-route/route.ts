export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";

const FIELDROUTES_NWA_BASE_URL = "https://flexpc.fieldroutes.com/api";

class DeleteFieldRoutesError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status = 500, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function extractApiError(payload: unknown) {
  if (!isRecord(payload)) return "";
  const status = payload.status;
  const success = payload.success;
  const errorMessage = payload.errorMessage;
  const message = payload.message;
  const error = payload.error;
  const errors = payload.errors;
  if (success === false) return clean(errorMessage || error || errors || message || "API response marked unsuccessful.");
  if ([0, "0", "error", "failed", false].includes(status as never)) {
    return clean(errorMessage || error || errors || message || "API returned failure status.");
  }
  if (typeof errorMessage === "string" && errorMessage.trim()) return errorMessage.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  if (Array.isArray(errors) && errors.length) return errors.map(clean).join("; ");
  if (isRecord(errors) && Object.keys(errors).length) return JSON.stringify(errors);
  return "";
}

function fieldRoutesNwaBaseUrl(company: FirebaseFirestore.DocumentData) {
  return clean(
    company.fieldRoutesNwaBaseUrl ||
      company.fieldRoutesNWAApiBaseUrl ||
      company.fieldRoutesApiBaseUrlNwa ||
      process.env.FIELDROUTES_NWA_BASE_URL ||
      FIELDROUTES_NWA_BASE_URL,
  );
}

async function fieldRoutesRequest({
  baseUrl,
  authKey,
  authToken,
  endpoint,
  payload,
}: {
  baseUrl: string;
  authKey: string;
  authToken: string;
  endpoint: string;
  payload: Record<string, unknown>;
}) {
  const ep = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${ep}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      authenticationKey: authKey,
      authenticationToken: authToken,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  const apiError = extractApiError(body);
  if (response.ok && !apiError) return body;

  throw new DeleteFieldRoutesError(`FieldRoutes ${ep} failed: ${apiError || `HTTP ${response.status}`}`, 502, {
    endpoint: ep,
    status: response.status,
    response: body,
  });
}

function fieldRoutesRouteIdFromRoute(route: FirebaseFirestore.DocumentData) {
  const sync = isRecord(route.fieldRoutesSync) ? route.fieldRoutesSync : {};
  return clean(sync.routeId || route.fieldRoutesRouteId);
}

async function routeIdFromStopMarkers(
  db: FirebaseFirestore.Firestore,
  companyId: string,
  stopSequence: string[],
) {
  const ids = new Set<string>();
  for (const jobId of stopSequence) {
    const jobDoc = await db.doc(`companies/${companyId}/jobs/${jobId}`).get();
    const routeId = clean(jobDoc.data()?.fieldRoutesRouteId);
    if (routeId) ids.add(routeId);
  }
  return ids.size === 1 ? [...ids][0] : "";
}

export async function POST(request: NextRequest) {
  try {
    const { companyId, routeId, requestedBy } = await request.json();
    if (!companyId || !routeId) {
      return NextResponse.json({ error: "companyId and routeId are required" }, { status: 400 });
    }

    const db = adminDb();
    const [companyDoc, routeDoc] = await Promise.all([
      db.doc(`companies/${companyId}`).get(),
      db.doc(`companies/${companyId}/routes/${routeId}`).get(),
    ]);
    if (!companyDoc.exists) return NextResponse.json({ error: "Company not found" }, { status: 404 });
    if (!routeDoc.exists) return NextResponse.json({ error: "Route not found" }, { status: 404 });

    const company = companyDoc.data() || {};
    const route = routeDoc.data() || {};
    const stopSequence = Array.isArray(route.stopSequence) ? route.stopSequence.map(clean).filter(Boolean) : [];
    const fieldRoutesRouteId = fieldRoutesRouteIdFromRoute(route) || await routeIdFromStopMarkers(db, companyId, stopSequence);
    if (!fieldRoutesRouteId) {
      return NextResponse.json({ error: "This RouteIQ route has no logged FieldRoutes route ID to delete." }, { status: 400 });
    }
    if (!/^\d+$/.test(fieldRoutesRouteId)) {
      return NextResponse.json({ error: `Logged FieldRoutes route ID is invalid: ${fieldRoutesRouteId}` }, { status: 400 });
    }

    const authKey = clean(company.fieldRoutesApiKey || process.env.FIELDROUTES_AUTH_KEY || process.env.FIELDROUTES_API_KEY);
    const authToken = clean(
      company.fieldRoutesApiToken ||
        company.fieldRoutesApiSecret ||
        process.env.FIELDROUTES_AUTH_TOKEN ||
        process.env.FIELDROUTES_API_TOKEN ||
        process.env.FIELDROUTES_API_SECRET,
    );
    if (!authKey || !authToken) {
      return NextResponse.json({ error: "FieldRoutes credentials are not configured" }, { status: 400 });
    }

    const fieldRoutesResponse = await fieldRoutesRequest({
      baseUrl: fieldRoutesNwaBaseUrl(company),
      authKey,
      authToken,
      endpoint: "/route/delete",
      payload: { routeID: Number(fieldRoutesRouteId) },
    });

    const now = new Date().toISOString();
    const batch = db.batch();
    batch.update(routeDoc.ref, {
      approved: false,
      approvedAt: FieldValue.delete(),
      approvedBy: FieldValue.delete(),
      fieldRoutesSync: FieldValue.delete(),
      fieldRoutesDeletedSync: {
        deletedAt: now,
        routeId: fieldRoutesRouteId,
        requestedBy: clean(requestedBy),
      },
      updatedAt: now,
    });

    for (const jobId of stopSequence) {
      batch.update(db.doc(`companies/${companyId}/jobs/${jobId}`), {
        status: "pending",
        fieldRoutesRouteId: FieldValue.delete(),
        fieldRoutesSequence: FieldValue.delete(),
        fieldRoutesUploadedAt: FieldValue.delete(),
        updatedAt: now,
      });
    }
    await batch.commit();

    return NextResponse.json({
      success: true,
      routeId,
      fieldRoutesRouteId,
      deletedAt: now,
      fieldRoutesResponse,
    });
  } catch (error) {
    console.error("Delete FieldRoutes route error:", error);
    if (error instanceof DeleteFieldRoutesError) {
      return NextResponse.json({ error: error.message, details: error.details }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to delete FieldRoutes route", details: String(error) }, { status: 500 });
  }
}
