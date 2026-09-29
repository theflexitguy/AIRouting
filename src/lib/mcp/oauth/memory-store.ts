import type { CodeRecord, OAuthStore, RefreshRecord } from "./store.ts";

/** In-memory OAuthStore for tests. */
export class MemoryOAuthStore implements OAuthStore {
  codes = new Map<string, CodeRecord>();
  refresh = new Map<string, RefreshRecord>();
  async putCode(hash: string, rec: CodeRecord) { this.codes.set(hash, rec); }
  async takeCode(hash: string) {
    const r = this.codes.get(hash) ?? null;
    this.codes.delete(hash);
    return r;
  }
  async putRefresh(hash: string, rec: RefreshRecord) { this.refresh.set(hash, rec); }
  async takeRefresh(hash: string) {
    const r = this.refresh.get(hash) ?? null;
    this.refresh.delete(hash);
    return r;
  }
  async deleteRefresh(hash: string) { this.refresh.delete(hash); }
}
