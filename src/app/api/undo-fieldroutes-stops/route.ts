export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { recordApiUsage } from "@/lib/fieldroutes/usage";

const FIELDROUTES_NWA_BASE_URL = "https://flexpc.fieldroutes.com/api";

type UploadedAppointmentLog = {
  appointmentId?: string;
  jobId?: string;
  customerName?: string;
  action?: string;
  before?: {
    routeId?: string;
    assignedTech?: string;
    date?: string;
    sequence?: number | null;
    status?: string;
  };
};

class UndoFieldRoutesError extends Error {
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
  const body = Object.fromEntries(
    Object.entries({
      ...payload,
      authenticationKey: authKey,
      authenticationToken: authToken,
    }).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${ep}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let responseBody: unknown;
  try {
    responseBody = text ? JSON.parse(text) : {};
  } catch {
    responseBody = { raw: text };
  }

  const apiError = extractApiError(responseBody);
  if (response.ok && !apiError) return responseBody;

  throw new UndoFieldRoutesError(`FieldRoutes ${ep} failed: ${apiError || `HTTP ${response.status}`}`, 502, {
    endpoint: ep,
    status: response.status,
    response: responseBody,
  });
}

function cancellationConfig(company: FirebaseFirestore.DocumentData, route: FirebaseFirestore.DocumentData) {
  const sync = isRecord(route.fieldRoutesSync) ? route.fieldRoutesSync : {};
  return {
    cancelReason: clean(
      company.fieldRoutesCancelReason ||
        company.fieldRoutesRouteIqCancelReason ||
        process.env.FIELDROUTES_CANCEL_REASON ||
        "RouteIQ rollback",
    ),
    cancelledBy: clean(
      company.fieldRoutesCancelledByEmployeeId ||
        company.fieldRoutesCanceledByEmployeeId ||
        process.env.FIELDROUTES_CANCELLED_BY_EMPLOYEE_ID ||
        process.env.FIELDROUTES_CANCELED_BY_EMPLOYEE_ID ||
        sync.assignedTech,
    ),
  };
}

function restorePayload(item: UploadedAppointmentLog) {
  const before = item.before || {};
  const payload: Record<string, unknown> = {
    appointmentID: clean(item.appointmentId),
  };
  if (clean(before.routeId)) payload.routeID = clean(before.routeId);
  if (clean(before.assignedTech)) payload.assignedTech = clean(before.assignedTech);
  if (clean(before.date)) payload.date = clean(before.date);
  if (before.sequence !== undefined && before.sequence !== null && Number.isFinite(Number(before.sequence))) {
    payload.sequence = Math.trunc(Number(before.sequence));
  }
  if (clean(before.status)) payload.status = Number.isFinite(Number(before.status)) ? Number(before.status) : clean(before.status);
  return payload;
}

function cancelPayload(item: UploadedAppointmentLog) {
  return Object.fromEntries(Object.entries({
    appointmentID: clean(item.appointmentId),
  }).filter(([, value]) => value !== ""));
}

function syncDetailsFromRoute(route: FirebaseFirestore.DocumentData) {
  const sync = isRecord(route.fieldRoutesSync) ? route.fieldRoutesSync : {};
  return {
    routeId: clean(sync.routeId || route.fieldRoutesRouteId),
    routeStatus: clean(sync.routeStatus),
    routeDate: clean(sync.routeDate || sync.dateInputUsed || route.date),
    routeTime: clean(sync.routeTime),
    assignedTech: clean(sync.assignedTech),
    uploadedAt: clean(sync.uploadedAt),
    verifiedAt: clean(sync.verifiedAt),
  };
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
    const sync = isRecord(route.fieldRoutesSync) ? route.fieldRoutesSync : {};
    const uploadedAppointments = Array.isArray(sync.uploadedAppointments)
      ? (sync.uploadedAppointments.filter(isRecord) as UploadedAppointmentLog[])
      : [];
    if (uploadedAppointments.length === 0) {
      return NextResponse.json(
        { error: "This RouteIQ route does not have logged FieldRoutes appointment IDs to undo." },
        { status: 400 },
      );
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

    const errors: Array<{ appointmentId: string; customerName: string; reason: string }> = [];
    const undone: Array<{ appointmentId: string; customerName: string; action: string }> = [];
    const skipped: Array<{ appointmentId: string; customerName: string; reason: string }> = [];
    const baseUrl = fieldRoutesNwaBaseUrl(company);
    const cancelConfig = cancellationConfig(company, route);
    // Count each FieldRoutes write attempt (cancel/update) to meter the daily cap.
    let apiWrites = 0;

    for (const item of uploadedAppointments) {
      const appointmentId = clean(item.appointmentId);
      const customerName = clean(item.customerName || item.jobId || appointmentId);
      const action = clean(item.action).toLowerCase();
      if (!appointmentId) {
        errors.push({ appointmentId, customerName, reason: "Missing appointment ID." });
        continue;
      }

      let payload: Record<string, unknown> | null = null;
      let rollbackAction = "";
      if (action === "create") {
        payload = {
          ...cancelPayload(item),
          cancelReason: cancelConfig.cancelReason,
          ...(cancelConfig.cancelledBy ? { cancelledBy: Number.isFinite(Number(cancelConfig.cancelledBy)) ? Number(cancelConfig.cancelledBy) : cancelConfig.cancelledBy } : {}),
        };
        rollbackAction = "cancelled_created_appointment";
      } else if (action === "update") {
        payload = restorePayload(item);
        if (Object.keys(payload).length <= 1) {
          errors.push({
            appointmentId,
            customerName,
            reason: "This moved appointment does not have enough prior route/date/tech data to restore safely.",
          });
          continue;
        }
        rollbackAction = "restored_previous_assignment";
      } else {
        skipped.push({ appointmentId, customerName, reason: `No FieldRoutes write to undo for action ${action || "unknown"}.` });
        continue;
      }

      try {
        apiWrites++;
        await fieldRoutesRequest({
          baseUrl,
          authKey,
          authToken,
          endpoint: action === "create" ? "/appointment/cancel" : "/appointment/update",
          payload,
        });
        undone.push({ appointmentId, customerName, action: rollbackAction });
      } catch (error) {
        errors.push({
          appointmentId,
          customerName,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Meter the writes this undo spent, whether or not some failed.
    await recordApiUsage(db, companyId, { writes: apiWrites }).catch((err) =>
      console.error("[undo-fieldroutes-stops] failed to record API usage:", String(err)),
    );

    if (errors.length) {
      return NextResponse.json(
        { error: "Some FieldRoutes appointments could not be undone.", undone, skipped, errors },
        { status: 409 },
      );
    }

    const stopSequence = Array.isArray(route.stopSequence) ? route.stopSequence.map(clean).filter(Boolean) : [];
    const now = new Date().toISOString();
    const batch = db.batch();
    batch.update(routeDoc.ref, {
      approved: false,
      approvedAt: FieldValue.delete(),
      approvedBy: FieldValue.delete(),
      fieldRoutesSync: FieldValue.delete(),
      fieldRoutesUndoneSync: {
        undoneAt: now,
        requestedBy: clean(requestedBy),
        fieldRoutes: syncDetailsFromRoute(route),
        undone,
        skipped,
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
      undoneAt: now,
      undone,
      skipped,
      stopCount: stopSequence.length,
    });
  } catch (error) {
    console.error("Undo FieldRoutes stops error:", error);
    if (error instanceof UndoFieldRoutesError) {
      return NextResponse.json({ error: error.message, details: error.details }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to undo FieldRoutes stops", details: String(error) }, { status: 500 });
  }
}
