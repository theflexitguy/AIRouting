// Result shaping shared by every tool: compact JSON (LLM context is the scarce resource),
// pagination, and a hard cap so one call can never flood a client.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** A problem with what the caller asked for (bad filter, unknown technician…). Reported
 *  to the model as an actionable message rather than an opaque server error. */
export class ToolInputError extends Error {}

export const MAX_RESPONSE_CHARS = 120_000;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function ok(data: Record<string, unknown>): CallToolResult {
  const text = JSON.stringify(data);
  if (text.length > MAX_RESPONSE_CHARS) {
    return fail(
      `That result is too large (${text.length.toLocaleString()} characters). ` +
        `Narrow the filters, lower "limit", or page with "offset".`,
    );
  }
  // Text only. Also returning structuredContent would put the same payload in front of the model
  // twice in any client that forwards both, doubling the token cost of every call.
  return { content: [{ type: "text", text }] };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export function paginate<T>(rows: T[], limit: number, offset: number): Page<T> {
  const lim = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || DEFAULT_LIMIT));
  const off = Math.max(0, Math.floor(offset) || 0);
  const items = rows.slice(off, off + lim);
  const end = off + items.length;
  return { items, total: rows.length, offset: off, limit: lim, hasMore: end < rows.length, nextOffset: end < rows.length ? end : null };
}

export const round = (v: number | null | undefined, digits = 1): number | null => {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/** Whole percent from a 0..1 ratio (matches the dashboard's Math.round(x * 100)). */
export const pct = (ratio: number): number => Math.round(ratio * 100);

/** "5h 12m" — same shape as the dashboard's drive-time cards. */
export function fmtMinutes(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}

export const money = (v: number): string =>
  v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
