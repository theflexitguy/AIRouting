export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { adminDb, adminAuth } from "@/lib/firebase-admin";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { email, targetCompanyId } = body as {
    email?: string;
    targetCompanyId?: string;
  };

  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  const db = adminDb();
  const auth = adminAuth();

  try {
    const userRecord = await auth.getUserByEmail(email);
    const uid = userRecord.uid;

    const userDoc = await db.doc(`users/${uid}`).get();
    if (!userDoc.exists) {
      return NextResponse.json({
        error: "User profile not found in Firestore",
        uid,
        email,
        hint: "User exists in Firebase Auth but has no Firestore profile document.",
      }, { status: 404 });
    }

    const profile = userDoc.data()!;
    const companyId = profile.companyId || "(none)";

    const companyDoc = await db.doc(`companies/${companyId}`).get();
    const companyData = companyDoc.exists ? companyDoc.data() : null;

    const techSnap = await db.collection(`companies/${companyId}/technicians`).get();
    const techs = techSnap.docs.map(d => ({
      id: d.id,
      name: d.data().name || d.id,
      active: d.data().active,
    }));

    const jobSnap = await db.collection(`companies/${companyId}/jobs`).limit(5).get();
    const jobCount = jobSnap.size;

    const routeSnap = await db.collection(`companies/${companyId}/routes`).limit(5).get();
    const routeCount = routeSnap.size;

    const lockDoc = await db.doc(`routeGeneration/${companyId}`).get();
    const lockData = lockDoc.exists ? lockDoc.data() : null;

    const diagnosis = {
      uid,
      email,
      companyId,
      role: profile.role || "(none)",
      company: companyData ? { name: companyData.name, plan: companyData.plan, active: companyData.active } : null,
      technicians: { count: techs.length, list: techs },
      jobs: { sampleCount: jobCount, note: jobCount === 5 ? "5+ jobs exist (showing limit)" : `${jobCount} total` },
      routes: { sampleCount: routeCount, note: routeCount === 5 ? "5+ routes exist (showing limit)" : `${routeCount} total` },
      activeLock: lockData,
    };

    if (targetCompanyId) {
      const targetCompanyDoc = await db.doc(`companies/${targetCompanyId}`).get();
      if (!targetCompanyDoc.exists) {
        return NextResponse.json({
          ...diagnosis,
          reassign: { error: `Target company ${targetCompanyId} does not exist` },
        });
      }

      await db.doc(`users/${uid}`).update({ companyId: targetCompanyId });

      const targetTechSnap = await db.collection(`companies/${targetCompanyId}/technicians`).get();
      return NextResponse.json({
        ...diagnosis,
        reassign: {
          success: true,
          previousCompanyId: companyId,
          newCompanyId: targetCompanyId,
          newCompanyName: targetCompanyDoc.data()?.name || targetCompanyId,
          newTechnicianCount: targetTechSnap.size,
          note: "User must log out and log back in for the change to take effect.",
        },
      });
    }

    return NextResponse.json(diagnosis);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg, email }, { status: 500 });
  }
}
