// The OAuth 2.1 authorization-code flow (with PKCE), brokering identity to Google.
//
//   client ──register──▶ /api/oauth/register        stateless: client_id is a signed token
//   client ──────────▶ /api/oauth/authorize        checks client + redirect + PKCE, remembers the
//                                                    request in a SIGNED state token, sets a
//                                                    same-browser cookie, redirects to Google
//   Google ──────────▶ /api/oauth/google/callback  verifies state + cookie, exchanges the code,
//                                                    verifies the id_token, enforces the domain,
//                                                    shows the consent screen
//   user ───Allow────▶ /api/oauth/consent          issues a single-use authorization code
//   client ──────────▶ /api/oauth/token            code+PKCE → short-lived access token + rotating
//                                                    refresh token
//
// Everything before the code is stateless (signed tokens). Only codes and refresh tokens touch the
// database, and only after a real employee has signed in — so unauthenticated callers cannot cause writes.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthConfig } from "./config.ts";
import { SCOPE } from "./config.ts";
import { RegistrationError, registerClient, resolveClient } from "./clients.ts";
import { checkAccess, emailAllowed, type GoogleClient } from "./google.ts";
import { consentPage, errorPage } from "./html.ts";
import { MAX_JWT_CHARS, signJwt, verifyJwt } from "./jwt.ts";
import { isValidChallenge, verifyS256 } from "./pkce.ts";
import { redirectMatches } from "./redirect.ts";
import type { OAuthStore } from "./store.ts";

export interface FlowDeps {
  config: OAuthConfig;
  store: OAuthStore;
  google: GoogleClient;
  now?: () => number; // ms
  random?: (n: number) => Buffer;
}

export interface AccessIdentity {
  email: string;
  scope: string;
}

const MAX_BODY = 16 * 1024;
const MAX_CLIENT_STATE = 512;
const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
  "access-control-max-age": "86400",
};
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...NO_STORE, ...CORS, ...extra } });
}

async function readBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BODY) return null;
  // Content-Length can be absent (chunked) or wrong, so count the bytes actually received and stop reading at the cap.
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function createOAuthFlow(deps: FlowDeps) {
  const cfg = deps.config;
  const nowMs = deps.now ?? (() => Date.now());
  const nowSec = () => Math.floor(nowMs() / 1000);
  const rand = deps.random ?? ((n: number) => randomBytes(n));
  const secret = () => rand(32).toString("base64url");

  const url = {
    authorize: `${cfg.publicUrl}/api/oauth/authorize`,
    callback: `${cfg.publicUrl}/api/oauth/google/callback`,
    consent: `${cfg.publicUrl}/api/oauth/consent`,
    token: `${cfg.publicUrl}/api/oauth/token`,
    register: `${cfg.publicUrl}/api/oauth/register`,
    revoke: `${cfg.publicUrl}/api/oauth/revoke`,
    resourceMetadata: `${cfg.publicUrl}/.well-known/oauth-protected-resource/api/mcp`,
  };

  // ---- same-browser binding cookie (defeats a login started in one browser finishing in another) ----
  const secure = cfg.publicUrl.startsWith("https:");
  // One cookie PER sign-in attempt (name carries a short random id), so two sign-ins started from the same browser
  // at once — a retry, or two connectors — never overwrite each other's binding.
  const COOKIE_BASE = secure ? "__Host-routiq_mcp_bind_" : "routiq_mcp_bind_";
  const bindId = (v: unknown): string => (typeof v === "string" && /^[A-Za-z0-9_-]{1,16}$/.test(v) ? v : "");
  const setCookie = (id: string, value: string, maxAge: number) =>
    `${COOKIE_BASE}${id}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const readCookie = (req: Request, id: string): string => {
    if (!id) return "";
    for (const part of (req.headers.get("cookie") || "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE_BASE + id) return v.join("=");
    }
    return "";
  };
  const boundTo = (req: Request, id: string, bd: unknown) => typeof bd === "string" && !!readCookie(req, id) && same(sha256hex(readCookie(req, id)), bd);

  function redirectTo(uri: string, params: Record<string, string | undefined>, extra: Record<string, string> = {}): Response {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer", ...extra } });
  }

  const normResource = (r: string) => r.replace(/\/+$/, "");

  // ---------------------------------------------------------------- discovery
  const protectedResourceMetadata = () =>
    json(200, { resource: cfg.resource, authorization_servers: [cfg.publicUrl], scopes_supported: [SCOPE], bearer_methods_supported: ["header"], resource_name: "Routiq MCP" }, { "cache-control": "public, max-age=300" });

  const authorizationServerMetadata = () =>
    json(200, {
      issuer: cfg.publicUrl,
      authorization_endpoint: url.authorize,
      token_endpoint: url.token,
      registration_endpoint: url.register,
      revocation_endpoint: url.revoke,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
      service_documentation: "https://github.com/theflexitguy/AIRouting/blob/main/docs/MCP.md",
    }, { "cache-control": "public, max-age=300" });

  const preflight = () => new Response(null, { status: 204, headers: CORS });

  // ---------------------------------------------------------------- registration
  async function register(req: Request): Promise<Response> {
    const text = await readBody(req);
    if (text === null) return json(413, { error: "invalid_client_metadata", error_description: "request too large" });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "invalid_client_metadata", error_description: "body must be JSON" });
    }
    try {
      return json(201, registerClient(cfg, body, nowSec()).response);
    } catch (e) {
      if (e instanceof RegistrationError) return json(400, { error: e.code, error_description: e.message });
      throw e;
    }
  }

  // ---------------------------------------------------------------- authorize
  async function authorize(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams;
    // Until the client AND its redirect URI are proven genuine we must never redirect anywhere.
    const client = resolveClient(cfg, q.get("client_id"), nowSec());
    if (!client) return errorPage(400, "Unknown application", "This application is not registered, or its registration is no longer valid. Start the connection again from the app.");
    let redirectUri = q.get("redirect_uri");
    if (redirectUri === null && client.redirectUris.length === 1) redirectUri = client.redirectUris[0];
    if (!redirectUri || !redirectMatches(client.redirectUris, redirectUri)) {
      return errorPage(400, "Invalid redirect address", "The address this application asked to return to does not match its registration.");
    }
    const clientState = q.get("state") ?? undefined;
    const fail = (error: string, description: string) => redirectTo(redirectUri as string, { error, error_description: description, state: clientState });

    if (clientState !== undefined && clientState.length > MAX_CLIENT_STATE) return fail("invalid_request", "state is too long");
    if (q.get("response_type") !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
    const challenge = q.get("code_challenge");
    if (!isValidChallenge(challenge)) return fail("invalid_request", "a PKCE code_challenge is required");
    if (q.get("code_challenge_method") !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
    const scope = q.get("scope");
    if (scope && scope.split(/\s+/).some((s) => s && s !== SCOPE)) return fail("invalid_scope", `the only supported scope is ${SCOPE}`);
    const resource = q.get("resource");
    if (resource && normResource(resource) !== cfg.resource) return fail("invalid_target", "resource must be the Routiq MCP endpoint");

    const binding = secret();
    const bi = rand(6).toString("base64url");
    const nonce = secret();
    const state = signJwt(cfg.secret, "state", {
      cid: client.clientId, ru: redirectUri, cc: challenge, cs: clientState, sc: SCOPE, rs: cfg.resource, nc: nonce, bd: sha256hex(binding), bi,
    }, { nowSec: nowSec(), ttlSec: 600 });
    // Defensive: a state token our own verifier would refuse would strand the person at "Sign-in expired" after Google.
    if (state.length > MAX_JWT_CHARS) return fail("invalid_request", "the authorization request is too large");
    return new Response(null, {
      status: 302,
      headers: {
        location: deps.google.authorizationUrl({ redirectUri: url.callback, state, nonce }),
        "set-cookie": setCookie(bi, binding, 600),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  // ---------------------------------------------------------------- Google callback
  async function googleCallback(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams;
    const st = verifyJwt(cfg.secret, "state", q.get("state") || "", { nowSec: nowSec() });
    const bi = bindId(st?.bi);
    const clear: Record<string, string> = bi ? { "set-cookie": setCookie(bi, "", 0) } : {};
    if (!st) return errorPage(400, "Sign-in expired", "Return to your application and start connecting again.", clear);
    if (!boundTo(req, bi, st.bd)) {
      return errorPage(400, "Sign-in must finish in the same browser", "This sign-in was started in a different browser or window. Start connecting again from your application.", clear);
    }
    const client = resolveClient(cfg, st.cid, nowSec());
    const ru = st.ru as string;
    if (!client || !redirectMatches(client.redirectUris, ru)) return errorPage(400, "Unknown application", "Start the connection again from the app.", clear);

    if (q.get("error")) return redirectTo(ru, { error: "access_denied", error_description: "sign-in was cancelled", state: st.cs as string | undefined }, clear);
    const code = q.get("code");
    if (!code) return errorPage(400, "Sign-in failed", "Google did not return a sign-in code.", clear);

    let identity;
    try {
      identity = await deps.google.exchangeCode({ code, redirectUri: url.callback });
    } catch (e) {
      console.error("[mcp-oauth] Google exchange failed", e instanceof Error ? e.message : e);
      return errorPage(502, "Google sign-in failed", "We couldn't verify your Google sign-in. Please try again.", clear);
    }
    if (!identity.nonce || !same(identity.nonce, st.nc as string)) {
      return errorPage(400, "Sign-in could not be verified", "Start connecting again from your application.", clear);
    }
    const decision = checkAccess(cfg, identity);
    if (!decision.ok) {
      console.warn(`[mcp-oauth] sign-in denied: ${decision.reason}`);
      return errorPage(403, "Access denied", `Only ${cfg.allowedDomain} accounts${cfg.allowedEmails.length ? " on the approved list" : ""} can use Routiq. Sign in with your ${cfg.allowedDomain} Google account.`, clear);
    }

    const token = signJwt(cfg.secret, "consent", {
      cid: st.cid, ru, cc: st.cc, cs: st.cs, sc: st.sc, rs: st.rs, em: decision.email, bd: st.bd, bi,
    }, { nowSec: nowSec(), ttlSec: 300 });
    if (token.length > MAX_JWT_CHARS) return errorPage(400, "Request too large", "Start connecting again from your application.", clear);
    // Re-send the binding cookie so it lives at least as long as the consent token (Google sign-in/MFA may have used up
    // most of the original cookie's lifetime).
    return consentPage({ email: decision.email, clientName: client.name, redirectUri: ru, token, action: url.consent }, { "set-cookie": setCookie(bi, readCookie(req, bi), 360) });
  }

  // ---------------------------------------------------------------- consent decision
  async function consent(req: Request): Promise<Response> {
    let clear: Record<string, string> = {};
    const origin = req.headers.get("origin");
    if (origin && origin !== cfg.publicUrl) return errorPage(403, "Request blocked", "This request did not come from the consent page.", clear);
    const text = await readBody(req);
    if (text === null) return errorPage(413, "Request too large", "Start again.", clear);
    const form = new URLSearchParams(text);
    const c = verifyJwt(cfg.secret, "consent", form.get("token") || "", { nowSec: nowSec() });
    const bi = bindId(c?.bi);
    if (bi) clear = { "set-cookie": setCookie(bi, "", 0) };
    if (!c) return errorPage(400, "This page has expired", "Return to your application and start connecting again.", clear);
    if (!boundTo(req, bi, c.bd)) return errorPage(400, "Sign-in must finish in the same browser", "Start connecting again from your application.", clear);
    const client = resolveClient(cfg, c.cid, nowSec());
    const ru = c.ru as string;
    if (!client || !redirectMatches(client.redirectUris, ru)) return errorPage(400, "Unknown application", "Start the connection again from the app.", clear);
    if (!emailAllowed(cfg, c.em)) return errorPage(403, "Access denied", "This account is no longer allowed.", clear);

    if (form.get("decision") !== "allow") {
      return redirectTo(ru, { error: "access_denied", error_description: "the user declined", state: c.cs as string | undefined }, clear);
    }
    const code = secret();
    await deps.store.putCode(sha256hex(code), {
      clientId: c.cid as string, redirectUri: ru, codeChallenge: c.cc as string, email: c.em as string,
      scope: c.sc as string, resource: c.rs as string, expiresAtMs: nowMs() + cfg.codeTtlSec * 1000,
    });
    console.log(`[mcp-oauth] consent granted user=${c.em}`);
    return redirectTo(ru, { code, state: c.cs as string | undefined }, clear);
  }

  // ---------------------------------------------------------------- token
  const tokenError = (error: string, description: string, status = 400) => json(status, { error, error_description: description });

  async function issue(clientId: string, email: string, scope: string, resource: string, familyId: string, familyStartMs: number, withRefresh: boolean): Promise<Response> {
    const now = nowMs();
    const refresh = secret();
    // A client registered without the refresh_token grant gets an access token only.
    const stored = !withRefresh || await deps.store.putRefresh(sha256hex(refresh), {
      clientId, email, scope, resource, familyId, familyStartMs, familyEndMs: familyStartMs + cfg.refreshMaxAgeSec * 1000,
      expiresAtMs: Math.min(now + cfg.refreshTtlSec * 1000, familyStartMs + cfg.refreshMaxAgeSec * 1000),
    });
    if (!stored) return tokenError("invalid_grant", "this session was revoked; sign in again");
    const access = signJwt(cfg.secret, "access", {
      iss: cfg.publicUrl, aud: cfg.resource, sub: email, email, scope, azp: sha256hex(clientId).slice(0, 16), jti: rand(12).toString("base64url"),
    }, { nowSec: Math.floor(now / 1000), ttlSec: cfg.accessTtlSec });
    return json(200, { access_token: access, token_type: "Bearer", expires_in: cfg.accessTtlSec, ...(withRefresh ? { refresh_token: refresh } : {}), scope });
  }

  async function token(req: Request): Promise<Response> {
    const text = await readBody(req);
    if (text === null) return tokenError("invalid_request", "request too large");
    const p = new URLSearchParams(text);
    const client = resolveClient(cfg, p.get("client_id"), nowSec());
    if (!client) return tokenError("invalid_client", "unknown client", 401);
    const grant = p.get("grant_type");

    if (grant === "authorization_code") {
      if (!client.grants.includes("authorization_code")) return tokenError("unauthorized_client", "this client is not registered for the authorization_code grant");
      const code = p.get("code") || "";
      if (!code || code.length > 200) return tokenError("invalid_request", "code is required");
      // Consume FIRST: a code is single-use even if this attempt fails, so a stolen code cannot be retried.
      const rec = await deps.store.takeCode(sha256hex(code));
      if (!rec || rec.expiresAtMs <= nowMs()) return tokenError("invalid_grant", "the authorization code is invalid or expired");
      if (rec.clientId !== client.clientId) return tokenError("invalid_grant", "the code was issued to a different client");
      // A code minted for another endpoint (MCP_PUBLIC_URL changed since) must not be re-targeted at this one.
      if (rec.resource !== cfg.resource) return tokenError("invalid_grant", "the authorization was issued for a different resource");
      const ru = p.get("redirect_uri");
      if (ru !== null && ru !== rec.redirectUri) return tokenError("invalid_grant", "redirect_uri does not match the authorization request");
      if (!verifyS256(p.get("code_verifier"), rec.codeChallenge)) return tokenError("invalid_grant", "PKCE verification failed");
      if (!emailAllowed(cfg, rec.email)) return tokenError("invalid_grant", "this account is no longer allowed");
      console.log(`[mcp-oauth] token issued user=${rec.email}`);
      return issue(client.clientId, rec.email, rec.scope, rec.resource, rand(16).toString("base64url"), nowMs(), client.grants.includes("refresh_token"));
    }

    if (grant === "refresh_token") {
      if (!client.grants.includes("refresh_token")) return tokenError("unauthorized_client", "this client is not registered for the refresh_token grant");
      const rt = p.get("refresh_token") || "";
      if (!rt || rt.length > 200) return tokenError("invalid_request", "refresh_token is required");
      const scope = p.get("scope");
      if (scope && scope.split(/\s+/).some((s) => s && s !== SCOPE)) return tokenError("invalid_scope", `the only supported scope is ${SCOPE}`);
      const taken = await deps.store.takeRefresh(sha256hex(rt)); // rotation: the old token is spent here
      if (!taken) return tokenError("invalid_grant", "the refresh token is invalid, expired or already used");
      const rec = taken.rec;
      if (taken.consumed) {
        // A spent token came back: either the owner or a thief holds a copy. We can't tell which, so end the whole
        // login — every descendant token dies and the person signs in again.
        // Actionable until the whole FAMILY ends, not just this token's own expiry: a thief's successor can outlive it.
        if (rec.familyEndMs > nowMs()) {
          await deps.store.revokeFamily(rec.familyId, rec.familyEndMs);
          console.warn(`[mcp-oauth] refresh token reuse detected; revoked the session for user=${rec.email}`);
        }
        return tokenError("invalid_grant", "the refresh token is invalid, expired or already used");
      }
      if (rec.clientId !== client.clientId) return tokenError("invalid_grant", "the refresh token was issued to a different client");
      if (rec.resource !== cfg.resource) return tokenError("invalid_grant", "the refresh token was issued for a different resource");
      const now = nowMs();
      if (rec.expiresAtMs <= now || now >= rec.familyStartMs + cfg.refreshMaxAgeSec * 1000) return tokenError("invalid_grant", "the refresh token has expired; sign in again");
      if (!emailAllowed(cfg, rec.email)) return tokenError("invalid_grant", "this account is no longer allowed");
      return issue(client.clientId, rec.email, rec.scope, rec.resource, rec.familyId, rec.familyStartMs, true);
    }
    return tokenError("unsupported_grant_type", "supported: authorization_code, refresh_token");
  }

  // ---------------------------------------------------------------- revoke (RFC 7009)
  async function revoke(req: Request): Promise<Response> {
    const text = await readBody(req);
    const t = text === null ? "" : new URLSearchParams(text).get("token") || "";
    if (t && t.length <= 200) {
      // Revoking any token of a login ends that whole login. (Deleting just this one would also erase the spent-token
      // record that reuse detection relies on.)
      const taken = await deps.store.takeRefresh(sha256hex(t));
      if (taken) await deps.store.revokeFamily(taken.rec.familyId, taken.rec.familyEndMs);
    }
    return json(200, {}); // always 200: never reveal whether a token existed
  }

  // ---------------------------------------------------------------- resource-server side
  /** Verifies an access token presented to /api/mcp. Null for any problem. */
  function verifyAccessToken(tokenValue: string): AccessIdentity | null {
    const c = verifyJwt(cfg.secret, "access", tokenValue, { nowSec: nowSec() });
    if (!c || c.iss !== cfg.publicUrl || c.aud !== cfg.resource || typeof c.email !== "string") return null;
    // Re-checked on every request so removing someone from the allow-list takes effect at once.
    if (!emailAllowed(cfg, c.email)) return null;
    return { email: c.email.toLowerCase(), scope: typeof c.scope === "string" ? c.scope : SCOPE };
  }

  return { register, authorize, googleCallback, consent, token, revoke, protectedResourceMetadata, authorizationServerMetadata, preflight, verifyAccessToken, resourceMetadataUrl: url.resourceMetadata };
}

export type OAuthFlow = ReturnType<typeof createOAuthFlow>;
