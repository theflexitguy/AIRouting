export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { adminAuth, adminDb } from "@/lib/firebase-admin";

// Self-service sign-up: creates the caller's profile and a brand-new company for them.
//
//   POST /api/account/init   Authorization: Bearer <Firebase ID token>   { "companyName": "Acme Pest" }
//
// This exists so the Firestore rules can forbid clients from writing users/{uid}. If a browser could write its own
// profile it could name ANY companyId and role, and would then pass every "member of this company" check — i.e. join
// someone else's company as an admin. Here the server chooses the company id (always a new one) and the role, and
// refuses to touch an account that already has a profile.
//
// It is the one API route that is not behind `guarded(...)`: a brand-new user has no profile yet, so there is no
// company to check. It still requires a valid ID token.

export async function POST(request: NextRequest) {
  const header = request.headers.get("authorization") || "";
  const token = /^Bearer /i.test(header) ? header.slice(7).trim() : "";
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": 'Bearer realm="routiq"' } });

  let uid: string;
  let email = "";
  try {
    const decoded = await adminAuth().verifyIdToken(token);
    uid = decoded.uid;
    email = decoded.email || "";
  } catch {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { companyName?: unknown };
  const companyName = typeof body.companyName === "string" ? body.companyName.trim().slice(0, 120) : "";
  if (!companyName) return NextResponse.json({ error: "companyName is required" }, { status: 400 });

  const companyId = `company_${randomBytes(12).toString("hex")}`;
  const db = adminDb();
  const now = new Date().toISOString();
  try {
    // create() fails if the profile already exists, so this can never re-point or re-promote an existing account.
    await db.doc(`users/${uid}`).create({ uid, email, companyId, role: "admin", createdAt: now });
  } catch (e) {
    const code = (e as { code?: number | string })?.code;
    if (code === 6 || code === "already-exists") return NextResponse.json({ error: "this account is already set up" }, { status: 409 });
    console.error("[account/init] profile create failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "could not create the account" }, { status: 500 });
  }
  try {
    await db.doc(`companies/${companyId}`).set({ name: companyName, plan: "pro", active: true, createdAt: now });
  } catch (e) {
    console.error("[account/init] company create failed", e instanceof Error ? e.message : e);
    await db.doc(`users/${uid}`).delete().catch(() => undefined); // don't leave a profile pointing at nothing
    return NextResponse.json({ error: "could not create the account" }, { status: 500 });
  }
  return NextResponse.json({ companyId }, { status: 201 });
}
