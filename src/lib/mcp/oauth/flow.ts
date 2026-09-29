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
import { signJwt, verifyJwt } from "./jwt.ts";
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
  const text = await req.text();
  return text.length > MAX_BODY ? null : text;
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
  const COOKIE = secure ? "__Host-routiq_mcp_bind" : "routiq_mcp_bind";
  const setCookie = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const readCookie = (req: Request): string => {
    for (const part of (req.headers.get("cookie") || "").split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE) return v.join("=");
    }
    return "";
  };
  const boundTo = (req: Request, bd: unknown) => typeof bd === "string" && !!readCookie(req) && same(sha256hex(readCookie(req)), bd);

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
    const nonce = secret();
    const state = signJwt(cfg.secret, "state", {
      cid: client.clientId, ru: redirectUri, cc: challenge, cs: clientState, sc: SCOPE, rs: cfg.resource, nc: nonce, bd: sha256hex(binding),
    }, { nowSec: nowSec(), ttlSec: 600 });
    return new Response(null, {
      status: 302,
      headers: {
        location: deps.google.authorizationUrl({ redirectUri: url.callback, state, nonce }),
        "set-cookie": setCookie(binding, 600),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  // ---------------------------------------------------------------- Google callback
  async function googleCallback(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams;
    const clear = { "set-cookie": setCookie("", 0) };
    const st = verifyJwt(cfg.secret, "state", q.get("state") || "", { nowSec: nowSec() });
    if (!st) return errorPage(400, "Sign-in expired", "Return to your application and start connecting again.", clear);
    if (!boundTo(req, st.bd)) {
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
      cid: st.cid, ru, cc: st.cc, cs: st.cs, sc: st.sc, rs: st.rs, em: decision.email, bd: st.bd,
    }, { nowSec: nowSec(), ttlSec: 300 });
    return consentPage({ email: decision.email, clientName: client.name, redirectUri: ru, token, action: url.consent });
  }

  // ---------------------------------------------------------------- consent decision
  async function consent(req: Request): Promise<Response> {
    const clear = { "set-cookie": setCookie("", 0) };
    const origin = req.headers.get("origin");
    if (origin && origin !== cfg.publicUrl) return errorPage(403, "Request blocked", "This request did not come from the consent page.", clear);
    const text = await readBody(req);
    if (text === null) return errorPage(413, "Request too large", "Start again.", clear);
    const form = new URLSearchParams(text);
    const c = verifyJwt(cfg.secret, "consent", form.get("token") || "", { nowSec: nowSec() });
    if (!c) return errorPage(400, "This page has expired", "Return to your application and start connecting again.", clear);
    if (!boundTo(req, c.bd)) return errorPage(400, "Sign-in must finish in the same browser", "Start connecting again from your application.", clear);
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

  async function issue(clientId: string, email: string, scope: string, resource: string, familyStartMs: number): Promise<Response> {
    const now = nowMs();
    const access = signJwt(cfg.secret, "access", {
      iss: cfg.publicUrl, aud: cfg.resource, sub: email, email, scope, azp: sha256hex(clientId).slice(0, 16), jti: rand(12).toString("base64url"),
    }, { nowSec: Math.floor(now / 1000), ttlSec: cfg.accessTtlSec });
    const refresh = secret();
    await deps.store.putRefresh(sha256hex(refresh), {
      clientId, email, scope, resource, familyStartMs,
      expiresAtMs: Math.min(now + cfg.refreshTtlSec * 1000, familyStartMs + cfg.refreshMaxAgeSec * 1000),
    });
    return json(200, { access_token: access, token_type: "Bearer", expires_in: cfg.accessTtlSec, refresh_token: refresh, scope });
  }

  async function token(req: Request): Promise<Response> {
    const text = await readBody(req);
    if (text === null) return tokenError("invalid_request", "request too large");
    const p = new URLSearchParams(text);
    const client = resolveClient(cfg, p.get("client_id"), nowSec());
    if (!client) return tokenError("invalid_client", "unknown client", 401);
    const grant = p.get("grant_type");

    if (grant === "authorization_code") {
      const code = p.get("code") || "";
      if (!code || code.length > 200) return tokenError("invalid_request", "code is required");
      // Consume FIRST: a code is single-use even if this attempt fails, so a stolen code cannot be retried.
      const rec = await deps.store.takeCode(sha256hex(code));
      if (!rec || rec.expiresAtMs <= nowMs()) return tokenError("invalid_grant", "the authorization code is invalid or expired");
      if (rec.clientId !== client.clientId) return tokenError("invalid_grant", "the code was issued to a different client");
      const ru = p.get("redirect_uri");
      if (ru !== null && ru !== rec.redirectUri) return tokenError("invalid_grant", "redirect_uri does not match the authorization request");
      if (!verifyS256(p.get("code_verifier"), rec.codeChallenge)) return tokenError("invalid_grant", "PKCE verification failed");
      if (!emailAllowed(cfg, rec.email)) return tokenError("invalid_grant", "this account is no longer allowed");
      console.log(`[mcp-oauth] token issued user=${rec.email}`);
      return issue(client.clientId, rec.email, rec.scope, rec.resource, nowMs());
    }

    if (grant === "refresh_token") {
      const rt = p.get("refresh_token") || "";
      if (!rt || rt.length > 200) return tokenError("invalid_request", "refresh_token is required");
      const scope = p.get("scope");
      if (scope && scope.split(/\s+/).some((s) => s && s !== SCOPE)) return tokenError("invalid_scope", `the only supported scope is ${SCOPE}`);
      const rec = await deps.store.takeRefresh(sha256hex(rt)); // rotation: the old token dies here
      if (!rec) return tokenError("invalid_grant", "the refresh token is invalid, expired or already used");
      if (rec.clientId !== client.clientId) return tokenError("invalid_grant", "the refresh token was issued to a different client");
      const now = nowMs();
      if (rec.expiresAtMs <= now || now >= rec.familyStartMs + cfg.refreshMaxAgeSec * 1000) return tokenError("invalid_grant", "the refresh token has expired; sign in again");
      if (!emailAllowed(cfg, rec.email)) return tokenError("invalid_grant", "this account is no longer allowed");
      return issue(client.clientId, rec.email, rec.scope, rec.resource, rec.familyStartMs);
    }
    return tokenError("unsupported_grant_type", "supported: authorization_code, refresh_token");
  }

  // ---------------------------------------------------------------- revoke (RFC 7009)
  async function revoke(req: Request): Promise<Response> {
    const text = await readBody(req);
    const t = text === null ? "" : new URLSearchParams(text).get("token") || "";
    if (t && t.length <= 200) await deps.store.deleteRefresh(sha256hex(t));
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
