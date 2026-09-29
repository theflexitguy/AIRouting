// Google sign-in: the ONLY place that decides who may use the MCP.
//
// The access decision is a pure function (checkAccess) so it can be tested exhaustively. It
// requires ALL of:
//   1. email_verified is true
//   2. the `hd` (hosted domain) claim equals the allowed domain
//   3. the email address ends with @<allowed domain>
//   4. if MCP_ALLOWED_EMAILS is set, the email is on it
//
// (2) is the one that matters and the one easy to forget. Anyone can create a Google account
// with a non-Gmail address, and if they can receive mail at that address Google reports
// email_verified=true. Only accounts actually managed by the Workspace carry `hd`. Checking the
// email suffix alone would let a look-alike account through; checking `hd` alone would trust a
// claim we can also cheaply confirm. Both are checked.
//
// The `hd` authorization parameter sent to Google is a UI hint only; it is never relied on.

import type { OAuthConfig } from "./config.ts";

export interface GoogleIdentity {
  email: string;
  emailVerified: boolean;
  hostedDomain?: string;
  nonce?: string;
  subject: string;
}

export interface GoogleClient {
  authorizationUrl(p: { redirectUri: string; state: string; nonce: string }): string;
  /** Exchanges the code and returns the VERIFIED identity, or throws. */
  exchangeCode(p: { code: string; redirectUri: string }): Promise<GoogleIdentity>;
}

export type AccessDecision = { ok: true; email: string } | { ok: false; reason: string };

const normEmail = (e: unknown) => (typeof e === "string" ? e.trim().toLowerCase() : "");

/** Domain + allow-list check, reused every time a token is presented so a change takes effect at once. */
export function emailAllowed(cfg: Pick<OAuthConfig, "allowedDomain" | "allowedEmails">, email: unknown): boolean {
  const e = normEmail(email);
  // Exactly one "@", something on both sides, and no whitespace or control characters anywhere: this
  // is the trust boundary, so it must not rely on Google only ever sending well-formed addresses.
  if (!/^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+$/.test(e)) return false;
  if (e.slice(e.lastIndexOf("@") + 1) !== cfg.allowedDomain) return false;
  return cfg.allowedEmails.length === 0 || cfg.allowedEmails.includes(e);
}

export function checkAccess(
  cfg: Pick<OAuthConfig, "allowedDomain" | "allowedEmails">,
  id: Pick<GoogleIdentity, "email" | "emailVerified" | "hostedDomain">,
): AccessDecision {
  const email = normEmail(id.email);
  if (id.emailVerified !== true) return { ok: false, reason: "email not verified" };
  if (normEmail(id.hostedDomain) !== cfg.allowedDomain) {
    return { ok: false, reason: `not a ${cfg.allowedDomain} Workspace account (hd=${id.hostedDomain ? "other" : "absent"})` };
  }
  if (!emailAllowed(cfg, email)) {
    return { ok: false, reason: cfg.allowedEmails.length ? "not on the allowed list" : "email outside the allowed domain" };
  }
  return { ok: true, email };
}

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleDeps {
  fetch?: typeof fetch;
  /** Verifies an id_token's signature, issuer, audience and expiry; returns its claims. */
  verifyIdToken?: (idToken: string, audience: string) => Promise<Record<string, unknown>>;
}

async function defaultVerify(idToken: string, audience: string): Promise<Record<string, unknown>> {
  const { OAuth2Client } = await import("google-auth-library");
  const ticket = await new OAuth2Client(audience).verifyIdToken({ idToken, audience });
  const payload = ticket.getPayload();
  if (!payload) throw new Error("empty id_token payload");
  return payload as unknown as Record<string, unknown>;
}

export function createGoogleClient(cfg: OAuthConfig, deps: GoogleDeps = {}): GoogleClient {
  const doFetch = deps.fetch ?? fetch;
  const verify = deps.verifyIdToken ?? defaultVerify;
  return {
    authorizationUrl({ redirectUri, state, nonce }) {
      const u = new URL(AUTH_URL);
      u.searchParams.set("client_id", cfg.googleClientId);
      u.searchParams.set("redirect_uri", redirectUri);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", "openid email");
      u.searchParams.set("state", state);
      u.searchParams.set("nonce", nonce);
      u.searchParams.set("prompt", "select_account");
      u.searchParams.set("hd", cfg.allowedDomain); // a hint to the account chooser ONLY — enforced by checkAccess
      return u.toString();
    },
    async exchangeCode({ code, redirectUri }) {
      const res = await doFetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: cfg.googleClientId,
          client_secret: cfg.googleClientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Google token endpoint returned ${res.status}`);
      const body = (await res.json()) as { id_token?: unknown };
      if (typeof body.id_token !== "string") throw new Error("Google returned no id_token");
      const c = await verify(body.id_token, cfg.googleClientId);
      return {
        email: typeof c.email === "string" ? c.email : "",
        emailVerified: c.email_verified === true,
        hostedDomain: typeof c.hd === "string" ? c.hd : undefined,
        nonce: typeof c.nonce === "string" ? c.nonce : undefined,
        subject: typeof c.sub === "string" ? c.sub : "",
      };
    },
  };
}
