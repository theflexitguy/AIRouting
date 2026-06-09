export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { adminDb } from "@/lib/firebase-admin";
import {
  computeJobId,
  normalizeServiceDate,
  normalizeServiceType,
} from "@/lib/job-id";
import { normalizeRouteDateValue } from "@/lib/route-bundles";

interface CsvRow {
  [key: string]: string;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCsv(text: string): CsvRow[] {
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const rows: CsvRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: CsvRow = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || "";
    });
    rows.push(row);
  }
  return rows;
}

function col(row: CsvRow, ...names: string[]): string {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== "") return row[n];
  }
  return "";
}

function hasCol(row: CsvRow, ...names: string[]): boolean {
  return names.some((n) => row[n] !== undefined);
}

function safeCsvColumnKey(name: string, fallbackIndex: number) {
  const cleaned = String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || `column_${fallbackIndex + 1}`;
}

function buildCsvSnapshot(row: CsvRow) {
  const fields = Object.entries(row).map(([name, value]) => ({
    name,
    value: String(value ?? ""),
  }));
  const raw: Record<string, string> = {};
  const keyCounts = new Map<string, number>();

  fields.forEach(({ name, value }, index) => {
    const baseKey = safeCsvColumnKey(name, index);
    const count = keyCounts.get(baseKey) || 0;
    keyCounts.set(baseKey, count + 1);
    raw[count === 0 ? baseKey : `${baseKey}_${count + 1}`] = value;
  });

  return {
    csvColumns: fields.map((field) => field.name),
    csvFields: fields,
    rawCsv: raw,
  };
}

interface InvalidRow {
  rowNumber: number;
  reason: string;
  customerId?: string;
  address?: string;
}

interface PreparedJob {
  jobId: string;
  baseJobData: Record<string, unknown>;
  assignedTechId: string;
  serviceDueAlreadyCompleted: boolean;
}

function getSubscriptionLastServicedFromRow(row: CsvRow) {
  return col(
    row,
    "Subscription Last Serviced",
    "Subscription Last Completed",
    "subscriptionLastServiced",
    "subscriptionLastCompleted",
    "Subscription Last Service",
    "Last Serviced",
    "lastServiced",
    "Last Service Date",
    "lastServiceDate",
    "Last Completed",
    "lastCompleted",
  );
}

function resolveExistingStatus(
  existingStatus: string,
  serviceDueAlreadyCompleted: boolean,
  fieldRoutesScheduled: boolean,
) {
  if (serviceDueAlreadyCompleted) return "completed";
  if (fieldRoutesScheduled) return "scheduled";
  if (existingStatus === "scheduled" || existingStatus === "in_progress") return existingStatus;
  return "pending";
}

async function getExistingJobDocs(
  db: FirebaseFirestore.Firestore,
  refs: FirebaseFirestore.DocumentReference[],
) {
  const existing = new Map<string, FirebaseFirestore.DocumentData>();
  const chunks: FirebaseFirestore.DocumentReference[][] = [];
  for (let i = 0; i < refs.length; i += 300) {
    const chunk = refs.slice(i, i + 300);
    if (chunk.length > 0) chunks.push(chunk);
  }

  const snapshotChunks = await Promise.all(
    chunks.map((chunk) => db.getAll(...chunk)),
  );
  snapshotChunks.flat().forEach((snap) => {
    if (snap.exists) existing.set(snap.id, snap.data() || {});
  });
  return existing;
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const companyId = formData.get("companyId") as string | null;
    const uploadKind = String(formData.get("uploadKind") || "job_pool");
    const isScheduledJobsUpload = uploadKind === "scheduled_jobs";

    if (!file || !companyId) {
      return NextResponse.json(
        { error: "file and companyId are required" },
        { status: 400 },
      );
    }

    const text = await file.text();
    const rows = parseCsv(text);

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "CSV is empty or has no data rows" },
        { status: 400 },
      );
    }

    // Sanity check: make sure we can read the dedup-key columns
    const first = rows[0];
    const testAddr = col(
      first,
      "Address",
      "address",
      "service_address",
      "Service Address",
    );
    const testDate = col(
      first,
      "Service Due",
      "serviceDue",
      "scheduledDate",
      "Scheduled Date",
      "Appointment Date",
      "Start Date",
      "Scheduled For",
      "Route Date",
    );
    const testSvc = col(
      first,
      "Subscription",
      "serviceType",
      "Service Type",
      "Subscription Category",
    );


    if (!testAddr || !testDate || !testSvc) {
      const missing = [
        !testAddr && "Address",
        !testDate && "Service Due",
        !testSvc && "Subscription",
      ]
        .filter(Boolean)
        .join(", ");
      const availableCols = Object.keys(first).join(", ");
      return NextResponse.json(
        {
          error: `Missing required column(s): ${missing}. Found columns: ${availableCols}`,
        },
        { status: 400 },
      );
    }

    const hasScheduledFor = hasCol(first, "Scheduled For", "scheduledFor", "Scheduled Date", "Appointment Date", "Start Date", "Route Date");
    const hasServicedBy = hasCol(first, "Serviced By", "servicedBy", "ServicedBy", "Service By", "Scheduled On", "Route Assigned To");
    if (isScheduledJobsUpload && (!hasScheduledFor || !hasServicedBy)) {
      const missing = [
        !hasScheduledFor && "Scheduled For",
        !hasServicedBy && "Serviced By",
      ]
        .filter(Boolean)
        .join(", ");
      const availableCols = Object.keys(first).join(", ");
      return NextResponse.json(
        {
          error: `Missing scheduled-job column(s): ${missing}. Found columns: ${availableCols}`,
        },
        { status: 400 },
      );
    }

    const db = adminDb();

    let newCount = 0;
    let updatedCount = 0;
    let alreadyCompletedCount = 0;
    let fieldRoutesScheduledCount = 0;
    let duplicatesSkipped = 0;
    const invalidRows: InvalidRow[] = [];

    const batchId = randomUUID();
    const uploadedAt = new Date().toISOString();
    const preparedById = new Map<string, PreparedJob>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2; // +1 for header, +1 for 1-based row numbers

      const address = col(
        row,
        "Address",
        "address",
        "service_address",
        "Service Address",
      );
      const city = col(row, "City", "city");
      const zip = col(row, "Zip Code", "zip", "zipCode", "Zip", "zip_code");
      const fullAddress = [address, city, zip].filter(Boolean).join(", ");

      const rawServiceDue = col(
        row,
        "Service Due",
        "serviceDue",
        "scheduledDate",
        "Scheduled Date",
        "routeDate",
        "Route Date",
        "Appointment Date",
        "Start Date",
        "Scheduled For",
      );
      const scheduledDate = normalizeServiceDate(rawServiceDue);
      const rawFieldRoutesScheduledDate = col(
        row,
        "Scheduled For",
        "scheduledFor",
        "Scheduled Date",
        "Appointment Date",
        "Start Date",
        "Route Date",
      );
      const fieldRoutesScheduledDate =
        normalizeServiceDate(rawFieldRoutesScheduledDate) ||
        normalizeRouteDateValue(rawFieldRoutesScheduledDate);

      const serviceType =
        col(
          row,
          "Subscription",
          "serviceType",
          "Service Type",
          "Subscription Category",
          "service_type",
          "type",
        ) || "";

      const customerId = col(
        row,
        "Customer ID",
        "customerID",
        "customer_id",
        "CustomerID",
        "id",
        "ID",
      );

      // Dedup-key validation: all three must be present
      if (!address) {
        invalidRows.push({
          rowNumber,
          reason: "missing address",
          customerId,
        });
        continue;
      }
      if (!scheduledDate) {
        invalidRows.push({
          rowNumber,
          reason: "missing or invalid Service Due",
          customerId,
          address,
        });
        continue;
      }
      if (!serviceType) {
        invalidRows.push({
          rowNumber,
          reason: "missing Subscription / service type",
          customerId,
          address,
        });
        continue;
      }

      let jobId: string;
      try {
        jobId = computeJobId(address, scheduledDate, serviceType);
      } catch (err) {
        invalidRows.push({
          rowNumber,
          reason: `jobId computation failed: ${String(err)}`,
          customerId,
          address,
        });
        continue;
      }

      const lat =
        parseFloat(col(row, "Latitude", "lat", "latitude", "Lat")) || null;
      const lng =
        parseFloat(
          col(row, "Longitude", "lng", "longitude", "Lng", "lon", "Lon"),
        ) || null;

      const firstName = col(row, "First Name", "firstName", "first_name");
      const lastName = col(row, "Last Name", "lastName", "last_name");
      const customerName =
        col(row, "Customer Name", "customerName", "name", "Name") ||
        (firstName && lastName
          ? `${firstName} ${lastName}`
          : firstName || lastName || customerId);

      const csvSnapshot = buildCsvSnapshot(row);
      const fieldRoutesServicedBy = col(
        row,
        "Serviced By",
        "servicedBy",
        "ServicedBy",
        "Service By",
        "Scheduled On",
        "Route Assigned To",
      );
      const fieldRoutesServicedById = col(
        row,
        "Serviced By ID",
        "servicedById",
        "ServicedByID",
        "Serviced By Employee ID",
        "Serviced By Tech ID",
      );
      const assignedTechId = fieldRoutesServicedBy || col(
        row,
        "Preferred Tech",
        "preferredTech",
        "assigned_tech",
        "Tech",
      );
      const subscriptionLastServiced = getSubscriptionLastServicedFromRow(row);
      const subscriptionLastCompletedDate =
        normalizeServiceDate(subscriptionLastServiced) ||
        normalizeRouteDateValue(subscriptionLastServiced);
      const serviceDueAlreadyCompleted =
        Boolean(subscriptionLastCompletedDate) &&
        subscriptionLastCompletedDate >= scheduledDate;
      const fieldRoutesScheduled =
        Boolean(fieldRoutesServicedBy.trim()) &&
        Boolean(fieldRoutesScheduledDate || scheduledDate) &&
        !serviceDueAlreadyCompleted;
      const baseJobData = {
        jobId,
        customerId,
        customerName,
        address: fullAddress,
        addressRaw: address,
        lat,
        lng,
        scheduledDate,
        serviceType,
        serviceTypeNormalized: normalizeServiceType(serviceType),
        duration:
          parseInt(
            col(row, "duration", "Duration", "estimated_duration") || "25",
          ) || 25,
        assignedTechId,
        fieldRoutesScheduled,
        fieldRoutesScheduledDate: fieldRoutesScheduledDate || scheduledDate,
        fieldRoutesServicedBy,
        fieldRoutesServicedById,
        fieldRoutesScheduleSource: fieldRoutesScheduled ? "csv_serviced_by" : "",
        subscriptionId: col(
          row,
          "Subscription ID",
          "subscriptionID",
          "subscription_id",
          "SubscriptionID",
        ),
        schedulingRequest: col(
          row,
          "Special Scheduling",
          "schedulingRequest",
          "scheduling_request",
          "Scheduling Request",
        ),
        billingFrequency: col(row, "Billing Frequency", "billingFrequency"),
        billingPrice: col(row, "Billing Price", "billingPrice"),
        recurringFrequency: col(
          row,
          "Recurring Frequency",
          "recurringFrequency",
        ),
        recurringPrice: col(row, "Recurring Price", "recurringPrice"),
        subscriptionStatus: col(
          row,
          "Subscription Status",
          "subscriptionStatus",
        ),
        subscriptionBalance: col(row, "Subscription Balance", "subscriptionBalance"),
        subscriptionOnHold: col(row, "Subscription On Hold", "subscriptionOnHold"),
        initialServiceDate: col(row, "Initial Service", "initialService", "initialServiceDate"),
        subscriptionLastServiced,
        subscriptionLastCompletedDate,
        serviceDueAlreadyCompleted,
        serviceDueCompletionCheck:
          serviceDueAlreadyCompleted && subscriptionLastCompletedDate
            ? `Last completed ${subscriptionLastCompletedDate} is on or after service due ${scheduledDate}.`
            : "",
        revenue: col(row, "Revenue", "revenue"),
        productionValue: col(row, "Production Value", "productionValue"),
        subscriptionCategory: col(row, "Subscription Category", "subscriptionCategory"),
        ...csvSnapshot,
        csvSourceColumns: csvSnapshot.csvColumns,
        status: serviceDueAlreadyCompleted
          ? "completed" as const
          : fieldRoutesScheduled
            ? "scheduled" as const
            : "pending" as const,
        ...(serviceDueAlreadyCompleted ? { completedAt: subscriptionLastCompletedDate } : {}),
        companyId,
        source: "csv_upload" as const,
        uploadBatchId: batchId,
        updatedAt: uploadedAt,
      };

      if (preparedById.has(jobId)) duplicatesSkipped++;
      preparedById.set(jobId, {
        jobId,
        baseJobData,
        assignedTechId,
        serviceDueAlreadyCompleted,
      });
    }

    const preparedJobs = [...preparedById.values()];
    alreadyCompletedCount = preparedJobs.filter((job) => job.serviceDueAlreadyCompleted).length;
    fieldRoutesScheduledCount = preparedJobs.filter(
      (job) => Boolean(job.baseJobData.fieldRoutesScheduled),
    ).length;
    const jobRefs = preparedJobs.map((job) => db.doc(`companies/${companyId}/jobs/${job.jobId}`));
    const existingJobs = await getExistingJobDocs(db, jobRefs);
    let batch = db.batch();
    let batchOps = 0;

    for (const prepared of preparedJobs) {
      const jobRef = db.doc(`companies/${companyId}/jobs/${prepared.jobId}`);
      const existingData = existingJobs.get(prepared.jobId);
      const existingStatus = String(existingData?.status || "").toLowerCase();
      const resolvedStatus = resolveExistingStatus(
        existingStatus,
        prepared.serviceDueAlreadyCompleted,
        Boolean(prepared.baseJobData.fieldRoutesScheduled),
      );
      const keepExistingAssignment =
        prepared.serviceDueAlreadyCompleted ||
        existingStatus === "scheduled" ||
        existingStatus === "in_progress";
      const assignedTechId = prepared.baseJobData.fieldRoutesScheduled
        ? prepared.assignedTechId
        : keepExistingAssignment
          ? existingData?.assignedTechId || prepared.assignedTechId
          : prepared.assignedTechId;

      batch.set(
        jobRef,
        {
          ...prepared.baseJobData,
          status: resolvedStatus,
          assignedTechId,
          lastUploadBatchId: batchId,
          ...(existingData ? {} : { createdAt: uploadedAt }),
        },
        { merge: true },
      );

      if (existingData) updatedCount++;
      else newCount++;
      batchOps++;

      if (batchOps >= 450) {
        await batch.commit();
        batch = db.batch();
        batchOps = 0;
      }
    }

    if (batchOps > 0) {
      await batch.commit();
    }

    // Record upload batch audit doc
    const batchRef = db.doc(`companies/${companyId}/uploadBatches/${batchId}`);
    await batchRef.set({
      batchId,
      companyId,
      uploadedAt,
      filename: file.name,
      totalRows: rows.length,
      newJobs: newCount,
      updatedJobs: updatedCount,
      alreadyCompleted: alreadyCompletedCount,
      fieldRoutesScheduled: fieldRoutesScheduledCount,
      duplicatesSkipped,
      invalidRows: invalidRows.length,
      invalidRowsSample: invalidRows.slice(0, 20),
    });

    const total = rows.length;
    return NextResponse.json({
      success: true,
      batchId,
      total,
      new: newCount,
      updated: updatedCount,
      alreadyCompleted: alreadyCompletedCount,
      fieldRoutesScheduled: fieldRoutesScheduledCount,
      skipped: 0,
      duplicatesSkipped,
      invalid: invalidRows.length,
      invalidSample: invalidRows.slice(0, 10),
      message: `${total} rows: ${newCount} new, ${updatedCount} updated${fieldRoutesScheduledCount ? `, ${fieldRoutesScheduledCount} scheduled from FieldRoutes` : ""}${alreadyCompletedCount ? `, ${alreadyCompletedCount} already completed` : ""}${duplicatesSkipped ? `, ${duplicatesSkipped} duplicate rows merged` : ""}${invalidRows.length ? `, ${invalidRows.length} invalid` : ""}`,
    });
  } catch (error) {
    console.error("Upload jobs error:", error);
    return NextResponse.json(
      { error: "Failed to upload CSV", details: String(error) },
      { status: 500 },
    );
  }
}
