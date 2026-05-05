import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import axios from "axios";

const db = admin.firestore();

interface FieldRoutesJob {
  id: string;
  customerId: string;
  customerName: string;
  address: string;
  scheduledDate: string;
  serviceType: string;
  duration: number;
  assignedTechId?: string;
  status: string;
  lat?: number;
  lng?: number;
}

function generateHmacSignature(
  apiSecret: string,
  timestamp: number,
  path: string,
  body: string = ""
): string {
  const message = `${timestamp}\n${path}\n${body}`;
  return crypto.createHmac("sha256", apiSecret).update(message).digest("hex");
}

async function geocodeAddress(
  address: string,
  googleMapsKey: string
): Promise<{ lat: number; lng: number } | null> {
  try {
    const encoded = encodeURIComponent(address);
    const res = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encoded}&key=${googleMapsKey}`
    );
    if (res.data.status === "OK" && res.data.results.length > 0) {
      const loc = res.data.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng };
    }
  } catch (e) {
    console.error("Geocoding failed for:", address, e);
  }
  return null;
}

async function fetchFieldRoutesJobs(
  apiKey: string,
  apiSecret: string,
  baseUrl: string
): Promise<FieldRoutesJob[]> {
  const timestamp = Math.floor(Date.now() / 1000);
  const path = "/api/v1/jobs";

  // Calculate date range: today to +60 days
  const today = new Date();
  const future = new Date();
  future.setDate(future.getDate() + 60);
  const startDate = today.toISOString().split("T")[0];
  const endDate = future.toISOString().split("T")[0];

  const queryParams = `?scheduledDateStart=${startDate}&scheduledDateEnd=${endDate}&status=scheduled,pending`;
  const signature = generateHmacSignature(apiSecret, timestamp, path + queryParams);

  try {
    const response = await axios.get(`${baseUrl}${path}${queryParams}`, {
      headers: {
        "X-Api-Key": apiKey,
        "X-Timestamp": timestamp.toString(),
        "X-Signature": signature,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      timeout: 30000,
    });

    const data = response.data;
    // Handle different response shapes from FieldRoutes
    const jobs = Array.isArray(data) ? data : (data.jobs || data.data || []);

    return jobs.map((j: Record<string, unknown>) => ({
      id: String(j.id || j.jobId || ""),
      customerId: String(j.customerId || j.customer_id || ""),
      customerName: String(j.customerName || j.customer_name || j.name || "Unknown"),
      address: String(j.address || j.serviceAddress || j.service_address || ""),
      scheduledDate: String(j.scheduledDate || j.scheduled_date || ""),
      serviceType: String(j.serviceType || j.service_type || j.type || "General"),
      duration: Number(j.duration || j.estimatedDuration || 60),
      assignedTechId: j.techId ? String(j.techId) : undefined,
      status: String(j.status || "pending"),
      lat: j.lat ? Number(j.lat) : undefined,
      lng: j.lng ? Number(j.lng) : undefined,
    }));
  } catch (error) {
    console.error("FieldRoutes API error:", error);
    // Return empty for graceful degradation
    return [];
  }
}

export const syncFieldRoutesJobs = functions
  .runWith({ timeoutSeconds: 540, memory: "512MB" })
  .https.onRequest(async (req, res) => {
    // Support both GET (manual trigger) and POST (webhook)
    if (req.method !== "GET" && req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const companyId = req.query.companyId || req.body?.companyId;
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }

    try {
      // Get company credentials from Firestore
      const companyDoc = await db.doc(`companies/${companyId}`).get();
      if (!companyDoc.exists) {
        res.status(404).json({ error: "Company not found" });
        return;
      }

      const company = companyDoc.data()!;
      const apiKey = company.fieldRoutesApiKey || process.env.FIELDROUTES_API_KEY || "";
      const apiSecret = company.fieldRoutesApiSecret || process.env.FIELDROUTES_API_SECRET || "";
      const baseUrl = process.env.FIELDROUTES_NWA_BASE_URL || "https://flexpc.fieldroutes.com/api";
      const googleMapsKey = process.env.GOOGLE_MAPS_API_KEY || "";

      if (!apiKey || !apiSecret) {
        res.status(400).json({ error: "FieldRoutes credentials not configured" });
        return;
      }

      const jobs = await fetchFieldRoutesJobs(apiKey, apiSecret, baseUrl);
      let syncedCount = 0;
      let updatedCount = 0;

      const batch = db.batch();
      const batchSize = 500;
      let batchCount = 0;

      for (const job of jobs) {
        if (!job.id || !job.address) continue;

        // Geocode if missing lat/lng
        if (!job.lat || !job.lng) {
          const coords = await geocodeAddress(job.address, googleMapsKey);
          if (coords) {
            job.lat = coords.lat;
            job.lng = coords.lng;
          }
        }

        const jobRef = db.doc(`companies/${companyId}/jobs/${job.id}`);
        const existing = await jobRef.get();

        const jobData = {
          ...job,
          companyId: String(companyId),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          ...(existing.exists ? {} : { createdAt: admin.firestore.FieldValue.serverTimestamp() }),
        };

        if (existing.exists) {
          batch.update(jobRef, jobData);
          updatedCount++;
        } else {
          batch.set(jobRef, jobData);
          syncedCount++;
        }

        batchCount++;
        if (batchCount >= batchSize) {
          await batch.commit();
          batchCount = 0;
        }
      }

      if (batchCount > 0) {
        await batch.commit();
      }

      // Update sync metadata
      await db.doc(`companies/${companyId}`).update({
        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSyncJobCount: jobs.length,
      });

      res.json({
        success: true,
        total: jobs.length,
        created: syncedCount,
        updated: updatedCount,
        syncedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Sync error:", error);
      res.status(500).json({ error: "Sync failed", details: String(error) });
    }
  });
