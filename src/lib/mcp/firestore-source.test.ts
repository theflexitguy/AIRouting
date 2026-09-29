import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { FirestoreDataSource, clearMcpCache, mcpCacheSize, plain } from "./firestore-source.ts";

type Rec = Record<string, unknown>;

/** A tiny Firestore stand-in that honours where() and select() field masks, and counts reads. */
class FakeFirestore {
  docs: Record<string, Rec> = {};
  collections: Record<string, Array<{ id: string; data: Rec }>> = {};
  reads = 0;
  masks: Record<string, string[]> = {};
  failNext = false;

  doc(path: string) {
    return {
      get: async () => {
        this.reads++;
        if (this.failNext) { this.failNext = false; throw new Error("boom"); }
        const d = this.docs[path];
        return { exists: d !== undefined, data: () => (d === undefined ? undefined : { ...d }) };
      },
    };
  }
  collection(path: string) {
    return new FakeQuery(this, path, [], null);
  }
}

class FakeQuery {
  db: FakeFirestore; path: string; filters: Array<[string, string, unknown]>; mask: string[] | null;
  constructor(db: FakeFirestore, path: string, filters: Array<[string, string, unknown]>, mask: string[] | null) {
    this.db = db; this.path = path; this.filters = filters; this.mask = mask;
  }
  where(field: string, op: string, value: unknown) { return new FakeQuery(this.db, this.path, [...this.filters, [field, op, value]], this.mask); }
  select(...fields: string[]) { return new FakeQuery(this.db, this.path, this.filters, fields); }
  async get() {
    this.db.reads++;
    if (this.db.failNext) { this.db.failNext = false; throw new Error("boom"); }
    if (this.mask) this.db.masks[this.path] = this.mask;
    const rows = (this.db.collections[this.path] ?? []).filter((r) =>
      this.filters.every(([f, op, v]) => {
        const x = r.data[f] as never;
        return op === "==" ? x === v : op === ">=" ? x >= (v as never) : op === "<=" ? x <= (v as never) : true;
      }),
    );
    const docs = rows.map((r) => ({
      id: r.id,
      data: () => {
        if (!this.mask) return { ...r.data };
        return Object.fromEntries(Object.entries(r.data).filter(([k]) => this.mask!.includes(k)));
      },
    }));
    return { docs, size: docs.length };
  }
}

let n = 0;
const make = (over: { ttl?: number } = {}) => {
  const db = new FakeFirestore();
  const id = `co${++n}`;
  const src = new FirestoreDataSource(id, over.ttl ?? 60_000, db as never);
  return { db, id, src, base: `companies/${id}` };
};
beforeEach(() => clearMcpCache());

describe("FirestoreDataSource — what it will not read", () => {
  it("returns only whitelisted company settings, never credentials", async () => {
    const { db, id, src } = make();
    db.docs[`companies/${id}`] = {
      name: "Flex", plan: "pro", fieldRoutesApiKey: "SECRET-KEY", fieldRoutesApiSecret: "SECRET-SECRET",
      fieldRoutesRouteGroups: ["GPC", " ", "Specialty"], forecastMonthlyGrowthPct: "5",
    };
    const meta = await src.getCompanyMeta();
    assert.deepEqual(meta, { id, name: "Flex", routeGroups: ["GPC", "Specialty"], forecastMonthlyGrowthPct: 5 });
    assert.ok(!JSON.stringify(meta).includes("SECRET"));
  });

  it("falls back gracefully when the company document is missing", async () => {
    const { id, src } = make();
    assert.deepEqual(await src.getCompanyMeta(), { id, name: id, routeGroups: [], forecastMonthlyGrowthPct: 0 });
  });

  it("never reads technicians' home coordinates (field mask, not after-the-fact filtering)", async () => {
    const { db, src, base } = make();
    db.collections[`${base}/technicians`] = [
      { id: "t1", data: { name: "Kalin", employeeId: "1", skillNames: ["GPC"], startLat: 36.3, startLng: -94.2, endLat: 36.4, endLng: -94.1 } },
    ];
    const techs = await src.getTechnicians();
    assert.deepEqual(techs, [{ id: "t1", name: "Kalin", employeeId: "1", fieldRoutesEmployeeId: undefined, fieldRoutesTechId: undefined, skillNames: ["GPC"] }]);
    const mask = db.masks[`${base}/technicians`];
    assert.ok(mask, "a field mask must be applied");
    for (const banned of ["startLat", "startLng", "endLat", "endLng"]) assert.ok(!mask.includes(banned), banned);
    assert.ok(!JSON.stringify(techs).includes("36.3"));
  });

  it("reads routes through a field mask that excludes geometry and unknown fields", async () => {
    const { db, src, base } = make();
    db.collections[`${base}/routes`] = [
      { id: "a", data: { date: "2026-09-10", techName: "K", totalStops: 3, polyline: "x".repeat(5000), internalNote: "nope" } },
    ];
    const [route] = await src.getRoutes("2026-09-01", "2026-09-30");
    assert.equal(route.date, "2026-09-10");
    assert.equal((route as Rec).polyline, undefined);
    assert.equal((route as Rec).internalNote, undefined);
    const mask = db.masks[`${base}/routes`];
    assert.ok(mask.includes("stops") && mask.includes("completedStops") && mask.includes("driveTimeSource"));
    assert.ok(!mask.some((f) => /polyline|geometry/i.test(f)));
  });
});

describe("FirestoreDataSource — queries", () => {
  it("filters routes by inclusive date range", async () => {
    const { db, src, base } = make();
    db.collections[`${base}/routes`] = ["2026-08-31", "2026-09-01", "2026-09-15", "2026-09-30", "2026-10-01"].map((d) => ({ id: d, data: { date: d } }));
    assert.deepEqual((await src.getRoutes("2026-09-01", "2026-09-30")).map((r) => r.date), ["2026-09-01", "2026-09-15", "2026-09-30"]);
  });

  it("loads only in-scope jobs, stamps docId, derives a missing service line, and converts timestamps", async () => {
    const { db, src, base } = make();
    db.collections[`${base}/jobs`] = [
      { id: "sub_1", data: { inScope: true, serviceType: "Mosquito Fogging", syncedAt: { toDate: () => new Date("2026-09-01T12:00:00Z") } } },
      { id: "sub_2", data: { inScope: false, serviceType: "General Pest" } },
      { id: "sub_3", data: { inScope: true, serviceType: "Termite Bait Stations", serviceLine: "termite" } },
    ];
    const jobs = await src.getJobs();
    assert.deepEqual(jobs.map((j) => j.docId), ["sub_1", "sub_3"]);
    assert.equal(jobs[0].serviceLine, "mosquito"); // derived, like the dashboard does
    assert.equal(jobs[1].serviceLine, "termite"); // kept
    assert.equal((jobs[0] as Rec).syncedAt, "2026-09-01T12:00:00.000Z");
  });

  it("returns null for a malformed or missing monthly aggregate, without reading for the former", async () => {
    const { db, src, base } = make();
    assert.equal(await src.getMonthlyDone("not-a-month"), null);
    assert.equal(db.reads, 0);
    db.docs[`${base}/monthlyDone/2026-08`] = { month: "2026-08", completedAppointments: 5 };
    assert.equal((await src.getMonthlyDone("2026-08"))?.completedAppointments, 5);
    assert.equal(await src.getMonthlyDone("2026-07"), null);
  });

  it("reads the legacy live aggregate from fieldRoutesState/monthlyDone", async () => {
    const { db, src, base } = make();
    db.docs[`${base}/fieldRoutesState/monthlyDone`] = { month: "2026-09" };
    assert.equal((await src.getLiveMonthlyDone())?.month, "2026-09");
  });

  it("assembles sync status from three state documents", async () => {
    const { db, src, base } = make();
    db.docs[`${base}/fieldRoutesState/sync`] = { lastRunAt: "2026-09-16T09:00:00Z", lastRunMode: "incremental", lastFullSyncAt: "2026-09-10T09:00:00Z", run: { active: true }, lastInScopeCount: 4200 };
    db.docs[`${base}/fieldRoutesState/routeFinalization`] = { finalizedThrough: "2026-09-14" };
    db.docs[`${base}/fieldRoutesState/apiUsage`] = { date: "2026-09-16", reads: 321, writes: "4" };
    assert.deepEqual(await src.getSyncStatus(), {
      lastRunAt: "2026-09-16T09:00:00Z", lastRunMode: "incremental", lastFullSyncAt: "2026-09-10T09:00:00Z", lastIncrementalAt: null,
      runActive: true, finalizedThrough: "2026-09-14", lastInScopeCount: 4200, apiUsage: { date: "2026-09-16", reads: 321, writes: 4 },
    });
  });

  it("copes with a company that has never synced", async () => {
    const { src } = make();
    const s = await src.getSyncStatus();
    assert.equal(s.lastRunAt, null);
    assert.equal(s.runActive, false);
    assert.equal(s.finalizedThrough, null);
    assert.equal(s.apiUsage, null);
  });
});

describe("FirestoreDataSource — cache", () => {
  it("reuses a read within the TTL", async () => {
    const { db, src, base } = make();
    db.collections[`${base}/jobs`] = [{ id: "sub_1", data: { inScope: true } }];
    await src.getJobs();
    await src.getJobs();
    await src.getJobs();
    assert.equal(db.reads, 1);
  });

  it("lets concurrent callers share one in-flight read", async () => {
    const { db, src, base } = make();
    db.collections[`${base}/jobs`] = [{ id: "sub_1", data: { inScope: true } }];
    await Promise.all([src.getJobs(), src.getJobs(), src.getJobs(), src.getJobs()]);
    assert.equal(db.reads, 1);
  });

  it("re-reads once the TTL has passed (ttl=0 disables caching)", async () => {
    const { db, src, base } = make({ ttl: 0 });
    db.collections[`${base}/jobs`] = [{ id: "sub_1", data: { inScope: true } }];
    await src.getJobs();
    await src.getJobs();
    assert.equal(db.reads, 2);
  });

  it("caches per key: different route windows are different reads", async () => {
    const { db, src } = make();
    await src.getRoutes("2026-09-01", "2026-09-10");
    await src.getRoutes("2026-09-01", "2026-09-10");
    await src.getRoutes("2026-09-01", "2026-09-11");
    assert.equal(db.reads, 2);
  });

  it("keeps companies apart", async () => {
    const a = make();
    const b = make();
    a.db.collections[`${a.base}/jobs`] = [{ id: "a1", data: { inScope: true } }];
    b.db.collections[`${b.base}/jobs`] = [{ id: "b1", data: { inScope: true } }];
    assert.equal((await a.src.getJobs())[0].docId, "a1");
    assert.equal((await b.src.getJobs())[0].docId, "b1");
  });

  it("never serves a failed read from cache", async () => {
    const { db, src, base } = make();
    db.collections[`${base}/jobs`] = [{ id: "sub_1", data: { inScope: true } }];
    db.failNext = true;
    await assert.rejects(src.getJobs(), /boom/);
    assert.equal((await src.getJobs()).length, 1); // retried, not the cached failure
  });

  it("reports when its data was read", async () => {
    const { src } = make();
    await src.getJobs();
    assert.match(src.readAt(), /^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports the OLDEST data it served, so a mix of cached and fresh reads never overstates freshness", async () => {
    const { db, src, id, base } = make();
    db.collections[`${base}/jobs`] = [{ id: "sub_1", data: { inScope: true } }];
    await src.getJobs(); // read now (t0) and cached
    await new Promise((r) => setTimeout(r, 25));
    const second = new FirestoreDataSource(id, 60_000, db as never); // a later request, same warm cache
    await second.getJobs(); // cache hit → t0
    await second.getRoutes("2026-09-01", "2026-09-02"); // fresh read → t1 > t0
    assert.equal(second.readAt(), src.readAt(), "must report the older jobs read, not the newer routes read");
  });

  it("bounds the cache so probing many date ranges cannot grow memory without limit", async () => {
    const { src } = make();
    for (let i = 0; i < 450; i++) await src.getRoutes(`2026-01-01`, `2027-01-${String((i % 28) + 1).padStart(2, "0")}-${i}`);
    assert.ok(mcpCacheSize() <= 300, `cache holds ${mcpCacheSize()} entries`);
    // and it still serves fresh reads correctly afterwards
    assert.deepEqual(await src.getRoutes("2026-01-01", "2026-01-02"), []);
  });

  it("evicts expired entries before live ones", async () => {
    const { src } = make({ ttl: 0 }); // everything expires immediately
    for (let i = 0; i < 350; i++) await src.getRoutes("2026-01-01", `2026-02-${i}`);
    assert.ok(mcpCacheSize() <= 300);
  });
});

describe("plain()", () => {
  it("converts nested Timestamps and leaves primitives alone", () => {
    const t = { toDate: () => new Date("2026-01-02T03:04:05Z") };
    assert.deepEqual(plain({ a: t, b: [t, 1, "x", null], c: { d: t } }), {
      a: "2026-01-02T03:04:05.000Z", b: ["2026-01-02T03:04:05.000Z", 1, "x", null], c: { d: "2026-01-02T03:04:05.000Z" },
    });
    assert.equal(plain(5), 5);
    assert.equal(plain(null), null);
  });
});
