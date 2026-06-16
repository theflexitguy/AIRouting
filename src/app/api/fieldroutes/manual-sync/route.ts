export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth } from "@/lib/firebase-admin";
import { runSync } from "@/lib/fieldroutes/sync";

const MAX_MANUAL_SYNCS_PER_DAY = 3;

function todayCentral(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

async function getUidFromRequest(request: NextRequest): Promise<string | null> {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  try {
    const decoded = await adminAuth().verifyIdToken(token);
    return decoded.uid;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const uid = await getUidFromRequest(request);
  if (!uid) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = adminDb();
  const userDoc = await db.doc(`users/${uid}`).get();
  const companyId = userDoc.data()?.companyId;
  if (!companyId) {
    return NextResponse.json({ error: "no company associated" }, { status: 403 });
  }

  const today = todayCentral();
  const limitRef = db.doc(`companies/${companyId}/fieldRoutesState/manualSync`);
  const limitSnap = await limitRef.get();
  const limitData = limitSnap.data() || {};

  let usedToday = 0;
  if (limitData.date === today) {
    usedToday = limitData.count || 0;
  }

  if (usedToday >= MAX_MANUAL_SYNCS_PER_DAY) {
    return NextResponse.json(
      {
        error: "Daily sync limit reached",
        limit: MAX_MANUAL_SYNCS_PER_DAY,
        used: usedToday,
        remaining: 0,
      },
      { status: 429 },
    );
  }

  await limitRef.set({ date: today, count: usedToday + 1 }, { merge: true });

  try {
    const result = await runSync("incremental");
    return NextResponse.json({
      success: true,
      // This branch's sync runs to completion in a single call, so the client
      // never needs to repeat the request. Be explicit so the UI loop stops.
      done: true,
      ...result,
      syncLimit: {
        limit: MAX_MANUAL_SYNCS_PER_DAY,
        used: usedToday + 1,
        remaining: MAX_MANUAL_SYNCS_PER_DAY - usedToday - 1,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[fieldroutes/manual-sync] failed:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const uid = await getUidFromRequest(request);
  if (!uid) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = adminDb();
  const userDoc = await db.doc(`users/${uid}`).get();
  const companyId = userDoc.data()?.companyId;
  if (!companyId) {
    return NextResponse.json({ error: "no company associated" }, { status: 403 });
  }

  const today = todayCentral();
  const limitRef = db.doc(`companies/${companyId}/fieldRoutesState/manualSync`);
  const limitSnap = await limitRef.get();
  const limitData = limitSnap.data() || {};

  let usedToday = 0;
  if (limitData.date === today) {
    usedToday = limitData.count || 0;
  }

  return NextResponse.json({
    limit: MAX_MANUAL_SYNCS_PER_DAY,
    used: usedToday,
    remaining: MAX_MANUAL_SYNCS_PER_DAY - usedToday,
  });
}
