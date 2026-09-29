// Firestore implementation of DashboardDataSource (Admin SDK, read-only).
//
// Cost control: the jobs collection is the expensive read (thousands of documents), and a
// chatty model can call several tools in a row. Reads are therefore cached per server
// instance for a short TTL, and concurrent callers share one in-flight read.

import { deriveServiceLine } from "@/lib/routing/service-line";
import type { MonthlyDone } from "@/lib/fieldroutes/monthly-done";
import type { JobRec, RouteRec } from "@/lib/dashboard";
import type { CompanyMeta, DashboardDataSource, SyncStatus, TechRecord } from "./data-source.ts";

interface CacheEntry {
  expires: number;
  readAt: string;
  value: Promise<unknown>;
}
const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 300;

/** Test hooks. */
export function clearMcpCache() {
  cache.clear();
}
export function mcpCacheSize() {
  return cache.size;
}

/** Entries are keyed by query (e.g. each distinct route window), so without a bound a caller
 *  probing many date ranges would grow a warm server instance's memory forever. */
function evict(now: number) {
  // Called BEFORE inserting, so make room for exactly one more.
  if (cache.size < MAX_CACHE_ENTRIES) return;
  for (const [k, e] of cache) if (e.expires <= now) cache.delete(k);
  let excess = cache.size - (MAX_CACHE_ENTRIES - 1);
  for (const k of cache.keys()) {
    if (excess-- <= 0) break;
    cache.delete(k); // Map iterates in insertion order: oldest first
  }
}

/** Firestore Timestamps → ISO strings, recursively, so results are plain JSON. */
export function plain<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const v = value as unknown as { toDate?: () => Date };
  if (typeof v.toDate === "function") return v.toDate().toISOString() as unknown as T;
  if (Array.isArray(value)) return value.map(plain) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(value as Record<string, unknown>)) out[k] = plain(val);
  return out as T;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v).trim());

/**
 * The route fields the dashboard math and the tool outputs use. Read via a Firestore field
 * mask so route documents (which can carry large geometry) are never pulled into memory, and
 * so a field added to the schema later is not exposed until it is added here on purpose.
 */
const ROUTE_FIELDS = [
  "date", "techId", "techName", "routeGroupTitle", "routeTemplateTitle", "routeValue",
  "completedStops", "stopSequence", "stops", "totalStops", "totalDriveTimeMinutes",
  "totalWorkMinutes", "totalServiceMinutes", "driveTimeSource", "driveTimeLocatedStops",
  "approved", "locked", "source", "generatedBy", "hasFieldRoutesStops", "confidence", "updatedAt",
];

export class FirestoreDataSource implements DashboardDataSource {
  readonly companyId: string;
  private readonly ttlMs: number;
  private readonly db: FirebaseFirestore.Firestore;
  // (No constructor parameter properties: the test runner strips types but cannot transform them.)
  // The database is injected (the route passes adminDb()) so this class has no import-time
  // dependency on firebase-admin and can be tested against a fake.
  constructor(companyId: string, ttlMs: number, db: FirebaseFirestore.Firestore) {
    this.companyId = companyId;
    this.ttlMs = ttlMs;
    this.db = db;
  }

  // The OLDEST read among everything this instance has served. A request that mixes cached
  // jobs (read 50s ago) with fresh routes must not claim its data is from "now".
  private oldestRead: string | null = null;
  readonly readAt = () => this.oldestRead ?? new Date().toISOString();

  private touch(readAt: string) {
    if (this.oldestRead === null || readAt < this.oldestRead) this.oldestRead = readAt;
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const k = `${this.companyId}:${key}`;
    const hit = cache.get(k);
    const now = Date.now();
    if (hit && hit.expires > now) {
      this.touch(hit.readAt);
      return hit.value as Promise<T>;
    }
    if (hit) cache.delete(k); // expired: re-insert so it moves to the young end of the map
    const readAt = new Date().toISOString();
    this.touch(readAt);
    evict(now);
    const value = load();
    cache.set(k, { expires: now + this.ttlMs, readAt, value });
    // A failed read must not be served from cache.
    value.catch(() => cache.delete(k));
    return value;
  }

  private col(path: string) {
    return this.db.collection(`companies/${this.companyId}/${path}`);
  }
  private doc(path: string) {
    return this.db.doc(`companies/${this.companyId}/${path}`);
  }

  getCompanyMeta(): Promise<CompanyMeta> {
    return this.cached("meta", async () => {
      const snap = await this.db.doc(`companies/${this.companyId}`).get();
      const d = (snap.exists ? snap.data() : {}) as Record<string, unknown>;
      // Explicit whitelist. NEVER spread the company document: it holds fieldRoutesApiKey /
      // fieldRoutesApiSecret.
      const groups = Array.isArray(d.fieldRoutesRouteGroups) ? d.fieldRoutesRouteGroups.map(str).filter(Boolean) : [];
      const g = Number(d.forecastMonthlyGrowthPct);
      return {
        id: this.companyId,
        name: str(d.name) || this.companyId,
        routeGroups: groups,
        forecastMonthlyGrowthPct: Number.isFinite(g) ? g : 0,
      };
    });
  }

  getJobs(): Promise<JobRec[]> {
    return this.cached("jobs", async () => {
      // Same query the dashboard runs: in-scope subscriptions only.
      const snap = await this.col("jobs").where("inScope", "==", true).get();
      return snap.docs.map((d) => {
        const data = plain(d.data()) as JobRec;
        data.docId = d.id;
        // Derive serviceLine on the fly when a doc predates the stamping (same as the page).
        if (!data.serviceLine) data.serviceLine = deriveServiceLine(data.serviceType, data.fieldRoutesRouteGroup);
        return data;
      });
    });
  }

  getRoutes(start: string, end: string): Promise<RouteRec[]> {
    return this.cached(`routes:${start}:${end}`, async () => {
      const snap = await this.col("routes")
        .where("date", ">=", start)
        .where("date", "<=", end)
        .select(...ROUTE_FIELDS)
        .get();
      return snap.docs.map((d) => plain(d.data()) as RouteRec);
    });
  }

  getTechnicians(): Promise<TechRecord[]> {
    return this.cached("techs", async () => {
      // Field mask: home start/end coordinates on these documents are personal data and are
      // never read.
      const snap = await this.col("technicians")
        .select("name", "employeeId", "fieldRoutesEmployeeId", "fieldRoutesTechId", "skillNames")
        .get();
      return snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          name: str(data.name) || d.id,
          employeeId: str(data.employeeId) || undefined,
          fieldRoutesEmployeeId: str(data.fieldRoutesEmployeeId) || undefined,
          fieldRoutesTechId: str(data.fieldRoutesTechId) || undefined,
          skillNames: Array.isArray(data.skillNames) ? data.skillNames.map(str).filter(Boolean) : [],
        };
      });
    });
  }

  getMonthlyDone(month: string): Promise<MonthlyDone | null> {
    if (!/^\d{4}-\d{2}$/.test(month)) return Promise.resolve(null);
    return this.cached(`md:${month}`, async () => {
      const snap = await this.doc(`monthlyDone/${month}`).get();
      return snap.exists ? (plain(snap.data()) as MonthlyDone) : null;
    });
  }

  getLiveMonthlyDone(): Promise<MonthlyDone | null> {
    return this.cached("md:live", async () => {
      const snap = await this.doc("fieldRoutesState/monthlyDone").get();
      return snap.exists ? (plain(snap.data()) as MonthlyDone) : null;
    });
  }

  getSyncStatus(): Promise<SyncStatus> {
    return this.cached("sync", async () => {
      const [sync, fin, usage] = await Promise.all([
        this.doc("fieldRoutesState/sync").get(),
        this.doc("fieldRoutesState/routeFinalization").get(),
        this.doc("fieldRoutesState/apiUsage").get(),
      ]);
      const s = (sync.exists ? sync.data() : {}) as Record<string, unknown>;
      const u = usage.exists ? (usage.data() as Record<string, unknown>) : null;
      const opt = (v: unknown) => str(v) || null;
      const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      return {
        lastRunAt: opt(s.lastRunAt),
        lastRunMode: opt(s.lastRunMode),
        lastFullSyncAt: opt(s.lastFullSyncAt),
        lastIncrementalAt: opt(s.lastIncrementalAt),
        runActive: Boolean((s.run as { active?: boolean } | undefined)?.active),
        finalizedThrough: fin.exists ? opt(fin.data()?.finalizedThrough) : null,
        lastInScopeCount: s.lastInScopeCount === undefined ? null : n(s.lastInScopeCount),
        apiUsage: u ? { date: opt(u.date), reads: n(u.reads), writes: n(u.writes) } : null,
      };
    });
  }
}
