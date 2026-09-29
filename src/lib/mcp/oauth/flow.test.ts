import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readOAuthConfig } from "./config.ts";
import { createOAuthFlow } from "./flow.ts";
import type { GoogleClient, GoogleIdentity } from "./google.ts";
import { signJwt } from "./jwt.ts";
import { MemoryOAuthStore } from "./memory-store.ts";
import { challengeFor } from "./pkce.ts";
import { randomBytes } from "node:crypto";

const BASE = "https://myroutiq.vercel.app";
const ENV = { MCP_PUBLIC_URL: BASE, MCP_GOOGLE_CLIENT_ID: "cid", MCP_GOOGLE_CLIENT_SECRET: "gs", MCP_OAUTH_SECRET: "x".repeat(40) };
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const GOOD: GoogleIdentity = { email: "kalin@flexpestcontrol.com", emailVerified: true, hostedDomain: "flexpestcontrol.com", subject: "1" };

/** A Google stand-in that, like the real one, echoes back the nonce it was sent. */
class FakeGoogle implements GoogleClient {
  identity: GoogleIdentity | Error = GOOD;
  nonceOverride: string | undefined;
  lastNonce = "";
  nonceByCode = new Map<string, string>();
  calls: Array<{ code: string; redirectUri: string }> = [];
  authorizationUrl(p: { redirectUri: string; state: string; nonce: string }) {
    this.lastNonce = p.nonce;
    this.nonceByCode.set(p.state, p.nonce);
    return `https://accounts.google.com/auth?state=${encodeURIComponent(p.state)}&nonce=${p.nonce}&redirect_uri=${encodeURIComponent(p.redirectUri)}`;
  }
  async exchangeCode(p: { code: string; redirectUri: string }) {
    this.calls.push(p);
    if (this.identity instanceof Error) throw this.identity;
    return { ...this.identity, nonce: this.nonceOverride ?? this.lastNonce };
  }
}

function setup(over: Record<string, string> = {}) {
  const config = readOAuthConfig({ ...ENV, ...over }).config!;
  const store = new MemoryOAuthStore();
  const google = new FakeGoogle();
  const t = { now: 1_800_000_000_000 };
  const flow = createOAuthFlow({ config, store, google, now: () => t.now });
  return { config, store, google, t, flow };
}
type Ctx = ReturnType<typeof setup>;

const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: challengeFor(verifier) }; };
const form = (o: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o).toString() });
const json = async (r: Response) => JSON.parse(await r.text());
const cookieOf = (r: Response) => (r.headers.get("set-cookie") || "").split(";")[0];

async function registerClient(c: Ctx, redirect = REDIRECT, name = "Claude") {
  const r = await c.flow.register(new Request(`${BASE}/api/oauth/register`, { method: "POST", body: JSON.stringify({ redirect_uris: [redirect], client_name: name }) }));
  assert.equal(r.status, 201);
  return (await json(r)).client_id as string;
}

/** Drives /authorize; returns what a browser would do next. */
async function start(c: Ctx, o: { clientId: string; redirect?: string; state?: string; challenge?: string; extra?: Record<string, string> }) {
  const q = new URLSearchParams({ client_id: o.clientId, redirect_uri: o.redirect ?? REDIRECT, response_type: "code", code_challenge: o.challenge ?? pkce().challenge, code_challenge_method: "S256", state: o.state ?? "client-state", ...o.extra });
  return c.flow.authorize(new Request(`${BASE}/api/oauth/authorize?${q}`));
}
const googleStateOf = (r: Response) => new URL(r.headers.get("location")!).searchParams.get("state")!;

/** authorize → Google → callback. Returns the consent page response. */
async function toConsent(c: Ctx, o: { clientId: string; redirect?: string; challenge?: string; state?: string }) {
  const a = await start(c, o);
  assert.equal(a.status, 302, "authorize should redirect to Google");
  assert.ok(a.headers.get("location")!.startsWith("https://accounts.google.com/"));
  const cookie = cookieOf(a);
  const cb = await c.flow.googleCallback(new Request(`${BASE}/api/oauth/google/callback?code=G-CODE&state=${encodeURIComponent(googleStateOf(a))}`, { headers: { cookie } }));
  return { a, cb, cookie };
}
const consentToken = async (cb: Response) => /name="token" value="([^"]+)"/.exec(await cb.text())![1];
const consentPost = (token: string, decision: string, cookie: string, headers: Record<string, string> = {}) =>
  new Request(`${BASE}/api/oauth/consent`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie, ...headers }, body: new URLSearchParams({ token, decision }).toString() });

/** The whole dance; returns the authorization code and what's needed to redeem it. */
async function fullLogin(c: Ctx, o: { redirect?: string; clientId?: string } = {}) {
  const clientId = o.clientId ?? (await registerClient(c, o.redirect));
  const { verifier, challenge } = pkce();
  const { cb, cookie } = await toConsent(c, { clientId, challenge, redirect: o.redirect });
  assert.equal(cb.status, 200, await cb.clone().text());
  const res = await c.flow.consent(consentPost(await consentToken(cb), "allow", cookie));
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("location")!);
  assert.equal(loc.origin + loc.pathname, o.redirect ?? REDIRECT);
  assert.equal(loc.searchParams.get("state"), "client-state");
  return { clientId, verifier, code: loc.searchParams.get("code")!, redirect: o.redirect ?? REDIRECT };
}
const redeem = (c: Ctx, p: { clientId: string; code: string; verifier: string; redirect?: string }) =>
  c.flow.token(new Request(`${BASE}/api/oauth/token`, form({ grant_type: "authorization_code", client_id: p.clientId, code: p.code, code_verifier: p.verifier, redirect_uri: p.redirect ?? REDIRECT })));

describe("discovery metadata", () => {
  it("advertises exactly what the server does, all bound to the configured public URL", async () => {
    const { flow, config } = setup();
    const as = await json(flow.authorizationServerMetadata());
    assert.equal(as.issuer, BASE);
    assert.equal(as.authorization_endpoint, `${BASE}/api/oauth/authorize`);
    assert.equal(as.token_endpoint, `${BASE}/api/oauth/token`);
    assert.equal(as.registration_endpoint, `${BASE}/api/oauth/register`);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"], "no `plain`");
    assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
    assert.deepEqual(as.grant_types_supported, ["authorization_code", "refresh_token"]);
    const pr = await json(flow.protectedResourceMetadata());
    assert.equal(pr.resource, config.resource);
    assert.deepEqual(pr.authorization_servers, [BASE]);
    assert.equal(flow.resourceMetadataUrl, `${BASE}/.well-known/oauth-protected-resource/api/mcp`);
  });
});

describe("registration endpoint", () => {
  it("registers a client and answers CORS, without touching the store", async () => {
    const c = setup();
    const r = await c.flow.register(new Request(`${BASE}/api/oauth/register`, { method: "POST", body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude" }) }));
    assert.equal(r.status, 201);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(c.store.codes.size + c.store.refresh.size, 0, "registration must be stateless");
  });
  it("returns RFC 7591 errors for bad input, oversize bodies and non-JSON", async () => {
    const c = setup();
    const post = (body: string) => c.flow.register(new Request(`${BASE}/api/oauth/register`, { method: "POST", body }));
    const bad = await post(JSON.stringify({ redirect_uris: ["http://evil.com/cb"] }));
    assert.equal(bad.status, 400);
    assert.equal((await json(bad)).error, "invalid_redirect_uri");
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post("x".repeat(20_000))).status, 413);
  });
});

describe("authorization request validation", () => {
  it("NEVER redirects for an unknown client or an unregistered redirect address", async () => {
    const c = setup();
    const clientId = await registerClient(c);
    const unknown = await start(c, { clientId: "made-up" });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.headers.get("location"), null);
    for (const redirect of ["https://evil.com/cb", `${REDIRECT}/`, "https://claude.ai.evil.com/api/mcp/auth_callback", "http://claude.ai/api/mcp/auth_callback"]) {
      const r = await start(c, { clientId, redirect });
      assert.equal(r.status, 400, redirect);
      assert.equal(r.headers.get("location"), null, `must not redirect to ${redirect}`);
    }
    assert.equal(c.google.calls.length, 0);
  });

  it("reports request problems back to the (now trusted) redirect address, echoing state", async () => {
    const c = setup();
    const clientId = await registerClient(c);
    const err = async (extra: Record<string, string>, drop?: string) => {
      const q = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256", state: "S1", ...extra });
      if (drop) q.delete(drop);
      const r = await c.flow.authorize(new Request(`${BASE}/api/oauth/authorize?${q}`));
      assert.equal(r.status, 302);
      const u = new URL(r.headers.get("location")!);
      assert.equal(u.origin + u.pathname, REDIRECT);
      assert.equal(u.searchParams.get("state"), extra.state ?? "S1", "the client's own state is echoed back to its own redirect");
      return u.searchParams.get("error");
    };
    assert.equal(await err({ response_type: "token" }), "unsupported_response_type");
    assert.equal(await err({}, "code_challenge"), "invalid_request", "PKCE is mandatory");
    assert.equal(await err({ code_challenge: "too-short" }), "invalid_request");
    assert.equal(await err({ code_challenge_method: "plain" }), "invalid_request", "`plain` is refused");
    assert.equal(await err({}, "code_challenge_method"), "invalid_request");
    assert.equal(await err({ scope: "admin" }), "invalid_scope");
    assert.equal(await err({ resource: "https://evil.com/api/mcp" }), "invalid_target");
    assert.equal(await err({ state: "s".repeat(600) }), "invalid_request");
  });

  it("accepts the right resource (with or without a trailing slash) and the one supported scope", async () => {
    const c = setup();
    const clientId = await registerClient(c);
    for (const extra of [{ resource: `${BASE}/api/mcp` }, { resource: `${BASE}/api/mcp/` }, { scope: "mcp:read" }]) {
      assert.equal((await start(c, { clientId, extra })).status, 302);
    }
  });

  it("lets a loopback client use a different port than it registered, but not a different path", async () => {
    const c = setup();
    const clientId = await registerClient(c, "http://localhost:6274/oauth/callback");
    assert.equal((await start(c, { clientId, redirect: "http://localhost:59999/oauth/callback" })).status, 302);
    assert.equal((await start(c, { clientId, redirect: "http://localhost:59999/steal" })).status, 400);
  });

  it("sets a same-browser cookie that is HttpOnly, Secure and SameSite", async () => {
    const c = setup();
    const r = await start(c, { clientId: await registerClient(c) });
    const cookie = r.headers.get("set-cookie")!;
    assert.match(cookie, /^__Host-routiq_mcp_bind_[A-Za-z0-9_-]+=/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) assert.ok(cookie.includes(attr), attr);
  });
});

describe("resource binding", () => {
  const elsewhere = (c: Ctx) => createOAuthFlow({ config: { ...c.config, publicUrl: "https://other.example.com", resource: "https://other.example.com/api/mcp" }, store: c.store, google: c.google, now: () => c.t.now });

  it("refuses a refresh token issued for a different endpoint (MCP_PUBLIC_URL changed)", async () => {
    const c = setup();
    const p = await fullLogin(c);
    const tokens = await json(await redeem(c, p));
    const r = await elsewhere(c).token(new Request(`${BASE}/api/oauth/token`, form({ grant_type: "refresh_token", client_id: p.clientId, refresh_token: tokens.refresh_token })));
    assert.equal((await json(r)).error, "invalid_grant");
  });

  it("refuses an authorization code issued for a different endpoint", async () => {
    const c = setup();
    const p = await fullLogin(c);
    const r = await elsewhere(c).token(new Request(`${BASE}/api/oauth/token`, form({ grant_type: "authorization_code", client_id: p.clientId, code: p.code, code_verifier: p.verifier, redirect_uri: p.redirect })));
    assert.equal((await json(r)).error, "invalid_grant");
  });
});

describe("large but accepted registrations", () => {
  it("a client id at the size cap still completes authorize → callback → consent (the nested tokens stay verifiable)", async () => {
    const c = setup();
    const uri = (i: number, n: number) => `https://claude.ai/${i}/${"a".repeat(n)}`;
    // Grow the redirect URIs until the registration is just under the cap.
    let n = 100, clientId = "", uris: string[] = [];
    for (; n <= 500; n += 20) {
      const u = [0, 1, 2, 3, 4].map((i) => uri(i, n));
      const r = await c.flow.register(new Request(`${BASE}/api/oauth/register`, { method: "POST", body: JSON.stringify({ redirect_uris: u, client_name: "Big" }) }));
      if (r.status !== 201) break;
      clientId = (await json(r)).client_id; uris = u;
    }
    assert.ok(clientId.length > 1800 && clientId.length <= 2400, `client id length ${clientId.length}`);
    const redirect = uris[4];
    const { verifier, challenge } = pkce();
    const bigState = "€".repeat(500);
    const a = await start(c, { clientId, redirect, challenge, state: bigState });
    assert.equal(a.status, 302, "authorize succeeds");
    const cookie = cookieOf(a);
    const cb = await c.flow.googleCallback(new Request(`${BASE}/api/oauth/google/callback?code=G&state=${encodeURIComponent(googleStateOf(a))}`, { headers: { cookie } }));
    assert.equal(cb.status, 200, "the state token verifies after Google");
    const done = await c.flow.consent(consentPost(await consentToken(cb), "allow", cookie));
    assert.equal(done.status, 302);
    const code = new URL(done.headers.get("location")!).searchParams.get("code")!;
    const t = await json(await redeem(c, { clientId, code, verifier, redirect }));
    assert.ok(t.access_token);
  });
});

describe("concurrent sign-ins from one browser", () => {
  it("each attempt has its own binding cookie, so a second sign-in can't break the first", async () => {
    const c = setup();
    const clientId = await registerClient(c);
    const a1 = await start(c, { clientId });
    const a2 = await start(c, { clientId });
    const c1 = cookieOf(a1), c2 = cookieOf(a2);
    assert.notEqual(c1.split("=")[0], c2.split("=")[0], "different cookie names");
    const both = `${c1}; ${c2}`; // the browser now holds both
    for (const a of [a1, a2]) {
      c.google.lastNonce = c.google.nonceByCode.get(googleStateOf(a))!; // the nonce Google would echo for THIS attempt
      const cb = await c.flow.googleCallback(new Request(`${BASE}/api/oauth/google/callback?code=G-CODE&state=${encodeURIComponent(googleStateOf(a))}`, { headers: { cookie: both } }));
      assert.equal(cb.status, 200, await cb.clone().text());
    }
  });

  it("a cookie from one attempt cannot satisfy another attempt's state", async () => {
    const c = setup();
    const clientId = await registerClient(c);
    const a1 = await start(c, { clientId });
    const a2 = await start(c, { clientId });
    const cb = await c.flow.googleCallback(new Request(`${BASE}/api/oauth/google/callback?code=G-CODE&state=${encodeURIComponent(googleStateOf(a1))}`, { headers: { cookie: cookieOf(a2) } }));
    assert.equal(cb.status, 400);
  });
});

describe("browser binding at the consent step", () => {
  it("re-sends the binding cookie (same value) so it outlives the consent token", async () => {
    const c = setup();
    const { cb, cookie } = await toConsent(c, { clientId: await registerClient(c) });
    const set = cb.headers.get("set-cookie")!;
    assert.equal(set.split(";")[0], cookie, "same secret value, so the stored hash still matches");
    assert.match(set, /Max-Age=360/);
    for (const attr of ["HttpOnly", "Secure", "SameSite=Lax"]) assert.ok(set.includes(attr), attr);
  });
});

describe("the full sign-in flow (happy path)", () => {
  it("registers, signs in, consents, redeems the code and calls the API as that person", async () => {
    const c = setup();
    const { clientId, verifier, code } = await fullLogin(c);
    assert.equal(c.google.calls.length, 1);
    assert.equal(c.google.calls[0].redirectUri, `${BASE}/api/oauth/google/callback`, "Google must return to OUR callback");
    assert.equal(c.google.calls[0].code, "G-CODE");
    const res = await redeem(c, { clientId, code, verifier });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const t = await json(res);
    assert.equal(t.token_type, "Bearer");
    assert.equal(t.expires_in, 3600);
    assert.equal(t.scope, "mcp:read");
    assert.deepEqual(c.flow.verifyAccessToken(t.access_token), { email: "kalin@flexpestcontrol.com", scope: "mcp:read" });
    assert.ok(t.refresh_token.length >= 40);
  });

  it("stores only hashes: neither the code nor the refresh token appears in the store", async () => {
    const c = setup();
    const { clientId, verifier, code } = await fullLogin(c);
    const t = await json(await redeem(c, { clientId, code, verifier }));
    const dump = JSON.stringify([...c.store.codes.keys(), ...c.store.refresh.keys()]);
    assert.ok(!dump.includes(code) && !dump.includes(t.refresh_token));
    assert.equal(c.store.refresh.size, 1);
  });

  it("does not put the consent page's token or any secret into a URL the client sees", async () => {
    const c = setup();
    const { cb } = await toConsent(c, { clientId: await registerClient(c) });
    assert.equal(cb.headers.get("location"), null);
  });
});

describe("who is allowed in", () => {
  const denied = async (identity: GoogleIdentity | Error, status: number) => {
    const c = setup();
    c.google.identity = identity;
    const { cb } = await toConsent(c, { clientId: await registerClient(c) });
    assert.equal(cb.status, status);
    const body = await cb.text();
    assert.ok(!body.includes('name="token"'), "no consent form may be offered");
    assert.equal(cb.headers.get("location"), null);
    assert.equal(c.store.codes.size, 0, "no code may ever be issued");
    return { body, c };
  };

  it("turns away a look-alike account (verified @flexpestcontrol.com but not Workspace-managed)", async () => {
    const { body } = await denied({ ...GOOD, hostedDomain: undefined }, 403);
    assert.match(body, /Access denied/);
  });
  it("turns away another Workspace, an unverified email, and a mismatched pair", async () => {
    await denied({ ...GOOD, email: "x@other.com", hostedDomain: "other.com" }, 403);
    await denied({ ...GOOD, emailVerified: false }, 403);
    await denied({ ...GOOD, hostedDomain: "other.com" }, 403);
  });
  it("shows a message that helps a legitimate person, without echoing the rejected address", async () => {
    const { body } = await denied({ ...GOOD, email: "stranger@gmail.com", hostedDomain: undefined }, 403);
    assert.match(body, /flexpestcontrol\.com/);
    assert.ok(!body.includes("stranger"));
  });
  it("turns away everyone but the allow-list when one is set", async () => {
    const c = setup({ MCP_ALLOWED_EMAILS: "hayden@flexpestcontrol.com" });
    const { cb } = await toConsent(c, { clientId: await registerClient(c) });
    assert.equal(cb.status, 403);
  });
  it("fails safely (generic 502, no leaked detail) when Google is unreachable", async () => {
    const { body } = await denied(new Error("connect ECONNREFUSED 10.1.2.3:443 secret-detail"), 502);
    assert.ok(!body.includes("ECONNREFUSED") && !body.includes("secret-detail"));
  });
  it("rejects a Google response whose nonce does not match", async () => {
    const c = setup();
    c.google.nonceOverride = "replayed-nonce";
    const { cb } = await toConsent(c, { clientId: await registerClient(c) });
    assert.equal(cb.status, 400);
    assert.equal(c.store.codes.size, 0);
  });
  it("passes a user's cancellation at Google back to the client as access_denied", async () => {
    const c = setup();
    const clientId = await registerClient(c);
    const a = await start(c, { clientId, state: "S9" });
    const cb = await c.flow.googleCallback(new Request(`${BASE}/api/oauth/google/callback?error=access_denied&state=${encodeURIComponent(googleStateOf(a))}`, { headers: { cookie: cookieOf(a) } }));
    const u = new URL(cb.headers.get("location")!);
    assert.deepEqual([u.origin + u.pathname, u.searchParams.get("error"), u.searchParams.get("state")], [REDIRECT, "access_denied", "S9"]);
  });
});

describe("the callback cannot be forged, replayed or finished in another browser", () => {
  it("rejects a tampered, expired or foreign state", async () => {
    const c = setup();
    const a = await start(c, { clientId: await registerClient(c) });
    const cookie = cookieOf(a);
    const call = (state: string, ck = cookie) => c.flow.googleCallback(new Request(`${BASE}/api/oauth/google/callback?code=x&state=${encodeURIComponent(state)}`, { headers: { cookie: ck } }));
    const state = googleStateOf(a);
    assert.equal((await call(state.slice(0, -3) + "AAA")).status, 400);
    assert.equal((await call("garbage")).status, 400);
    assert.equal((await call("")).status, 400);
    c.t.now += 11 * 60 * 1000;
    assert.equal((await call(state)).status, 400, "state expires after 10 minutes");
    assert.equal(c.google.calls.length, 0, "Google must never be contacted for a bad state");
  });

  it("rejects a state minted for another purpose", async () => {
    const c = setup();
    const a = await start(c, { clientId: await registerClient(c) });
    const wrong = signJwt(c.config.secret, "access", { email: "a@flexpestcontrol.com" }, { nowSec: c.t.now / 1000, ttlSec: 600 });
    const r = await c.flow.googleCallback(new Request(`${BASE}/api/oauth/google/callback?code=x&state=${wrong}`, { headers: { cookie: cookieOf(a) } }));
    assert.equal(r.status, 400);
  });

  it("refuses to finish a login in a different browser (missing or foreign cookie)", async () => {
    const c = setup();
    const clientId = await registerClient(c);
    const a = await start(c, { clientId });
    const b = await start(c, { clientId }); // someone else's flow, with their own cookie
    const state = encodeURIComponent(googleStateOf(a));
    for (const cookie of ["", cookieOf(b), "__Host-routiq_mcp_bind=forged"]) {
      const r = await c.flow.googleCallback(new Request(`${BASE}/api/oauth/google/callback?code=x&state=${state}`, { headers: { cookie } }));
      assert.equal(r.status, 400, `cookie="${cookie}"`);
    }
    assert.equal(c.google.calls.length, 0);
  });
});

describe("the consent screen", () => {
  it("shows who is signed in, who is asking, and where the user will be sent — and escapes all of it", async () => {
    const c = setup();
    const evil = `<script>alert(1)</script>"><img src=x onerror=alert(2)>`;
    const clientId = await registerClient(c, "https://claude.ai/cb?a=<b>&x=\"'", evil);
    const { cb } = await toConsent(c, { clientId, redirect: "https://claude.ai/cb?a=<b>&x=\"'" });
    assert.equal(cb.status, 200);
    const html = await cb.text();
    assert.match(html, /kalin@flexpestcontrol\.com/);
    assert.ok(!html.includes("<script"), "no raw <script> may reach the page");
    assert.ok(!html.includes("<img"), "no raw markup from the client name");
    assert.ok(!/onerror=alert\(2\)>/.test(html) || html.includes("&lt;img"), "escaped");
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /read.*customer names, addresses and balances/is);
    assert.match(html, /Only continue if you just started/);
  });

  it("cannot be framed, scripted, or cached", async () => {
    const c = setup();
    const { cb } = await toConsent(c, { clientId: await registerClient(c) });
    assert.equal(cb.headers.get("x-frame-options"), "DENY");
    const csp = cb.headers.get("content-security-policy")!;
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!/script-src/.test(csp) && !/unsafe-eval/.test(csp));
    assert.equal(cb.headers.get("cache-control"), "no-store");
    assert.equal(cb.headers.get("x-content-type-options"), "nosniff");
  });

  it("issues a code only on Allow; Cancel returns access_denied and stores nothing", async () => {
    const c = setup();
    const { cb, cookie } = await toConsent(c, { clientId: await registerClient(c) });
    const token = await consentToken(cb);
    const denied = await c.flow.consent(consentPost(token, "deny", cookie));
    const u = new URL(denied.headers.get("location")!);
    assert.deepEqual([u.searchParams.get("error"), u.searchParams.get("state"), u.searchParams.has("code")], ["access_denied", "client-state", false]);
    assert.equal(c.store.codes.size, 0);
    for (const decision of ["", "ALLOW", "yes", "true"]) {
      const r = await c.flow.consent(consentPost(token, decision, cookie));
      assert.equal(new URL(r.headers.get("location")!).searchParams.has("code"), false, `decision=${JSON.stringify(decision)}`);
    }
    assert.equal(c.store.codes.size, 0, "only the exact word `allow` grants");
  });

  it("rejects a forged, expired, foreign-cookie or cross-origin decision", async () => {
    const c = setup();
    const { cb, cookie } = await toConsent(c, { clientId: await registerClient(c) });
    const token = await consentToken(cb);
    const status = async (req: Request) => (await c.flow.consent(req)).status;
    assert.equal(await status(consentPost(token.slice(0, -3) + "AAA", "allow", cookie)), 400);
    assert.equal(await status(consentPost(token, "allow", "")), 400, "no cookie");
    assert.equal(await status(consentPost(token, "allow", "__Host-routiq_mcp_bind=other")), 400, "wrong cookie");
    assert.equal(await status(consentPost(token, "allow", cookie, { origin: "https://evil.com" })), 403, "cross-origin form post");
    const state = signJwt(c.config.secret, "state", {}, { nowSec: c.t.now / 1000, ttlSec: 300 });
    assert.equal(await status(consentPost(state, "allow", cookie)), 400, "a state token is not a consent token");
    c.t.now += 6 * 60 * 1000;
    assert.equal(await status(consentPost(token, "allow", cookie)), 400, "consent expires after 5 minutes");
    assert.equal(c.store.codes.size, 0);
  });

  it("serves the consent page with a referrer policy that lets the browser send its real Origin on Allow", async () => {
    // With `no-referrer` browsers send `Origin: null` on the form POST, which the origin check (rightly) refuses,
    // so a real person clicking Allow would be blocked. `null` must stay refused; the page must avoid producing it.
    const c = setup();
    const { cb, cookie } = await toConsent(c, { clientId: await registerClient(c) });
    assert.equal(cb.headers.get("referrer-policy"), "same-origin");
    const token = await consentToken(cb);
    assert.equal((await c.flow.consent(consentPost(token, "allow", cookie, { origin: "null" }))).status, 403, "Origin: null is still refused");
    assert.equal((await c.flow.consent(consentPost(token, "allow", cookie, { origin: BASE }))).status, 302, "the real Origin is accepted");
  });

  it("accepts a same-origin post and clears the binding cookie afterwards", async () => {
    const c = setup();
    const { cb, cookie } = await toConsent(c, { clientId: await registerClient(c) });
    const r = await c.flow.consent(consentPost(await consentToken(cb), "allow", cookie, { origin: BASE }));
    assert.equal(r.status, 302);
    assert.match(r.headers.get("set-cookie")!, /Max-Age=0/);
  });
});

describe("redeeming the authorization code", () => {
  it("is single-use: a replay fails", async () => {
    const c = setup();
    const p = await fullLogin(c);
    assert.equal((await redeem(c, p)).status, 200);
    const again = await redeem(c, p);
    assert.equal(again.status, 400);
    assert.equal((await json(again)).error, "invalid_grant");
  });

  it("is burned by a failed attempt, so a stolen code cannot be retried with a guessed verifier", async () => {
    const c = setup();
    const p = await fullLogin(c);
    const wrong = await redeem(c, { ...p, verifier: randomBytes(32).toString("base64url") });
    assert.equal((await json(wrong)).error, "invalid_grant");
    assert.equal((await redeem(c, p)).status, 400, "the right verifier is too late");
  });

  it("requires PKCE: a missing, malformed or plain verifier is refused", async () => {
    for (const verifier of ["", "short", "A".repeat(43)]) {
      const c = setup();
      const p = await fullLogin(c);
      assert.equal((await redeem(c, { ...p, verifier })).status, 400, JSON.stringify(verifier));
    }
    const c = setup();
    const p = await fullLogin(c);
    const noVerifier = await c.flow.token(new Request(`${BASE}/api/oauth/token`, form({ grant_type: "authorization_code", client_id: p.clientId, code: p.code, redirect_uri: p.redirect })));
    assert.equal(noVerifier.status, 400);
  });

  it("binds the code to its client and its redirect address", async () => {
    const c = setup();
    const p = await fullLogin(c);
    const other = await registerClient(c, "https://other.example.com/cb", "Other");
    assert.equal((await json(await redeem(c, { ...p, clientId: other }))).error, "invalid_grant");
    const c2 = setup();
    const q = await fullLogin(c2);
    assert.equal((await json(await redeem(c2, { ...q, redirect: "https://claude.ai/somewhere-else" }))).error, "invalid_grant");
  });

  it("expires after 60 seconds", async () => {
    const c = setup();
    const p = await fullLogin(c);
    c.t.now += 61_000;
    assert.equal((await json(await redeem(c, p))).error, "invalid_grant");
  });

  it("rejects unknown clients (401), unsupported grants and missing codes", async () => {
    const c = setup();
    const clientId = await registerClient(c);
    const post = (o: Record<string, string>) => c.flow.token(new Request(`${BASE}/api/oauth/token`, form(o)));
    assert.equal((await post({ grant_type: "authorization_code", client_id: "nope", code: "x" })).status, 401);
    assert.equal((await json(await post({ grant_type: "password", client_id: clientId }))).error, "unsupported_grant_type");
    assert.equal((await json(await post({ grant_type: "client_credentials", client_id: clientId }))).error, "unsupported_grant_type");
    assert.equal((await json(await post({ grant_type: "authorization_code", client_id: clientId }))).error, "invalid_request");
  });

  it("refuses to issue if the person has since been removed from the allow-list", async () => {
    const strict = setup({ MCP_ALLOWED_EMAILS: "kalin@flexpestcontrol.com" });
    const p = await fullLogin(strict);
    const tightened = createOAuthFlow({ config: { ...strict.config, allowedEmails: ["someone-else@flexpestcontrol.com"] }, store: strict.store, google: strict.google, now: () => strict.t.now });
    const r = await tightened.token(new Request(`${BASE}/api/oauth/token`, form({ grant_type: "authorization_code", client_id: p.clientId, code: p.code, code_verifier: p.verifier, redirect_uri: p.redirect })));
    assert.equal((await json(r)).error, "invalid_grant");
  });
});

describe("refresh tokens", () => {
  const login = async (c: Ctx) => {
    const p = await fullLogin(c);
    return { ...p, tokens: await json(await redeem(c, p)) };
  };
  const refresh = (c: Ctx, clientId: string, rt: string, extra: Record<string, string> = {}) =>
    c.flow.token(new Request(`${BASE}/api/oauth/token`, form({ grant_type: "refresh_token", client_id: clientId, refresh_token: rt, ...extra })));

  it("rotates: each use returns a new pair and kills the old refresh token", async () => {
    const c = setup();
    const { clientId, tokens } = await login(c);
    const next = await json(await refresh(c, clientId, tokens.refresh_token));
    assert.ok(next.access_token && next.refresh_token && next.refresh_token !== tokens.refresh_token);
    assert.ok(c.flow.verifyAccessToken(next.access_token));
    assert.equal(c.store.live.length, 1, "exactly one live refresh token remains after rotation");
    const reuse = await refresh(c, clientId, tokens.refresh_token);
    assert.equal((await json(reuse)).error, "invalid_grant", "a used refresh token is dead");
  });

  it("reuse of a spent refresh token revokes the whole session, including the thief's descendant", async () => {
    const c = setup();
    const { clientId, tokens } = await login(c);
    const stolen = tokens.refresh_token;
    const thief = await json(await refresh(c, clientId, stolen)); // attacker redeems the copy first
    assert.ok(thief.refresh_token);
    const owner = await refresh(c, clientId, stolen); // owner presents the now-spent token
    assert.equal((await json(owner)).error, "invalid_grant");
    assert.equal(c.store.live.length, 0, "the attacker's descendant died with the family");
    assert.equal((await json(await refresh(c, clientId, thief.refresh_token))).error, "invalid_grant");
  });

  it("reuse revokes only that login's family, not the same person's other sessions", async () => {
    const c = setup();
    const a = await login(c);
    const b = await login(c);
    await refresh(c, a.clientId, a.tokens.refresh_token);
    await refresh(c, a.clientId, a.tokens.refresh_token); // reuse → family A revoked
    assert.equal((await json(await refresh(c, b.clientId, b.tokens.refresh_token))).error, undefined, "session B still works");
  });

  it("enforces the grant types a client registered with", async () => {
    const c = setup();
    const reg = async (grant_types: string[]) => (await json(await c.flow.register(new Request(`${BASE}/api/oauth/register`, { method: "POST", body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "X", grant_types }) })))).client_id as string;
    const noRefresh = await reg(["authorization_code"]);
    const p = await fullLogin(c, { clientId: noRefresh });
    const t = await json(await redeem(c, p));
    assert.ok(t.access_token);
    assert.equal(t.refresh_token, undefined, "no refresh token for a client that didn't ask for the grant");
    assert.equal(c.store.refresh.size, 0);
    const bad = await json(await refresh(c, noRefresh, "anything"));
    assert.equal(bad.error, "unauthorized_client");
    const bogus = await c.flow.register(new Request(`${BASE}/api/oauth/register`, { method: "POST", body: JSON.stringify({ redirect_uris: [REDIRECT], grant_types: [] }) }));
    assert.equal(bogus.status, 400);
    const refreshOnly = await c.flow.register(new Request(`${BASE}/api/oauth/register`, { method: "POST", body: JSON.stringify({ redirect_uris: [REDIRECT], grant_types: ["refresh_token"] }) }));
    assert.equal(refreshOnly.status, 400, "a client that can't use the code grant can never obtain a token");
  });

  it("rejects an oversized body even when Content-Length is absent (streamed)", async () => {
    const c = setup();
    const big = new Request(`${BASE}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new ReadableStream({ start(ctl) { for (let i = 0; i < 40; i++) ctl.enqueue(new TextEncoder().encode("a".repeat(1024))); ctl.close(); } }),
      duplex: "half",
    } as RequestInit);
    assert.equal(big.headers.get("content-length"), null);
    assert.equal((await json(await c.flow.token(big))).error, "invalid_request");
  });

  it("is bound to its client", async () => {
    const c = setup();
    const { tokens } = await login(c);
    const other = await registerClient(c, "https://other.example.com/cb", "Other");
    assert.equal((await json(await refresh(c, other, tokens.refresh_token))).error, "invalid_grant");
  });

  it("expires after 30 days and can never outlive a 90-day family, however often it is rotated", async () => {
    const c = setup();
    const { clientId, tokens } = await login(c);
    c.t.now += 31 * 86_400_000;
    assert.equal((await json(await refresh(c, clientId, tokens.refresh_token))).error, "invalid_grant");

    const d = setup();
    const cur = await login(d);
    let rt = cur.tokens.refresh_token;
    for (let day = 25; day <= 75; day += 25) { // rotate at day 25, 50, 75: always inside the 30-day window
      d.t.now = 1_800_000_000_000 + day * 86_400_000;
      const r = await refresh(d, cur.clientId, rt);
      assert.equal(r.status, 200, `day ${day}`);
      rt = (await json(r)).refresh_token;
    }
    d.t.now = 1_800_000_000_000 + 95 * 86_400_000; // still inside the LAST token's 30 days, but past the 90-day family cap
    assert.equal((await json(await refresh(d, cur.clientId, rt))).error, "invalid_grant");
  });

  it("re-checks the allow-list, so removing someone stops their refresh", async () => {
    const c = setup();
    const { clientId, tokens } = await login(c);
    const tightened = createOAuthFlow({ config: { ...c.config, allowedEmails: ["other@flexpestcontrol.com"] }, store: c.store, google: c.google, now: () => c.t.now });
    const r = await tightened.token(new Request(`${BASE}/api/oauth/token`, form({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token })));
    assert.equal((await json(r)).error, "invalid_grant");
  });

  it("rejects an unsupported scope, an unknown token, and a missing token", async () => {
    const c = setup();
    const { clientId, tokens } = await login(c);
    assert.equal((await json(await refresh(c, clientId, tokens.refresh_token, { scope: "admin" }))).error, "invalid_scope");
    assert.equal((await json(await refresh(c, clientId, "nope"))).error, "invalid_grant");
    assert.equal((await json(await refresh(c, clientId, ""))).error, "invalid_request");
  });

  it("revoking a SPENT token ends the whole login, so the thief's descendant can't survive it", async () => {
    const c = setup();
    const { clientId, tokens } = await login(c);
    const thief = await json(await refresh(c, clientId, tokens.refresh_token)); // spends the original
    const rev = (token: string) => c.flow.revoke(new Request(`${BASE}/api/oauth/revoke`, form({ token })));
    assert.equal((await rev(tokens.refresh_token)).status, 200); // attacker tries to erase the record
    assert.equal((await json(await refresh(c, clientId, thief.refresh_token))).error, "invalid_grant");
    assert.equal(c.store.live.length, 0);
  });

  it("a spent token is still caught after ITS OWN expiry, until the whole family ends", async () => {
    const c = setup();
    const { clientId, tokens } = await login(c);
    const thief = await json(await refresh(c, clientId, tokens.refresh_token)); // copy redeemed first
    c.t.now += 31 * 86400 * 1000; // the ORIGINAL token's 30-day expiry has passed; the thief's successor's has not
    const owner = await refresh(c, clientId, tokens.refresh_token);
    assert.equal((await json(owner)).error, "invalid_grant");
    assert.equal(c.store.live.length, 0, "the thief's descendant is revoked, not left rotating");
    assert.equal((await json(await refresh(c, clientId, thief.refresh_token))).error, "invalid_grant");
  });

  it("a rotation that finishes after its family was revoked gets no token", async () => {
    const c = setup();
    const { clientId, tokens } = await login(c);
    const orig = c.store.putRefresh.bind(c.store);
    // Simulate the race: while this rotation is between "mark spent" and "store successor", the family is revoked.
    c.store.putRefresh = async (h, rec) => { await c.store.revokeFamily(rec.familyId, rec.familyEndMs); return orig(h, rec); };
    const res = await refresh(c, clientId, tokens.refresh_token);
    assert.equal((await json(res)).error, "invalid_grant");
    assert.equal(c.store.live.length, 0);
  });

  it("can be revoked, and revocation never reveals whether a token existed", async () => {
    const c = setup();
    const { clientId, tokens } = await login(c);
    const rev = (token: string) => c.flow.revoke(new Request(`${BASE}/api/oauth/revoke`, form({ token })));
    assert.equal((await rev("never-existed")).status, 200);
    assert.equal((await rev(tokens.refresh_token)).status, 200);
    assert.equal((await json(await refresh(c, clientId, tokens.refresh_token))).error, "invalid_grant");
    assert.equal((await rev("")).status, 200);
  });
});

describe("access tokens (what /api/mcp checks)", () => {
  const mint = async (c: Ctx) => { const p = await fullLogin(c); return (await json(await redeem(c, p))).access_token as string; };

  it("are accepted while fresh and refused once expired", async () => {
    const c = setup();
    const at = await mint(c);
    assert.ok(c.flow.verifyAccessToken(at));
    c.t.now += 3599_000;
    assert.ok(c.flow.verifyAccessToken(at));
    c.t.now += 2_000;
    assert.equal(c.flow.verifyAccessToken(at), null);
  });

  it("are refused if minted for another audience, issuer or with another secret", async () => {
    const c = setup();
    const nowSec = c.t.now / 1000;
    const claims = { iss: BASE, aud: `${BASE}/api/mcp`, email: "kalin@flexpestcontrol.com", scope: "mcp:read" };
    assert.ok(c.flow.verifyAccessToken(signJwt(c.config.secret, "access", claims, { nowSec, ttlSec: 60 })), "sanity");
    assert.equal(c.flow.verifyAccessToken(signJwt(c.config.secret, "access", { ...claims, aud: "https://evil.com/api/mcp" }, { nowSec, ttlSec: 60 })), null);
    assert.equal(c.flow.verifyAccessToken(signJwt(c.config.secret, "access", { ...claims, iss: "https://evil.com" }, { nowSec, ttlSec: 60 })), null);
    assert.equal(c.flow.verifyAccessToken(signJwt("z".repeat(40), "access", claims, { nowSec, ttlSec: 60 })), null);
    assert.equal(c.flow.verifyAccessToken(signJwt(c.config.secret, "access", { ...claims, email: undefined }, { nowSec, ttlSec: 60 })), null);
  });

  it("are refused when the email is outside the domain, even if correctly signed", async () => {
    const c = setup();
    const t = signJwt(c.config.secret, "access", { iss: BASE, aud: `${BASE}/api/mcp`, email: "x@other.com" }, { nowSec: c.t.now / 1000, ttlSec: 60 });
    assert.equal(c.flow.verifyAccessToken(t), null);
  });

  it("stop working immediately when the allow-list changes", async () => {
    const c = setup();
    const at = await mint(c);
    const tightened = createOAuthFlow({ config: { ...c.config, allowedEmails: ["other@flexpestcontrol.com"] }, store: c.store, google: c.google, now: () => c.t.now });
    assert.ok(c.flow.verifyAccessToken(at));
    assert.equal(tightened.verifyAccessToken(at), null);
  });

  it("can't be forged from any other token this server issues", async () => {
    const c = setup();
    const { clientId } = { clientId: await registerClient(c) };
    assert.equal(c.flow.verifyAccessToken(clientId), null, "a client_id is not an access token");
    const a = await start(c, { clientId });
    assert.equal(c.flow.verifyAccessToken(googleStateOf(a)), null, "a state token is not an access token");
    assert.equal(c.flow.verifyAccessToken("garbage"), null);
  });
});
