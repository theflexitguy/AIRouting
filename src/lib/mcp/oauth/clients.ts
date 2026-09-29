// Dynamic client registration (RFC 7591) — STATELESS.
//
// Clients register themselves, but registration stores NOTHING: the client_id IS a signed token
// carrying the client's name and redirect URIs. That closes the obvious abuse of an open
// registration endpoint (an unauthenticated caller flooding the database) and means there is no
// client table to maintain. /authorize and /token verify the signature and read the redirect URIs
// back out of it, so a client cannot alter its own redirect URIs after registering.
//
// Registering grants nothing by itself: an attacker can register a client with their own redirect
// URI, but a code is only issued after a Flex Pest Control employee signs in with Google AND clicks
// Allow on a consent screen that shows that client's name and redirect address.

import type { OAuthConfig } from "./config.ts";
import { SCOPE } from "./config.ts";
import { signJwt, verifyJwt } from "./jwt.ts";
import { validateRedirectUri } from "./redirect.ts";

export interface RegisteredClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  grants: string[];
}

export class RegistrationError extends Error {
  readonly code: "invalid_redirect_uri" | "invalid_client_metadata";
  constructor(code: "invalid_redirect_uri" | "invalid_client_metadata", message: string) {
    super(message);
    this.code = code;
  }
}

const MAX_URIS = 5;
/** The client id is nested inside the sign-in state and consent tokens (which also carry the redirect URI, the app's own
 *  state and more), and each of those must stay under MAX_JWT_CHARS. Sizing the id at 2400 leaves them room. */
export const MAX_CLIENT_ID_CHARS = 2400;
const GRANTS = ["authorization_code", "refresh_token"];

/** Untrusted display text: strip control and invisible format characters (bidi overrides, zero-width, BOM…) so the
 *  name cannot reorder or disguise the text around it, collapse whitespace, bound the length. */
export function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/[\p{Cc}\u2028\u2029]/gu, " ").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim() : "";
  return (s || "Unnamed application").slice(0, 100);
}

export function registerClient(cfg: OAuthConfig, body: unknown, nowSec: number) {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_URIS) {
    throw new RegistrationError("invalid_redirect_uri", `redirect_uris must be an array of 1 to ${MAX_URIS} URIs`);
  }
  for (const u of uris) {
    const problem = validateRedirectUri(u);
    if (problem) throw new RegistrationError("invalid_redirect_uri", problem);
  }
  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== "none") {
    throw new RegistrationError("invalid_client_metadata", 'only token_endpoint_auth_method "none" (public clients using PKCE) is supported');
  }
  const grants = b.grant_types === undefined ? GRANTS : b.grant_types;
  if (!Array.isArray(grants) || grants.some((g) => !GRANTS.includes(g as string)) || !grants.includes("authorization_code")) {
    throw new RegistrationError("invalid_client_metadata", `grant_types must include authorization_code and may only include: ${GRANTS.join(", ")}`);
  }
  const grantTypes = Array.from(new Set(grants as string[]));
  if (b.response_types !== undefined && !(Array.isArray(b.response_types) && b.response_types.every((r) => r === "code"))) {
    throw new RegistrationError("invalid_client_metadata", 'response_types may only be ["code"]');
  }

  const redirectUris = Array.from(new Set(uris as string[]));
  const name = cleanName(b.client_name);
  const clientId = signJwt(cfg.secret, "client", { name, uris: redirectUris, gt: grantTypes }, { nowSec }); // no exp: revoke by rotating MCP_OAUTH_SECRET
  if (clientId.length > MAX_CLIENT_ID_CHARS) {
    // Would be issued but then rejected as unknown at /authorize, so refuse it up front.
    throw new RegistrationError("invalid_client_metadata", "the registration metadata is too large; use fewer or shorter redirect_uris and a shorter client_name");
  }
  return {
    clientId,
    response: {
      client_id: clientId,
      client_id_issued_at: nowSec,
      client_name: name,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPE,
    },
  };
}

export function resolveClient(cfg: OAuthConfig, clientId: unknown, nowSec: number): RegisteredClient | null {
  if (typeof clientId !== "string") return null;
  const c = verifyJwt(cfg.secret, "client", clientId, { nowSec });
  if (!c || !Array.isArray(c.uris) || c.uris.length === 0) return null;
  // Belt and braces: never trust a redirect URI just because it came out of a signed token.
  if (c.uris.some((u) => validateRedirectUri(u) !== null)) return null;
  const grants = Array.isArray(c.gt) ? (c.gt as unknown[]).filter((g): g is string => typeof g === "string" && GRANTS.includes(g)) : GRANTS;
  return { clientId, name: cleanName(c.name), redirectUris: c.uris as string[], grants };
}
