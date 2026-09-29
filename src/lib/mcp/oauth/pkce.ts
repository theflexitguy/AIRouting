// PKCE (RFC 7636), S256 only. `plain` is deliberately unsupported: it offers no protection
// against an intercepted authorization code.

import { createHash, timingSafeEqual } from "node:crypto";

/** A code_challenge is base64url(SHA-256(verifier)): always exactly 43 characters. */
export const isValidChallenge = (c: unknown): c is string => typeof c === "string" && /^[A-Za-z0-9_-]{43}$/.test(c);

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
export const isValidVerifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(v);

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function verifyS256(verifier: unknown, challenge: string): boolean {
  if (!isValidVerifier(verifier) || !isValidChallenge(challenge)) return false;
  const a = Buffer.from(challengeFor(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
