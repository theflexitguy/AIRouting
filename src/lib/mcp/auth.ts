// Bearer-token authentication for the MCP endpoint.
//
// Design rules:
//  - FAIL CLOSED. With no valid key configured, every request is refused (503) — the
//    endpoint can never be accidentally open.
//  - Tokens are compared as SHA-256 digests with timingSafeEqual, against EVERY
//    configured key without early exit, so response timing reveals neither which key
//    matched nor how much of a guess was right.
//  - The token is accepted from the Authorization header (or x-api-key) only — never
//    from the query string, where it would be written to access logs and browser history.
//  - Nothing here ever logs or returns a key; a short non-reversible id is used for logs.

import { createHash, timingSafeEqual } from "node:crypto";

export type AuthResult =
  | { ok: true; keyId: string }
  | { ok: false; status: 401 | 503; message: string };

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/** Pull the presented token out of the request headers, or "" if none. */
export function extractToken(headers: Headers): string {
  const auth = headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) return m[1].trim();
  return (headers.get("x-api-key") || "").trim();
}

export function authorize(headers: Headers, keys: string[]): AuthResult {
  if (keys.length === 0) {
    return {
      ok: false,
      status: 503,
      message: "The Routiq MCP server is not configured (no valid MCP_API_KEY is set).",
    };
  }
  const token = extractToken(headers);
  if (!token) {
    return { ok: false, status: 401, message: "Missing credentials. Send `Authorization: Bearer <MCP_API_KEY>`." };
  }
  const presented = digest(token);
  let matched = "";
  for (const key of keys) {
    const candidate = digest(key);
    // Evaluate every key: no early return, so timing does not depend on which one matched.
    if (timingSafeEqual(presented, candidate) && !matched) matched = candidate.toString("hex").slice(0, 8);
  }
  if (!matched) return { ok: false, status: 401, message: "Invalid credentials." };
  return { ok: true, keyId: matched };
}
