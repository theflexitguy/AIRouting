import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHmac } from "node:crypto";
import { looksLikeJwt, signJwt, verifyJwt } from "./jwt.ts";

const SECRET = "s".repeat(40);
const OTHER = "o".repeat(40);
const NOW = 1_800_000_000;
const b64u = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

describe("signJwt / verifyJwt", () => {
  it("round-trips claims, stamping the purpose and issue time", () => {
    const t = signJwt(SECRET, "access", { sub: "a@b.com" }, { nowSec: NOW, ttlSec: 60 });
    assert.deepEqual(verifyJwt(SECRET, "access", t, { nowSec: NOW + 1 }), { sub: "a@b.com", use: "access", iat: NOW, exp: NOW + 60 });
  });

  it("enforces expiry, exactly at the boundary", () => {
    const t = signJwt(SECRET, "access", {}, { nowSec: NOW, ttlSec: 60 });
    assert.ok(verifyJwt(SECRET, "access", t, { nowSec: NOW + 59 }));
    assert.equal(verifyJwt(SECRET, "access", t, { nowSec: NOW + 60 }), null);
    assert.equal(verifyJwt(SECRET, "access", t, { nowSec: NOW + 9999 }), null);
  });

  it("allows a token with no expiry only where the purpose chose that (client ids)", () => {
    const t = signJwt(SECRET, "client", { uris: [] }, { nowSec: NOW });
    assert.ok(verifyJwt(SECRET, "client", t, { nowSec: NOW + 10 * 365 * 86400 }));
  });

  it("rejects a token signed with a different secret", () => {
    assert.equal(verifyJwt(OTHER, "access", signJwt(SECRET, "access", {}, { nowSec: NOW, ttlSec: 60 }), { nowSec: NOW }), null);
  });

  it("rejects any tampering with the payload or the signature", () => {
    const [h, p, s] = signJwt(SECRET, "access", { sub: "a@b.com" }, { nowSec: NOW, ttlSec: 60 }).split(".");
    const forged = b64u({ sub: "boss@b.com", use: "access", iat: NOW, exp: NOW + 60 });
    assert.equal(verifyJwt(SECRET, "access", `${h}.${forged}.${s}`, { nowSec: NOW }), null);
    assert.equal(verifyJwt(SECRET, "access", `${h}.${p}.${s.slice(0, -2)}AA`, { nowSec: NOW }), null);
    assert.equal(verifyJwt(SECRET, "access", `${h}.${p}.`, { nowSec: NOW }), null);
  });

  it("is immune to the alg=none downgrade, however it is spelled", () => {
    const payload = b64u({ use: "access", email: "attacker@evil.com", exp: NOW + 60 });
    for (const alg of ["none", "None", "NONE", "nOnE"]) {
      assert.equal(verifyJwt(SECRET, "access", `${b64u({ alg, typ: "JWT" })}.${payload}.`, { nowSec: NOW }), null, alg);
      assert.equal(verifyJwt(SECRET, "access", `${b64u({ alg, typ: "JWT" })}.${payload}.AAAA`, { nowSec: NOW }), null, alg);
    }
  });

  it("refuses every algorithm but HS256, even with a valid HMAC under that header", () => {
    for (const alg of ["HS384", "HS512", "RS256", "ES256", ""]) {
      const head = b64u({ alg, typ: "JWT" });
      const body = b64u({ use: "access", exp: NOW + 60 });
      const sig = createHmac("sha256", createHmac("sha256", SECRET).update("routiq-mcp-oauth:access").digest()).update(`${head}.${body}`).digest("base64url");
      assert.equal(verifyJwt(SECRET, "access", `${head}.${body}.${sig}`, { nowSec: NOW }), null, `alg=${alg}`);
    }
  });

  it("makes tokens of one purpose useless as another, even though one secret backs them all", () => {
    const state = signJwt(SECRET, "state", { email: "a@b.com" }, { nowSec: NOW, ttlSec: 600 });
    const consent = signJwt(SECRET, "consent", { email: "a@b.com" }, { nowSec: NOW, ttlSec: 600 });
    const client = signJwt(SECRET, "client", {}, { nowSec: NOW });
    for (const token of [state, consent, client]) assert.equal(verifyJwt(SECRET, "access", token, { nowSec: NOW }), null);
    assert.equal(verifyJwt(SECRET, "consent", state, { nowSec: NOW }), null);
    assert.equal(verifyJwt(SECRET, "state", consent, { nowSec: NOW }), null);
  });

  it("rejects a re-labelled purpose claim: the KEY differs per purpose, not just the claim", () => {
    const [h, , s] = signJwt(SECRET, "state", {}, { nowSec: NOW, ttlSec: 600 }).split(".");
    const relabelled = b64u({ use: "access", iat: NOW, exp: NOW + 600 });
    assert.equal(verifyJwt(SECRET, "access", `${h}.${relabelled}.${s}`, { nowSec: NOW }), null);
  });

  it("returns null (never throws) for garbage", () => {
    for (const bad of ["", "abc", "a.b", "a.b.c.d", "....", "a b.c.d", "é.é.é", "x".repeat(9000), "eyJ.eyJ.sig", `${b64u("not json")}.${b64u("{}")}.AAAA`]) {
      assert.equal(verifyJwt(SECRET, "access", bad, { nowSec: NOW }), null, bad.slice(0, 20));
    }
    assert.equal(verifyJwt(SECRET, "access", undefined as never, { nowSec: NOW }), null);
    assert.equal(verifyJwt(SECRET, "access", 5 as never, { nowSec: NOW }), null);
  });

  it("rejects a non-numeric or missing-type exp", () => {
    const head = b64u({ alg: "HS256", typ: "JWT" });
    const forge = (payload: unknown) => {
      const body = b64u(payload);
      const sig = createHmac("sha256", createHmac("sha256", SECRET).update("routiq-mcp-oauth:access").digest()).update(`${head}.${body}`).digest("base64url");
      return `${head}.${body}.${sig}`;
    };
    assert.ok(verifyJwt(SECRET, "access", forge({ use: "access", exp: NOW + 60 }), { nowSec: NOW }), "sanity: correctly forged token verifies");
    assert.equal(verifyJwt(SECRET, "access", forge({ use: "access", exp: "9999999999" }), { nowSec: NOW }), null);
    assert.equal(verifyJwt(SECRET, "access", forge({ use: "access", exp: null }), { nowSec: NOW }), null);
  });
});

describe("looksLikeJwt", () => {
  it("distinguishes a JWT from a hex API key", () => {
    assert.equal(looksLikeJwt(signJwt(SECRET, "access", {}, { nowSec: NOW, ttlSec: 60 })), true);
    assert.equal(looksLikeJwt("a".repeat(64)), false);
    assert.equal(looksLikeJwt("a.b"), false);
    assert.equal(looksLikeJwt("a.b.c d"), false);
  });
});
