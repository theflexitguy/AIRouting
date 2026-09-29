import type { CodeRecord, OAuthStore, RefreshRecord } from "./store.ts";

/** In-memory OAuthStore for tests. */
export class MemoryOAuthStore implements OAuthStore {
  codes = new Map<string, CodeRecord>();
  refresh = new Map<string, RefreshRecord>();
  spent = new Set<string>();
  async putCode(hash: string, rec: CodeRecord) { this.codes.set(hash, rec); }
  async takeCode(hash: string) {
    const r = this.codes.get(hash) ?? null;
    this.codes.delete(hash);
    return r;
  }
  async putRefresh(hash: string, rec: RefreshRecord) { this.refresh.set(hash, rec); }
  async takeRefresh(hash: string) {
    const rec = this.refresh.get(hash);
    if (!rec) return null;
    const consumed = this.spent.has(hash);
    this.spent.add(hash);
    return { rec, consumed };
  }
  async deleteRefresh(hash: string) { this.refresh.delete(hash); this.spent.delete(hash); }
  async revokeFamily(familyId: string) {
    for (const [h, r] of [...this.refresh]) if (r.familyId === familyId) { this.refresh.delete(h); this.spent.delete(h); }
  }
  /** Tokens that can still be redeemed. */
  get live() { return [...this.refresh.keys()].filter((h) => !this.spent.has(h)); }
}
