// Runtime configuration for the Routiq MCP server. Everything comes from environment
// variables so nothing secret is ever committed.
//
//   MCP_API_KEY         required. The bearer token clients present. 24+ characters —
//                       generate one with `openssl rand -hex 32`.
//   MCP_API_KEYS        optional. Comma-separated extra keys, so a key can be rotated
//                       without downtime (add the new one, move clients, drop the old).
//   MCP_COMPANY_ID      optional. Which company this server exposes. Falls back to
//                       FIELDROUTES_COMPANY_ID, then to the only company if exactly one exists.
//   MCP_CACHE_TTL_SECONDS  optional. How long Firestore reads are reused (default 60).

export const MIN_KEY_LENGTH = 24;

export interface McpConfig {
  /** Accepted bearer tokens. Empty = the server is disabled (fails closed). */
  keys: string[];
  /** Explicitly configured company, or null to auto-detect. */
  companyId: string | null;
  cacheTtlMs: number;
  /** Keys that were set but rejected as too short — surfaced so a typo isn't silent. */
  rejectedShortKeys: number;
}

type Env = Record<string, string | undefined>;

export function readMcpConfig(env: Env = process.env): McpConfig {
  const raw = [env.MCP_API_KEY, ...(env.MCP_API_KEYS || "").split(",")]
    .map((k) => (k || "").trim())
    .filter(Boolean);
  const keys = Array.from(new Set(raw.filter((k) => k.length >= MIN_KEY_LENGTH)));
  // Counted directly (not raw − unique) so a merely duplicated key is not reported as too short.
  const rejectedShortKeys = raw.filter((k) => k.length < MIN_KEY_LENGTH).length;
  const ttl = Number(env.MCP_CACHE_TTL_SECONDS);
  return {
    keys,
    companyId: (env.MCP_COMPANY_ID || env.FIELDROUTES_COMPANY_ID || "").trim() || null,
    cacheTtlMs: (Number.isFinite(ttl) && ttl >= 0 ? ttl : 60) * 1000,
    rejectedShortKeys,
  };
}
