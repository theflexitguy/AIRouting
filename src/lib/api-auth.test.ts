import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGuard, type AuthDeps, type Profile } from "./api-auth.ts";

const SECRET = "s".repeat(32);
const PROFILES: Record<string, Profile> = {
  alice: { companyId: "company_A", role: "admin" },
  bob: { companyId: "company_B", role: "dispatcher" },
  vera: { companyId: "company_A", role: "viewer" },
  legacy: { companyId: "company_A", role: "" }, // profile written before roles existed
};

function make(over: Partial<AuthDeps> = {}) {
  let lookups = 0;
  let t = 1_000_000;
  const deps: AuthDeps = {
    verifyIdToken: async (tok) => {
      if (!tok.startsWith("tok-")) throw new Error("bad token");
      return { uid: tok.slice(4), email: `${tok.slice(4)}@x.com` };
    },
    loadProfile: async (uid) => { lookups++; return PROFILES[uid] ?? null; },
    operatorSecret: () => SECRET,
    now: () => t,
    ...over,
  };
  const g = createGuard(deps);
  return { g, lookups: () => lookups, advance: (ms: number) => { t += ms; } };
}

const H = (token?: string, extra: Record<string, string> = {}) => ({ ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra });
const get = (path: string, headers = {}) => new Request(`https://app.test${path}`, { headers });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://app.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

const ok = new Response("ok");
const status = async (p: Promise<Response>) => (await p).status;

describe("api guard — who gets in", () => {
  it("refuses a request with no credentials", async () => {
    const { g } = make();
    const h = g.guarded("company", () => ok);
    const r = await h(get("/api/jobs?companyId=company_A"));
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") || "", /Bearer/);
    assert.equal((await r.json()).error, "unauthorized");
  });

  it("refuses garbage and forged tokens", async () => {
    const { g } = make();
    const h = g.guarded("company", () => ok);
    assert.equal(await status(h(get("/api/jobs?companyId=company_A", H("not-a-token")))), 401);
    assert.equal(await status(h(get("/api/jobs?companyId=company_A", { authorization: "Basic abc" }))), 401);
    assert.equal(await status(h(get("/api/jobs?companyId=company_A", { authorization: "Bearer " }))), 401);
  });

  it("lets a member of the company in, and tells the handler who they are", async () => {
    const { g } = make();
    let seen: unknown;
    const h = g.guarded("company", (_r, a) => { seen = a; return ok; });
    assert.equal(await status(h(get("/api/jobs?companyId=company_A", H("tok-alice")))), 200);
    assert.equal((seen as { companyId: string }).companyId, "company_A");
    assert.equal((seen as { kind: string }).kind, "user");
  });

  it("refuses a signed-in user who has no profile / no company", async () => {
    const { g } = make();
    const h = g.guarded("company", () => ok);
    assert.equal(await status(h(get("/api/jobs?companyId=company_A", H("tok-nobody")))), 403);
  });

  it("returns a generic 503 (no detail) if the profile lookup fails", async () => {
    const { g } = make({ loadProfile: async () => { throw new Error("firestore secret detail"); } });
    const r = await g.guarded("company", () => ok)(get("/api/jobs?companyId=company_A", H("tok-alice")));
    assert.equal(r.status, 503);
    assert.ok(!(await r.text()).includes("secret detail"));
  });
});

describe("api guard — tenant isolation", () => {
  it("refuses another company named in the query string", async () => {
    const { g } = make();
    const h = g.guarded("company", () => ok);
    assert.equal(await status(h(get("/api/jobs?companyId=company_B", H("tok-alice")))), 403);
  });

  it("refuses another company named in a JSON body", async () => {
    const { g } = make();
    const h = g.guarded("company-write", () => ok);
    assert.equal(await status(h(post("/api/x", { companyId: "company_B" }, H("tok-alice")))), 403);
    assert.equal(await status(h(post("/api/x", { companyId: "company_A" }, H("tok-alice")))), 200);
  });

  it("cannot be bypassed by hiding the body behind another Content-Type", async () => {
    // The routes call request.json() without checking the header, so the guard must read the body the same way.
    const { g } = make();
    const h = g.guarded("company-write", () => ok);
    const sneaky = post("/api/x", JSON.stringify({ companyId: "company_B" }), H("tok-alice", { "content-type": "text/plain" }));
    assert.equal(await status(h(sneaky)), 403);
    const noType = new Request("https://app.test/api/x", { method: "POST", headers: H("tok-alice"), body: JSON.stringify({ companyId: "company_B" }) });
    assert.equal(await status(h(noType)), 403);
  });

  it("refuses when the company is named twice and either differs", async () => {
    const { g } = make();
    const h = g.guarded("company", () => ok);
    assert.equal(await status(h(get("/api/jobs?companyId=company_A&companyId=company_B", H("tok-alice")))), 403);
    assert.equal(await status(h(post("/api/x?companyId=company_A", { companyId: "company_B" }, H("tok-alice")))), 403);
  });

  it("is exact: no trimming, case-folding or prefix tricks", async () => {
    const { g } = make();
    const h = g.guarded("company", () => ok);
    for (const c of [" company_A", "company_A ", "COMPANY_A", "company_A/x", "company_", "company_A%00"]) {
      assert.equal(await status(h(get(`/api/jobs?companyId=${encodeURIComponent(c)}`, H("tok-alice")))), 403, JSON.stringify(c));
    }
  });

  it("rejects a non-string companyId in the body", async () => {
    const { g } = make();
    const h = g.guarded("company", () => ok);
    for (const bad of [["company_A"], { $ne: "" }, 5, true]) {
      assert.equal(await status(h(post("/api/x", { companyId: bad }, H("tok-alice")))), 400, JSON.stringify(bad));
    }
  });

  it("requires a user to name their company unless the route can default it (no silent 'first company' fallback)", async () => {
    const { g } = make();
    assert.equal(await status(g.guarded("company", () => ok)(get("/api/jobs", H("tok-alice")))), 400);
    assert.equal(await status(g.guarded("company", () => ok)(post("/api/x", { companyId: "" }, H("tok-alice")))), 400);
    let seen = "";
    const implicit = g.guarded("company", (_r, a) => { seen = a.companyId!; return ok; }, { implicitCompany: true });
    assert.equal(await status(implicit(post("/api/x", { companyId: "" }, H("tok-alice")))), 200);
    assert.equal(seen, "company_A");
    assert.equal(await status(implicit(post("/api/x", { companyId: "company_B" }, H("tok-alice")))), 403, "still refused if it names another");
  });

  it("multipart routes get the check delegated: mayAccess", async () => {
    const { g } = make();
    let mine = false, theirs = true;
    const h = g.guarded("company-write", (_r, a) => { mine = a.mayAccess("company_A"); theirs = a.mayAccess("company_B"); return ok; }, { routeChecksCompany: true });
    const fd = new FormData();
    fd.set("companyId", "company_B");
    const r = await h(new Request("https://app.test/api/upload", { method: "POST", headers: H("tok-alice"), body: fd }));
    assert.equal(r.status, 200);
    assert.equal(mine, true);
    assert.equal(theirs, false);
  });

  it("does not consume the request body: the handler can still read it", async () => {
    const { g } = make();
    const h = g.guarded("company", async (r) => new Response(JSON.stringify(await r.json())));
    const r = await h(post("/api/x", { companyId: "company_A", n: 7 }, H("tok-alice")));
    assert.deepEqual(await r.json(), { companyId: "company_A", n: 7 });
  });
});

describe("api guard — roles", () => {
  it("company-write refuses viewers but allows admins, dispatchers and legacy profiles without a role", async () => {
    const { g } = make();
    const h = g.guarded("company-write", () => ok);
    const call = (u: string) => status(h(post("/api/x", { companyId: PROFILES[u].companyId }, H(`tok-${u}`))));
    assert.equal(await call("vera"), 403);
    assert.equal(await call("alice"), 200);
    assert.equal(await call("bob"), 200);
    assert.equal(await call("legacy"), 200);
  });

  it("company (read) still lets viewers in", async () => {
    const { g } = make();
    assert.equal(await status(g.guarded("company", () => ok)(get("/api/jobs?companyId=company_A", H("tok-vera")))), 200);
  });
});

describe("api guard — operator secret", () => {
  it("is the ONLY way into operator routes; signed-in users, even admins, are refused", async () => {
    const { g } = make();
    const h = g.guarded("operator", () => ok);
    assert.equal(await status(h(post("/api/admin/delete-company", { companyId: "company_A" }, H("tok-alice")))), 401);
    assert.equal(await status(h(post("/api/admin/delete-company", {}, H(SECRET)))), 200);
    assert.equal(await status(h(post("/api/admin/x", {}, { "x-cron-secret": SECRET }))), 200);
    assert.equal(await status(h(get(`/api/admin/x?secret=${SECRET}`))), 200);
  });

  it("refuses a wrong or near-miss secret", async () => {
    const { g } = make();
    const h = g.guarded("operator", () => ok);
    for (const bad of ["", "x", SECRET.slice(1), SECRET + "x", SECRET.toUpperCase()]) {
      assert.equal(await status(h(post("/api/admin/x", {}, H(bad || undefined, { "x-cron-secret": bad })))), 401, JSON.stringify(bad));
    }
    assert.equal(await status(h(get("/api/admin/x?secret=wrong"))), 401);
  });

  it("fails CLOSED when no secret is configured, even for an empty presented secret", async () => {
    const { g } = make({ operatorSecret: () => "" });
    const h = g.guarded("operator", () => ok);
    assert.equal(await status(h(get("/api/admin/x?secret="))), 401);
    assert.equal(await status(h(post("/api/admin/x", {}, { "x-cron-secret": "" }))), 401);
    assert.equal(await status(h(post("/api/admin/x", {}, { authorization: "Bearer " }))), 401);
  });

  it("the operator can act on any company through company routes, and is told so", async () => {
    const { g } = make();
    let seen: { kind: string; ok: boolean } | null = null;
    const h = g.guarded("company-write", (_r, a) => { seen = { kind: a.kind, ok: a.mayAccess("company_anything") }; return ok; });
    assert.equal(await status(h(post("/api/x", { companyId: "company_B" }, H(SECRET)))), 200);
    assert.deepEqual(seen, { kind: "operator", ok: true });
  });
});

describe("api guard — profile cache", () => {
  it("reads the profile once per 30 seconds, then again", async () => {
    const m = make();
    const h = m.g.guarded("company", () => ok);
    for (let i = 0; i < 5; i++) await h(get("/api/jobs?companyId=company_A", H("tok-alice")));
    assert.equal(m.lookups(), 1);
    m.advance(31_000);
    await h(get("/api/jobs?companyId=company_A", H("tok-alice")));
    assert.equal(m.lookups(), 2);
  });

  it("never caches 'no profile', so a fresh sign-up works the moment its profile exists", async () => {
    const profiles: Record<string, Profile> = {};
    const m = make({ loadProfile: async (u) => profiles[u] ?? null });
    const h = m.g.guarded("company", () => ok);
    assert.equal(await status(h(get("/api/jobs?companyId=company_N", H("tok-new")))), 403);
    profiles["new"] = { companyId: "company_N", role: "admin" };
    assert.equal(await status(h(get("/api/jobs?companyId=company_N", H("tok-new")))), 200);
  });
});
