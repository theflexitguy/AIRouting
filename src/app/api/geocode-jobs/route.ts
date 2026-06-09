export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { geocodeAddresses, hasGoogleRoutesApiKey } from "@/lib/google-routing";

/**
 * Backfills coordinates for existing jobs that have an address but no lat/lng.
 * Pass { companyId, jobIds? }. When jobIds is omitted, every job in the company
 * missing coordinates is geocoded.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { companyId, jobIds } = body as { companyId?: string; jobIds?: string[] };

  if (!companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }
  if (!hasGoogleRoutesApiKey()) {
    return NextResponse.json(
      { error: "Geocoding is unavailable because GOOGLE_MAPS_API_KEY is not configured." },
      { status: 503 },
    );
  }

  const db = adminDb();

  try {
    type JobDoc = { ref: FirebaseFirestore.DocumentReference; address: string };
    const targets: JobDoc[] = [];

    const needsGeocode = (data: FirebaseFirestore.DocumentData) => {
      const lat = data.lat;
      const lng = data.lng;
      const address = String(data.address || data.addressRaw || "").trim();
      return (
        Boolean(address) &&
        (lat === null || lat === undefined || lng === null || lng === undefined)
      );
    };

    if (Array.isArray(jobIds) && jobIds.length > 0) {
      for (let i = 0; i < jobIds.length; i += 300) {
        const refs = jobIds
          .slice(i, i + 300)
          .map((id) => db.doc(`companies/${companyId}/jobs/${id}`));
        const snaps = await db.getAll(...refs);
        snaps.forEach((snap) => {
          if (!snap.exists) return;
          const data = snap.data() || {};
          if (needsGeocode(data)) {
            targets.push({ ref: snap.ref, address: String(data.address || data.addressRaw || "") });
          }
        });
      }
    } else {
      const snap = await db.collection(`companies/${companyId}/jobs`).get();
      snap.docs.forEach((doc) => {
        const data = doc.data();
        if (needsGeocode(data)) {
          targets.push({ ref: doc.ref, address: String(data.address || data.addressRaw || "") });
        }
      });
    }

    if (targets.length === 0) {
      return NextResponse.json({ success: true, scanned: 0, geocoded: 0, failed: 0, message: "No jobs needed geocoding." });
    }

    const geocoded = await geocodeAddresses(
      targets.map((t) => t.address),
      { concurrency: 8, maxRequests: 2000 },
    );

    let updated = 0;
    let failed = 0;
    const now = new Date().toISOString();
    let batch = db.batch();
    let ops = 0;

    for (const target of targets) {
      const match = geocoded.get(target.address.trim());
      if (!match) {
        failed++;
        continue;
      }
      batch.update(target.ref, {
        lat: match.lat,
        lng: match.lng,
        geocodeSource: "google_geocode",
        updatedAt: now,
      });
      updated++;
      ops++;
      if (ops >= 450) {
        await batch.commit();
        batch = db.batch();
        ops = 0;
      }
    }
    if (ops > 0) await batch.commit();

    return NextResponse.json({
      success: true,
      scanned: targets.length,
      geocoded: updated,
      failed,
      message: `${updated} job(s) geocoded${failed ? `, ${failed} could not be resolved` : ""}.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
