import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCOPE, readOAuthConfig } from "./config.ts";
import { RegistrationError, cleanName, registerClient, resolveClient } from "./clients.ts";
import { checkAccess, createGoogleClient, emailAllowed } from "./google.ts";
import { signJwt } from "./jwt.ts";
import { challengeFor, isValidChallenge, isValidVerifier, verifyS256 } from "./pkce.ts";
import { redirectMatches, validateRedirectUri } from "./redirect.ts";

const ENV = {
  MCP_PUBLIC_URL: "https://myroutiq.vercel.app",
  MCP_GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com",
  MCP_GOOGLE_CLIENT_SECRET: "gsecret",
  MCP_OAUTH_SECRET: "x".repeat(40),
};
const cfg = readOAuthConfig(ENV).config!;

describe("readOAuthConfig", () => {
  it("is disabled, not half-enabled, when anything required is missing", () => {
    const none = readOAuthConfig({});
    assert.equal(none.config, null);
    assert.equal(none.attempted, false);
    for (const key of Object.keys(ENV)) {
      const partial = readOAuthConfig({ ...ENV, [key]: "" });
      assert.equal(partial.config, null, key);
      assert.equal(partial.attempted, true);
      assert.ok(partial.missing.some((m) => m.startsWith(key)), key);
    }
  });

  it("requires a strong secret and an https public URL (loopback http allowed for dev)", () => {
    assert.equal(readOAuthConfig({ ...ENV, MCP_OAUTH_SECRET: "short" }).config, null);
    assert.equal(readOAuthConfig({ ...ENV, MCP_PUBLIC_URL: "http://myroutiq.vercel.app" }).config, null);
    assert.equal(readOAuthConfig({ ...ENV, MCP_PUBLIC_URL: "not a url" }).config, null);
    assert.ok(readOAuthConfig({ ...ENV, MCP_PUBLIC_URL: "http://localhost:3000" }).config);
  });

  it("derives the origin and resource, dropping any path and trailing slash", () => {
    const c = readOAuthConfig({ ...ENV, MCP_PUBLIC_URL: "https://myroutiq.vercel.app/some/path/" }).config!;
    assert.equal(c.publicUrl, "https://myroutiq.vercel.app");
    assert.equal(c.resource, "https://myroutiq.vercel.app/api/mcp");
  });

  it("defaults the domain to flexpestcontrol.com, normalises it, and parses the allow-list", () => {
    assert.equal(cfg.allowedDomain, "flexpestcontrol.com");
    assert.deepEqual(cfg.allowedEmails, []);
    const c = readOAuthConfig({ ...ENV, MCP_ALLOWED_DOMAIN: "@Example.COM", MCP_ALLOWED_EMAILS: " A@example.com, ,b@Example.com " }).config!;
    assert.equal(c.allowedDomain, "example.com");
    assert.deepEqual(c.allowedEmails, ["a@example.com", "b@example.com"]);
  });
});

describe("PKCE", () => {
  // RFC 7636 Appendix B test vector.
  const V = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const C = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  it("matches the RFC 7636 vector", () => {
    assert.equal(challengeFor(V), C);
    assert.equal(verifyS256(V, C), true);
  });
  it("rejects a wrong or malformed verifier", () => {
    assert.equal(verifyS256(`${V}x`, C), false);
    assert.equal(verifyS256("A".repeat(43), C), false);
    assert.equal(verifyS256("short", C), false);
    assert.equal(verifyS256("A".repeat(129), challengeFor("A".repeat(129))), false);
    assert.equal(verifyS256(undefined, C), false);
    assert.equal(verifyS256(V, "plain-challenge"), false);
  });
  it("validates challenge and verifier shape", () => {
    assert.equal(isValidChallenge(C), true);
    assert.equal(isValidChallenge(V + "x"), false);
    assert.equal(isValidChallenge(""), false);
    assert.equal(isValidVerifier("a".repeat(43)), true);
    assert.equal(isValidVerifier("a b".repeat(20)), false);
  });
  it("does not accept a `plain` challenge (verifier == challenge) as valid", () => {
    assert.equal(verifyS256(V, V), false);
  });
});

describe("redirect URI policy", () => {
  it("accepts https, loopback http and private-use schemes", () => {
    for (const ok of ["https://claude.ai/api/mcp/auth_callback", "https://example.com/cb?x=1", "http://localhost:6274/oauth/callback", "http://127.0.0.1:33418/cb", "http://[::1]:5000/cb", "cursor://anysphere.cursor-retrieval/oauth/routiq/callback", "vscode://vscode.github-authentication/did-authenticate"]) {
      assert.equal(validateRedirectUri(ok), null, ok);
    }
  });
  it("rejects everything dangerous or malformed", () => {
    for (const bad of [
      "", "   ", "not a uri", "http://evil.com/cb", "http://localhost.evil.com/cb", "javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "ftp://x.com/cb",
      "https://a.com/cb#frag", "https://user:pass@a.com/cb", "https://a.com/cb\nSet-Cookie:x=1", `https://a.com/${"x".repeat(600)}`, "vbscript:x", "blob:https://a.com/1", "1abc://x", "https://",
    ]) {
      assert.notEqual(validateRedirectUri(bad), null, JSON.stringify(bad).slice(0, 40));
    }
    assert.notEqual(validateRedirectUri(undefined), null);
    assert.notEqual(validateRedirectUri(42), null);
  });
  it("matches exactly — no prefix, subdomain, path or scheme tricks", () => {
    const reg = ["https://claude.ai/api/mcp/auth_callback"];
    assert.equal(redirectMatches(reg, "https://claude.ai/api/mcp/auth_callback"), true);
    for (const bad of ["https://claude.ai/api/mcp/auth_callback/", "https://claude.ai/api/mcp/auth_callback?x=1", "https://claude.ai.evil.com/api/mcp/auth_callback", "https://evil.com/api/mcp/auth_callback", "http://claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callbac", "https://CLAUDE.ai/api/mcp/auth_callback/x"]) {
      assert.equal(redirectMatches(reg, bad), false, bad);
    }
  });
  it("lets a loopback client vary only its PORT (RFC 8252 §7.3)", () => {
    const reg = ["http://localhost:6274/oauth/callback"];
    assert.equal(redirectMatches(reg, "http://localhost:51234/oauth/callback"), true);
    assert.equal(redirectMatches(reg, "http://localhost:51234/other"), false);
    assert.equal(redirectMatches(reg, "http://127.0.0.1:6274/oauth/callback"), false, "different loopback host");
    assert.equal(redirectMatches(reg, "https://localhost:6274/oauth/callback"), false);
    assert.equal(redirectMatches(["https://a.com/cb"], "https://a.com:444/cb"), false, "non-loopback ports never vary");
  });
});

describe("stateless client registration", () => {
  const NOW = 1_800_000_000;
  const body = { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" };

  it("returns a working client_id without storing anything", () => {
    const { clientId, response } = registerClient(cfg, body, NOW);
    assert.equal(response.token_endpoint_auth_method, "none");
    assert.equal(response.scope, SCOPE);
    assert.deepEqual(resolveClient(cfg, clientId, NOW + 5), { clientId, name: "Claude", redirectUris: body.redirect_uris, grants: ["authorization_code", "refresh_token"] });
  });

  it("rejects bad redirect URIs, counts and metadata with the right error code", () => {
    const err = (b: unknown) => { try { registerClient(cfg, b, NOW); } catch (e) { return e as RegistrationError; } return null; };
    assert.equal(err({})?.code, "invalid_redirect_uri");
    assert.equal(err({ redirect_uris: [] })?.code, "invalid_redirect_uri");
    assert.equal(err({ redirect_uris: "https://a.com/cb" })?.code, "invalid_redirect_uri");
    assert.equal(err({ redirect_uris: Array(6).fill("https://a.com/cb") })?.code, "invalid_redirect_uri");
    assert.equal(err({ redirect_uris: ["http://evil.com/cb"] })?.code, "invalid_redirect_uri");
    assert.equal(err({ redirect_uris: ["javascript:alert(1)"] })?.code, "invalid_redirect_uri");
    assert.equal(err({ ...body, token_endpoint_auth_method: "client_secret_basic" })?.code, "invalid_client_metadata");
    assert.equal(err({ ...body, grant_types: ["password"] })?.code, "invalid_client_metadata");
    assert.equal(err({ ...body, grant_types: [] })?.code, "invalid_client_metadata");
    assert.equal(err({ ...body, grant_types: ["refresh_token"] })?.code, "invalid_client_metadata");
    // Five 512-char URIs of 3-byte characters pass the per-field limits but would sign to a client_id verifyJwt rejects.
    const fat = Array.from({ length: 5 }, (_, i) => `https://a.com/${i}${"€".repeat(490)}`);
    assert.equal(err({ redirect_uris: fat })?.code, "invalid_client_metadata", "an unusable registration must not be issued");
    assert.equal(err({ ...body, response_types: ["token"] })?.code, "invalid_client_metadata");
    assert.equal(err(null)?.code, "invalid_redirect_uri");
    assert.equal(err(body), null);
  });

  it("makes a client's redirect URIs tamper-proof", () => {
    const { clientId } = registerClient(cfg, body, NOW);
    const [h, , s] = clientId.split(".");
    const forged = Buffer.from(JSON.stringify({ name: "Claude", uris: ["https://evil.com/cb"], use: "client", iat: NOW })).toString("base64url");
    assert.equal(resolveClient(cfg, `${h}.${forged}.${s}`, NOW), null);
  });

  it("rejects client ids that are signed but carry unacceptable redirect URIs (belt and braces)", () => {
    const bad = signJwt(cfg.secret, "client", { name: "x", uris: ["http://evil.com/cb"] }, { nowSec: NOW });
    assert.equal(resolveClient(cfg, bad, NOW), null);
    assert.equal(resolveClient(cfg, signJwt(cfg.secret, "client", { name: "x", uris: [] }, { nowSec: NOW }), NOW), null);
  });

  it("does not accept tokens from another purpose or another secret as a client id", () => {
    assert.equal(resolveClient(cfg, signJwt(cfg.secret, "state", { uris: ["https://a.com/cb"] }, { nowSec: NOW }), NOW), null);
    assert.equal(resolveClient(cfg, signJwt("z".repeat(40), "client", { uris: ["https://a.com/cb"] }, { nowSec: NOW }), NOW), null);
    assert.equal(resolveClient(cfg, undefined, NOW), null);
    assert.equal(resolveClient(cfg, "garbage", NOW), null);
  });

  it("cleans hostile display names", () => {
    assert.equal(cleanName("  Claude \n Desktop\u0000\u202e "), "Claude Desktop");
    assert.equal(cleanName(""), "Unnamed application");
    assert.equal(cleanName("Trusted\u202eevil\u202c App\u200b\ufeff"), "Trustedevil App", "bidi overrides and zero-width characters are removed");
    assert.equal(cleanName(42), "Unnamed application");
    assert.equal(cleanName("x".repeat(500)).length, 100);
    assert.ok(!/[\u0000-\u001f]/.test(cleanName("a\r\nb\tc")));
  });
});

describe("who may sign in — checkAccess", () => {
  const good = { email: "Kalin@FlexPestControl.com", emailVerified: true, hostedDomain: "flexpestcontrol.com" };
  it("admits a verified Workspace member of the domain, normalising case", () => {
    assert.deepEqual(checkAccess(cfg, good), { ok: true, email: "kalin@flexpestcontrol.com" });
  });
  it("REFUSES a look-alike account: verified flexpestcontrol.com email but no Workspace `hd`", () => {
    // Anyone who can receive mail at an address can make a consumer Google account with it; Google
    // then reports email_verified=true but omits `hd`. The suffix alone must never be enough.
    const r = checkAccess(cfg, { ...good, hostedDomain: undefined });
    assert.equal(r.ok, false);
  });
  it("refuses an unverified email", () => {
    assert.equal(checkAccess(cfg, { ...good, emailVerified: false }).ok, false);
    assert.equal(checkAccess(cfg, { ...good, emailVerified: "true" as never }).ok, false);
  });
  it("refuses another Workspace domain, and a mismatched hd/email pair", () => {
    assert.equal(checkAccess(cfg, { ...good, email: "kalin@other.com", hostedDomain: "other.com" }).ok, false);
    assert.equal(checkAccess(cfg, { ...good, hostedDomain: "other.com" }).ok, false);
    assert.equal(checkAccess(cfg, { ...good, email: "kalin@other.com" }).ok, false);
  });
  it("refuses domain tricks in the email", () => {
    for (const email of ["a@flexpestcontrol.com.evil.com", "a@evilflexpestcontrol.com", "a@sub.flexpestcontrol.com", "a@flexpestcontrol.com@evil.com", "flexpestcontrol.com", "@flexpestcontrol.com", "", "a b@flexpestcontrol.com"]) {
      assert.equal(checkAccess(cfg, { email, emailVerified: true, hostedDomain: "flexpestcontrol.com" }).ok, false, email);
    }
  });
  it("applies the optional allow-list on top of the domain", () => {
    const strict = { ...cfg, allowedEmails: ["kalin@flexpestcontrol.com"] };
    assert.equal(checkAccess(strict, good).ok, true);
    assert.equal(checkAccess(strict, { ...good, email: "hayden@flexpestcontrol.com" }).ok, false);
    assert.equal(emailAllowed(strict, "HAYDEN@flexpestcontrol.com"), false);
    assert.equal(emailAllowed(strict, "Kalin@FLEXPESTCONTROL.com"), true);
  });
  it("gives a reason that names no secrets", () => {
    const r = checkAccess(cfg, { ...good, hostedDomain: undefined });
    assert.ok(!r.ok && !r.reason.includes("kalin"));
  });
});

describe("createGoogleClient", () => {
  const redirectUri = "https://myroutiq.vercel.app/api/oauth/google/callback";
  it("builds an authorization URL with a domain HINT, nonce and state", () => {
    const u = new URL(createGoogleClient(cfg).authorizationUrl({ redirectUri, state: "STATE", nonce: "NONCE" }));
    assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    const q = u.searchParams;
    assert.deepEqual(
      [q.get("client_id"), q.get("redirect_uri"), q.get("response_type"), q.get("scope"), q.get("state"), q.get("nonce"), q.get("hd"), q.get("prompt")],
      [cfg.googleClientId, redirectUri, "code", "openid email", "STATE", "NONCE", "flexpestcontrol.com", "select_account"],
    );
  });

  it("exchanges the code with the client secret and returns the VERIFIED identity", async () => {
    let sent: URLSearchParams | undefined;
    let audience = "";
    const client = createGoogleClient(cfg, {
      fetch: (async (_url: string, init: RequestInit) => { sent = init.body as URLSearchParams; return new Response(JSON.stringify({ id_token: "IDT" }), { status: 200 }); }) as never,
      verifyIdToken: async (t, aud) => { audience = aud; assert.equal(t, "IDT"); return { email: "a@flexpestcontrol.com", email_verified: true, hd: "flexpestcontrol.com", nonce: "N", sub: "123" }; },
    });
    const id = await client.exchangeCode({ code: "CODE", redirectUri });
    assert.deepEqual(id, { email: "a@flexpestcontrol.com", emailVerified: true, hostedDomain: "flexpestcontrol.com", nonce: "N", subject: "123" });
    assert.equal(audience, cfg.googleClientId, "the id_token audience must be OUR client id");
    assert.deepEqual([sent!.get("code"), sent!.get("client_id"), sent!.get("client_secret"), sent!.get("redirect_uri"), sent!.get("grant_type")], ["CODE", cfg.googleClientId, cfg.googleClientSecret, redirectUri, "authorization_code"]);
  });

  it("fails closed when Google errors, returns no id_token, or the token does not verify", async () => {
    const mk = (res: () => Response, verify?: () => Promise<Record<string, unknown>>) =>
      createGoogleClient(cfg, { fetch: (async () => res()) as never, verifyIdToken: verify ?? (async () => ({})) });
    await assert.rejects(mk(() => new Response("{}", { status: 400 })).exchangeCode({ code: "c", redirectUri }), /400/);
    await assert.rejects(mk(() => new Response("{}", { status: 200 })).exchangeCode({ code: "c", redirectUri }), /no id_token/);
    await assert.rejects(mk(() => new Response(JSON.stringify({ id_token: "x" }), { status: 200 }), async () => { throw new Error("bad signature"); }).exchangeCode({ code: "c", redirectUri }), /bad signature/);
  });

  it("does not treat a missing or non-boolean email_verified as verified", async () => {
    const client = createGoogleClient(cfg, {
      fetch: (async () => new Response(JSON.stringify({ id_token: "x" }), { status: 200 })) as never,
      verifyIdToken: async () => ({ email: "a@flexpestcontrol.com", email_verified: "true", hd: "flexpestcontrol.com" }),
    });
    assert.equal((await client.exchangeCode({ code: "c", redirectUri })).emailVerified, false);
  });
});
