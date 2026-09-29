import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FirestoreOAuthStore } from "./firestore-store.ts";
import type { CodeRecord, RefreshRecord } from "./store.ts";

type Rec = Record<string, unknown>;
const tick = () => new Promise((r) => setTimeout(r, 1));

/**
 * A Firestore stand-in where plain get()/delete() YIELD between steps (so a get-then-delete
 * implementation is genuinely racy here, as it is in production) while runTransaction()
 * serialises its callbacks the way Firestore's transactions guarantee.
 */
class FakeFirestore {
  data = new Map<string, Rec>();
  private lock: Promise<unknown> = Promise.resolve();
  collection(name: string) {
    return {
      doc: (id: string) => {
        const key = `${name}/${id}`;
        return {
          key,
          set: async (v: Rec) => { await tick(); this.data.set(key, v); },
          get: async () => { await tick(); const d = this.data.get(key); return { exists: d !== undefined, data: () => d }; },
          delete: async () => { await tick(); this.data.delete(key); },
        };
      },
      where: (field: string, _op: string, value: unknown) => ({
        get: async () => {
          await tick();
          const docs = [...this.data].filter(([k, v]) => k.startsWith(`${name}/`) && v[field] === value).map(([key]) => ({ ref: { key } }));
          return { docs };
        },
      }),
    };
  }
  batch() {
    const keys: string[] = [];
    return { delete: (r: { key: string }) => { keys.push(r.key); }, commit: async () => { await tick(); for (const k of keys) this.data.delete(k); } };
  }
  runTransaction<T>(fn: (tx: { get: (r: { key: string }) => Promise<{ exists: boolean; data: () => Rec | undefined }>; delete: (r: { key: string }) => void; update: (r: { key: string }, v: Rec) => void }) => Promise<T>): Promise<T> {
    const run = async () => {
      const pendingDeletes: string[] = [];
      const pendingUpdates: Array<[string, Rec]> = [];
      const result = await fn({
        get: async (r) => { const d = this.data.get(r.key); return { exists: d !== undefined, data: () => d }; },
        delete: (r) => { pendingDeletes.push(r.key); },
        update: (r, v) => { pendingUpdates.push([r.key, v]); },
      });
      for (const [k, v] of pendingUpdates) this.data.set(k, { ...this.data.get(k), ...v });
      for (const k of pendingDeletes) this.data.delete(k);
      return result;
    };
    const next = this.lock.then(run, run);
    this.lock = next.catch(() => undefined);
    return next;
  }
}

const code: CodeRecord = { clientId: "cid", redirectUri: "https://a.com/cb", codeChallenge: "c".repeat(43), email: "a@flexpestcontrol.com", scope: "mcp:read", resource: "https://x/api/mcp", expiresAtMs: 1_800_000_060_000 };
const refresh: RefreshRecord = { clientId: "cid", email: "a@flexpestcontrol.com", scope: "mcp:read", resource: "https://x/api/mcp", familyId: "fam1", familyStartMs: 1_800_000_000_000, expiresAtMs: 1_802_592_000_000 };
const make = () => { const db = new FakeFirestore(); return { db, store: new FirestoreOAuthStore(db as never) }; };

describe("FirestoreOAuthStore", () => {
  it("round-trips an authorization code, keyed by its hash", async () => {
    const { db, store } = make();
    await store.putCode("HASH1", code);
    assert.ok(db.data.has("mcpOAuthCodes/HASH1"));
    assert.deepEqual(await store.takeCode("HASH1"), code);
  });

  it("stores expiry as a real Date so a Firestore TTL policy on `expiresAt` can purge old documents", async () => {
    const { db, store } = make();
    await store.putCode("H", code);
    await store.putRefresh("R", refresh);
    assert.ok((db.data.get("mcpOAuthCodes/H")!.expiresAt as unknown) instanceof Date);
    assert.ok((db.data.get("mcpOAuthRefreshTokens/R")!.expiresAt as unknown) instanceof Date);
  });

  it("reads Firestore Timestamps back as milliseconds", async () => {
    const { db, store } = make();
    db.data.set("mcpOAuthCodes/T", { ...code, expiresAt: { toMillis: () => 12345 } });
    assert.equal((await store.takeCode("T"))!.expiresAtMs, 12345);
  });

  it("treats an unreadable expiry as already expired (fails safe)", async () => {
    const { db, store } = make();
    db.data.set("mcpOAuthCodes/BAD", { ...code, expiresAt: "garbage" });
    db.data.set("mcpOAuthCodes/NONE", { ...code, expiresAt: undefined });
    assert.equal((await store.takeCode("BAD"))!.expiresAtMs, 0);
    assert.equal((await store.takeCode("NONE"))!.expiresAtMs, 0);
  });

  it("makes a code SINGLE-USE: consumed on first take, gone afterwards", async () => {
    const { db, store } = make();
    await store.putCode("H", code);
    assert.ok(await store.takeCode("H"));
    assert.equal(await store.takeCode("H"), null);
    assert.equal(db.data.size, 0);
  });

  it("gives a code to exactly ONE of many simultaneous redemptions", async () => {
    const { store } = make();
    await store.putCode("H", code);
    const results = await Promise.all(Array.from({ length: 10 }, () => store.takeCode("H")));
    assert.equal(results.filter(Boolean).length, 1, "a double-spend would mint two token pairs from one code");
  });

  it("gives a refresh token to exactly ONE of many simultaneous rotations", async () => {
    const { store } = make();
    await store.putRefresh("R", refresh);
    const results = await Promise.all(Array.from({ length: 10 }, () => store.takeRefresh("R")));
    assert.equal(results.filter((r) => r && !r.consumed).length, 1, "only one caller gets the live token; the rest see it spent");
    assert.equal(results.find((r) => r && !r.consumed)!.rec.familyStartMs, refresh.familyStartMs, "the family start survives rotation");
  });

  it("keeps a spent refresh token as a tombstone and can revoke the whole family", async () => {
    const { store } = make();
    await store.putRefresh("R1", refresh);
    await store.putRefresh("R2", refresh);
    await store.putRefresh("OTHER", { ...refresh, familyId: "fam2" });
    assert.equal((await store.takeRefresh("R1"))!.consumed, false);
    const again = await store.takeRefresh("R1");
    assert.equal(again!.consumed, true, "a second presentation is recognisable as reuse");
    assert.equal(again!.rec.familyId, "fam1");
    await store.revokeFamily("fam1");
    assert.equal(await store.takeRefresh("R1"), null);
    assert.equal(await store.takeRefresh("R2"), null);
    assert.equal((await store.takeRefresh("OTHER"))!.consumed, false, "other families are untouched");
  });

  it("returns null for anything unknown, and deletes refresh tokens on request", async () => {
    const { store } = make();
    assert.equal(await store.takeCode("nope"), null);
    assert.equal(await store.takeRefresh("nope"), null);
    await store.putRefresh("R", refresh);
    await store.deleteRefresh("R");
    assert.equal(await store.takeRefresh("R"), null);
    await store.revokeFamily("never-existed"); // must not throw
    await store.deleteRefresh("never-existed"); // must not throw
  });

  it("keeps codes and refresh tokens in separate collections", async () => {
    const { store } = make();
    await store.putCode("SAME", code);
    assert.equal(await store.takeRefresh("SAME"), null);
    assert.ok(await store.takeCode("SAME"));
  });
});
