// Minimal HS256 JWTs (compact JWS) for the tokens this server issues and verifies.
//
// Hard rules, each covered by a test:
//  - The algorithm is PINNED to HS256. A token claiming `none` (or anything else) is rejected
//    before any signature work — the classic JWT downgrade.
//  - Every token has a PURPOSE ("access", "state", "consent", "client"), and the signing key is
//    derived per purpose (HMAC of the secret with the purpose). A token minted for one purpose
//    therefore cannot verify as another — a stolen `state` value can never be presented as an
//    access token — even though one secret backs them all. The claim is checked too.
//  - Signatures are compared with timingSafeEqual.
//  - `exp` is enforced when present; purposes that expire always set it.

import { createHmac, timingSafeEqual } from "node:crypto";

export type Claims = Record<string, unknown>;

const b64u = (buf: Buffer | string): string => Buffer.from(buf).toString("base64url");

function deriveKey(secret: string, purpose: string): Buffer {
  return createHmac("sha256", secret).update(`routiq-mcp-oauth:${purpose}`).digest();
}

function sign(key: Buffer, signingInput: string): Buffer {
  return createHmac("sha256", key).update(signingInput).digest();
}

export function signJwt(
  secret: string,
  purpose: string,
  claims: Claims,
  opts: { nowSec: number; ttlSec?: number },
): string {
  const payload: Claims = { ...claims, use: purpose, iat: opts.nowSec };
  if (opts.ttlSec !== undefined) payload.exp = opts.nowSec + opts.ttlSec;
  const input = `${b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64u(JSON.stringify(payload))}`;
  return `${input}.${b64u(sign(deriveKey(secret, purpose), input))}`;
}

/** Returns the claims, or null for ANY problem (malformed, wrong alg, bad signature, wrong purpose, expired). */
export function verifyJwt(secret: string, purpose: string, token: string, opts: { nowSec: number }): Claims | null {
  if (typeof token !== "string" || token.length > 8192) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  let header: Claims;
  let payload: Claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header?.alg !== "HS256") return null; // pinned: rejects "none", RS256 confusion, everything else
  const expected = sign(deriveKey(secret, purpose), `${parts[0]}.${parts[1]}`);
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (!payload || typeof payload !== "object" || payload.use !== purpose) return null;
  if (payload.exp !== undefined && !(typeof payload.exp === "number" && opts.nowSec < payload.exp)) return null;
  return payload;
}

/** Cheap shape test so a static API key is never fed to the JWT verifier (and vice versa). */
export const looksLikeJwt = (token: string): boolean => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
