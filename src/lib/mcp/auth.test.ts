import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authorize, extractToken } from "./auth.ts";
import { MIN_KEY_LENGTH, readMcpConfig } from "./config.ts";

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
