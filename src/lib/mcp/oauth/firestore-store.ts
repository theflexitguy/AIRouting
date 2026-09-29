// Firestore-backed OAuthStore. Top-level collections; the app's security rules deny client
// access to anything not explicitly matched, so browsers can never read these (only the Admin
// SDK, which this uses). `expiresAt` is stored as a Firestore timestamp so a TTL policy on that
// field ("expiresAt") can purge expired documents automatically.

import type { CodeRecord, OAuthStore, RefreshRecord } from "./store.ts";

const CODES = "mcpOAuthCodes";
const REFRESH = "mcpOAuthRefreshTokens";

type Db = FirebaseFirestore.Firestore;
type Data = FirebaseFirestore.DocumentData;

/** A stored expiry as milliseconds: accepts a Firestore Timestamp, a Date, or a number. Anything else is 0
 *  — which every caller treats as ALREADY EXPIRED, so an unreadable value fails safe. */
const ms = (v: unknown): number => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (v instanceof Date) return v.getTime();
  const t = v as { toMillis?: () => number; toDate?: () => Date } | null;
  if (typeof t?.toMillis === "function") return t.toMillis();
  if (typeof t?.toDate === "function") return t.toDate().getTime();
  return 0;
};

export class FirestoreOAuthStore implements OAuthStore {
  private readonly db: Db;
  // (No constructor parameter properties: the test runner strips types but cannot transform them.)
  constructor(db: Db) {
    this.db = db;
  }

  private async take(collection: string, hash: string): Promise<Data | null> {
    const ref = this.db.collection(collection).doc(hash);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      tx.delete(ref);
      return snap.data() as Data;
    });
  }

  async putCode(hash: string, r: CodeRecord) {
    await this.db.collection(CODES).doc(hash).set({ ...r, expiresAt: new Date(r.expiresAtMs) });
  }
  async takeCode(hash: string): Promise<CodeRecord | null> {
    const d = await this.take(CODES, hash);
    return d && { clientId: d.clientId, redirectUri: d.redirectUri, codeChallenge: d.codeChallenge, email: d.email, scope: d.scope, resource: d.resource, expiresAtMs: ms(d.expiresAt) };
  }
  async putRefresh(hash: string, r: RefreshRecord) {
    await this.db.collection(REFRESH).doc(hash).set({ ...r, expiresAt: new Date(r.expiresAtMs) });
  }
  async takeRefresh(hash: string): Promise<{ rec: RefreshRecord; consumed: boolean } | null> {
    const ref = this.db.collection(REFRESH).doc(hash);
    const got = await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const d = snap.data() as Data;
      if (d.consumed !== true) tx.update(ref, { consumed: true }); // tombstone: kept until `expiresAt` purges it
      return { d, consumed: d.consumed === true };
    });
    if (!got) return null;
    const d = got.d;
    return {
      consumed: got.consumed,
      rec: { clientId: d.clientId, email: d.email, scope: d.scope, resource: d.resource, familyId: String(d.familyId ?? ""), familyStartMs: Number(d.familyStartMs), expiresAtMs: ms(d.expiresAt) },
    };
  }
  async deleteRefresh(hash: string) {
    await this.db.collection(REFRESH).doc(hash).delete();
  }
  async revokeFamily(familyId: string) {
    if (!familyId) return;
    const snap = await this.db.collection(REFRESH).where("familyId", "==", familyId).get();
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = this.db.batch();
      for (const doc of snap.docs.slice(i, i + 400)) batch.delete(doc.ref);
      await batch.commit();
    }
  }
}
