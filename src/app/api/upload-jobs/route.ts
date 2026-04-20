export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

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
          i++; // skip escaped quote
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
  // Strip BOM if present
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

// Flexible column lookup: tries multiple possible names for each field
function col(row: CsvRow, ...names: string[]): string {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== "") return row[n];
  }
  return "";
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const companyId = formData.get("companyId") as string | null;

    if (!file || !companyId) {
      return NextResponse.json({ error: "file and companyId are required" }, { status: 400 });
    }

    const text = await file.text();
    const rows = parseCsv(text);

    if (rows.length === 0) {
      return NextResponse.json({ error: "CSV is empty or has no data rows" }, { status: 400 });
    }

    // Check that we can find at least a customer ID or address column
    const first = rows[0];
    const testId = col(first, "customerID", "Customer ID", "customer_id", "CustomerID", "id", "ID");
    const testAddr = col(first, "address", "Address", "service_address", "serviceAddress", "Service Address");
    if (!testId && !testAddr) {
      const availableCols = Object.keys(first).join(", ");
      return NextResponse.json(
        { error: `Could not find a customer ID or address column. Found columns: ${availableCols}` },
        { status: 400 }
      );
    }

    const db = adminDb();

    // Pre-fetch existing jobs to check which are already scheduled/in_progress
    const existingSnap = await db.collection(`companies/${companyId}/jobs`).get();
    const existingJobs = new Map<string, { status: string }>();
    existingSnap.docs.forEach((doc) => {
      existingJobs.set(doc.id, { status: doc.data().status || "pending" });
    });

    let newCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let batchOps = 0;
    let batch = db.batch();

    for (const row of rows) {
      const rawCustomerId = col(row, "customerID", "Customer ID", "customer_id", "CustomerID", "id", "ID");
      const customerId = rawCustomerId.replace(/\//g, "_").replace(/\\/g, "_");
      const scheduledDate = col(row, "serviceDue", "Service Due", "scheduledDate", "Scheduled Date", "routeDate", "Route Date", "service_due");

      if (!customerId) {
        skippedCount++;
        continue;
      }

      // Normalize date: convert MM/DD/YY or MM/DD/YYYY to YYYY-MM-DD
      let normalizedDate = scheduledDate;
      const mdyMatch = scheduledDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (mdyMatch) {
        const month = mdyMatch[1].padStart(2, "0");
        const day = mdyMatch[2].padStart(2, "0");
        let year = mdyMatch[3];
        if (year.length === 2) year = `20${year}`;
        normalizedDate = `${year}-${month}-${day}`;
      }

      // Composite key: customerID + scheduledDate prevents duplicates
      // Sanitize: Firestore doc IDs cannot contain forward slashes
      const rawDocId = normalizedDate ? `${customerId}-${normalizedDate}` : customerId;
      const docId = rawDocId.replace(/\//g, "_").replace(/\\/g, "_");

      // Skip jobs that are already on a route (scheduled or in_progress)
      const existing = existingJobs.get(docId);
      if (existing && (existing.status === "scheduled" || existing.status === "in_progress")) {
        skippedCount++;
        continue;
      }

      const lat = parseFloat(col(row, "lat", "Latitude", "latitude", "Lat")) || null;
      const lng = parseFloat(col(row, "lng", "Longitude", "longitude", "Lng", "lon", "Lon")) || null;
      const isNew = !existing;

      const firstName = col(row, "First Name", "firstName", "first_name");
      const lastName = col(row, "Last Name", "lastName", "last_name");
      const customerName = col(row, "customerName", "Customer Name", "name", "Name")
        || (firstName && lastName ? `${firstName} ${lastName}` : firstName || lastName || customerId);

      const address = col(row, "address", "Address", "service_address", "serviceAddress", "Service Address");
      const city = col(row, "city", "City");
      const zip = col(row, "Zip Code", "zip", "zipCode", "Zip", "zip_code");
      const fullAddress = [address, city, zip].filter(Boolean).join(", ");

      const jobRef = db.doc(`companies/${companyId}/jobs/${docId}`);
      const now = new Date().toISOString();

      const jobData: Record<string, unknown> = {
        customerId,
        customerName,
        address: fullAddress,
        lat,
        lng,
        scheduledDate: normalizedDate,
        serviceType: col(row, "serviceType", "Service Type", "Subscription", "Subscription Category", "service_type", "type") || "General",
        duration: parseInt(col(row, "duration", "Duration", "estimated_duration") || "25") || 25,
        assignedTechId: col(row, "preferredTech", "Preferred Tech", "preferredTech", "assigned_tech", "Tech"),
        subscriptionId: col(row, "subscriptionID", "Subscription ID", "subscription_id", "SubscriptionID"),
        schedulingRequest: col(row, "schedulingRequest", "Special Scheduling", "scheduling_request", "Scheduling Request"),
        billingFrequency: col(row, "Billing Frequency", "billingFrequency"),
        recurringFrequency: col(row, "Recurring Frequency", "recurringFrequency"),
        recurringPrice: col(row, "Recurring Price", "recurringPrice"),
        subscriptionStatus: col(row, "Subscription Status", "subscriptionStatus"),
        status: "pending",
        companyId,
        source: "csv_upload",
        updatedAt: now,
      };

      if (isNew) {
        jobData.createdAt = now;
        jobData.uploadedAt = now;
      }

      batch.set(jobRef, jobData, { merge: true });
      batchOps++;

      if (isNew) newCount++;
      else updatedCount++;

      if (batchOps >= 500) {
        await batch.commit();
        batch = db.batch();
        batchOps = 0;
      }
    }

    if (batchOps > 0) {
      await batch.commit();
    }

    const total = newCount + updatedCount + skippedCount;

    return NextResponse.json({
      success: true,
      total,
      new: newCount,
      updated: updatedCount,
      skipped: skippedCount,
      message: `${total} rows processed: ${newCount} new, ${updatedCount} updated, ${skippedCount} skipped`,
    });
  } catch (error) {
    console.error("Upload jobs error:", error);
    return NextResponse.json(
      { error: "Failed to upload CSV", details: String(error) },
      { status: 500 }
    );
  }
}
