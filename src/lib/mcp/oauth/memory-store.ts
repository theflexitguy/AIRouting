import type { CodeRecord, OAuthStore, RefreshRecord } from "./store.ts";

/** In-memory OAuthStore for tests. */
export class MemoryOAuthStore implements OAuthStore {
  codes = new Map<string, CodeRecord>();
  refresh = new Map<string, RefreshRecord>();
  spent = new Set<string>();
  revoked = new Map<string, number>();
  async putCode(hash: string, rec: CodeRecord) { this.codes.set(hash, rec); }
  async takeCode(hash: string) {
    const r = this.codes.get(hash) ?? null;
    this.codes.delete(hash);
    return r;
  }
  async putRefresh(hash: string, rec: RefreshRecord) {
    if (this.revoked.has(rec.familyId)) return false;
    this.refresh.set(hash, rec);
    return true;
  }
  async takeRefresh(hash: string) {
    const rec = this.refresh.get(hash);
    if (!rec) return null;
    const consumed = this.spent.has(hash);
    this.spent.add(hash);
    return { rec, consumed };
  }
  async revokeFamily(familyId: string, untilMs: number) {
    this.revoked.set(familyId, untilMs);
    for (const [h, r] of [...this.refresh]) if (r.familyId === familyId) { this.refresh.delete(h); this.spent.delete(h); }
  }
  /** Tokens that can still be redeemed. */
  get live() { return [...this.refresh.keys()].filter((h) => !this.spent.has(h)); }
}
