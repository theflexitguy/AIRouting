import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authorize, extractToken } from "./auth.ts";
import { MIN_KEY_LENGTH, readMcpConfig } from "./config.ts";
import { signJwt } from "./oauth/jwt.ts";

const KEY = "k".repeat(40);
const OTHER = "z".repeat(40);
const h = (init: Record<string, string>) => new Headers(init);

describe("readMcpConfig", () => {
  it("has no keys (server disabled) when nothing is set", () => {
    const c = readMcpConfig({});
    assert.deepEqual(c.keys, []);
    assert.equal(c.companyId, null);
  });

  it("rejects keys shorter than the minimum and reports them", () => {
    const c = readMcpConfig({ MCP_API_KEY: "short" });
    assert.deepEqual(c.keys, []);
    assert.equal(c.rejectedShortKeys, 1);
    assert.ok(MIN_KEY_LENGTH >= 24);
  });

  it("accepts a primary key plus rotation keys, trimmed and de-duplicated", () => {
    const c = readMcpConfig({ MCP_API_KEY: ` ${KEY} `, MCP_API_KEYS: `${OTHER}, ${KEY} ,tiny` });
    assert.deepEqual(c.keys.sort(), [KEY, OTHER].sort());
    assert.equal(c.rejectedShortKeys, 1);
  });

  it("prefers MCP_COMPANY_ID, then FIELDROUTES_COMPANY_ID", () => {
    assert.equal(readMcpConfig({ MCP_COMPANY_ID: "a", FIELDROUTES_COMPANY_ID: "b" }).companyId, "a");
    assert.equal(readMcpConfig({ FIELDROUTES_COMPANY_ID: "b" }).companyId, "b");
  });

  it("parses the cache TTL and falls back to 60s", () => {
    assert.equal(readMcpConfig({}).cacheTtlMs, 60_000);
    assert.equal(readMcpConfig({ MCP_CACHE_TTL_SECONDS: "5" }).cacheTtlMs, 5_000);
    assert.equal(readMcpConfig({ MCP_CACHE_TTL_SECONDS: "0" }).cacheTtlMs, 0);
    assert.equal(readMcpConfig({ MCP_CACHE_TTL_SECONDS: "nope" }).cacheTtlMs, 60_000);
  });
});

describe("extractToken", () => {
  it("reads a Bearer token, case-insensitively", () => {
    assert.equal(extractToken(h({ authorization: `Bearer ${KEY}` })), KEY);
    assert.equal(extractToken(h({ authorization: `bearer ${KEY}` })), KEY);
  });
  it("falls back to x-api-key", () => {
    assert.equal(extractToken(h({ "x-api-key": KEY })), KEY);
  });
  it("ignores non-bearer schemes and returns empty when absent", () => {
    assert.equal(extractToken(h({ authorization: `Basic ${KEY}` })), "");
    assert.equal(extractToken(h({})), "");
  });
});

describe("authorize", () => {
  it("FAILS CLOSED with 503 when no key is configured, even if a token is presented", () => {
    const r = authorize(h({ authorization: `Bearer ${KEY}` }), []);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 503);
  });

  it("401 when the token is missing", () => {
    const r = authorize(h({}), [KEY]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 401);
  });

  it("401 for a wrong token, including one that is a prefix of the real key", () => {
    for (const bad of ["nope", KEY.slice(0, 39), `${KEY}x`, OTHER]) {
      const r = authorize(h({ authorization: `Bearer ${bad}` }), [KEY]);
      assert.equal(r.ok, false, bad);
      if (!r.ok) assert.equal(r.status, 401);
    }
  });

  it("accepts the right token via Authorization or x-api-key", () => {
    assert.equal(authorize(h({ authorization: `Bearer ${KEY}` }), [KEY]).ok, true);
    assert.equal(authorize(h({ "x-api-key": KEY }), [KEY]).ok, true);
  });

  it("supports key rotation: any configured key works", () => {
    assert.equal(authorize(h({ authorization: `Bearer ${OTHER}` }), [KEY, OTHER]).ok, true);
    assert.equal(authorize(h({ authorization: `Bearer ${KEY}` }), [KEY, OTHER]).ok, true);
  });

  it("identifies the key by a short digest, never by the key itself", () => {
    const r = authorize(h({ authorization: `Bearer ${KEY}` }), [KEY]);
    assert.ok(r.ok);
    if (r.ok) {
      assert.match(r.keyId, /^[0-9a-f]{8}$/);
      assert.ok(!KEY.includes(r.keyId));
    }
  });

  it("never echoes a credential in an error message", () => {
    const r = authorize(h({ authorization: `Bearer ${OTHER}` }), [KEY]);
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.ok(!r.message.includes(OTHER));
      assert.ok(!r.message.includes(KEY));
    }
  });
});

describe("authorize — signed-in users", () => {
  const SECRET = "j".repeat(40);
  const NOW = 1_800_000_000;
  const jwt = signJwt(SECRET, "access", { email: "kalin@flexpestcontrol.com" }, { nowSec: NOW, ttlSec: 60 });
  const verify = (t: string) => (t === jwt ? { email: "kalin@flexpestcontrol.com" } : null);

  it("accepts a valid access token and identifies the person", () => {
    const r = authorize(h({ authorization: `Bearer ${jwt}` }), [], verify);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.principal, "user:kalin@flexpestcontrol.com");
      assert.equal(r.email, "kalin@flexpestcontrol.com");
      assert.equal(r.keyId, undefined);
    }
  });

  it("is enough on its own: no static key is needed, and a missing token is 401 (not 503)", () => {
    const r = authorize(h({}), [], verify);
    assert.ok(!r.ok);
    if (!r.ok) {
      assert.equal(r.status, 401);
      assert.equal(r.invalidToken, undefined, "no token was presented");
    }
  });

  it("refuses a JWT the verifier rejects, flagging it as an invalid token", () => {
    const stale = signJwt(SECRET, "access", { email: "x@flexpestcontrol.com" }, { nowSec: NOW, ttlSec: 60 });
    const r = authorize(h({ authorization: `Bearer ${stale}` }), [], verify);
    assert.ok(!r.ok);
    if (!r.ok) assert.deepEqual([r.status, r.invalidToken], [401, true]);
  });

  it("still accepts the static key alongside sign-in, and reports it as a key", () => {
    const r = authorize(h({ authorization: `Bearer ${KEY}` }), [KEY], verify);
    assert.ok(r.ok);
    if (r.ok) assert.match(r.principal, /^key:[0-9a-f]{8}$/);
  });

  it("does not let a bad JWT fall through to matching as a static key", () => {
    const r = authorize(h({ authorization: "Bearer aaaa.bbbb.cccc" }), [KEY], verify);
    assert.ok(!r.ok);
  });

  it("stays closed (503) only when NEITHER sign-in nor a key is configured", () => {
    const r = authorize(h({ authorization: `Bearer ${jwt}` }), [], null);
    assert.ok(!r.ok);
    if (!r.ok) assert.equal(r.status, 503);
  });

  it("ignores a JWT-shaped token when sign-in is off, treating it as a (wrong) key", () => {
    const r = authorize(h({ authorization: `Bearer ${jwt}` }), [KEY], null);
    assert.ok(!r.ok);
  });
});
