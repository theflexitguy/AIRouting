// The production wiring of api-auth: Firebase ID tokens verified with the Admin SDK, profiles read from users/{uid}.
// Route files import `guarded` from here.

import { adminAuth, adminDb } from "@/lib/firebase-admin";
import { createGuard, type Profile } from "@/lib/api-auth";

export type { Access, ApiAuth } from "@/lib/api-auth";

const guard = createGuard({
  verifyIdToken: async (token) => {
    const d = await adminAuth().verifyIdToken(token);
    return { uid: d.uid, email: d.email };
  },
  loadProfile: async (uid): Promise<Profile | null> => {
    const snap = await adminDb().doc(`users/${uid}`).get();
    const d = snap.data();
    if (!snap.exists || !d || typeof d.companyId !== "string" || !d.companyId) return null;
    return { companyId: d.companyId, role: typeof d.role === "string" ? d.role : "" };
  },
  operatorSecret: () => (process.env.CRON_SECRET || "").trim(),
  now: () => Date.now(),
});

export const guarded = guard.guarded;
