// FieldRoutes API usage metering + daily hard cap.
//
// FieldRoutes enforces a hard quota of 3,000 reads/day for the WHOLE account —
// shared across every piece of software that touches the API. This module lets
// RouteIQ (a) record how many reads/writes it has spent today and (b) refuse to
// start new work once it crosses a company-configured cap, so RouteIQ never eats
// the entire account quota on its own.
//
// Storage:
//   companies/{companyId}/fieldRoutesState/apiUsage
//     { date: "YYYY-MM-DD" (Central), reads: n, writes: n, updatedAt }
//   The counters reset implicitly when the Central calendar day rolls over.
//
// Cap (company-configurable, read from the company doc):
//   companies/{companyId}.fieldRoutesApiDailyCap  (a number; counts reads+writes)

import { centralTodayISO } from "./scope";

// Headroom under FieldRoutes' 3,000/day account limit, leaving budget for any
// other software on the same account. Used when the company hasn't set a cap.
export const DEFAULT_API_DAILY_CAP = 2500;

export interface ApiUsage {
  date: string;
  reads: number;
  writes: number;
  total: number;
}

type Db = FirebaseFirestore.Firestore;

function usageRef(db: Db, companyId: string) {
  return db.doc(`companies/${companyId}/fieldRoutesState/apiUsage`);
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Today's usage (Central time). If the stored doc is from a previous day the
 * counters are treated as zero — the day has rolled over and the quota reset.
 */
export async function loadApiUsage(db: Db, companyId: string): Promise<ApiUsage> {
  const today = centralTodayISO();
  const snap = await usageRef(db, companyId).get();
  const data = snap.exists ? (snap.data() as Record<string, unknown>) : null;
  if (!data || data.date !== today) {
    return { date: today, reads: 0, writes: 0, total: 0 };
  }
  const reads = toCount(data.reads);
  const writes = toCount(data.writes);
  return { date: today, reads, writes, total: reads + writes };
}

/**
 * The company's daily cap on combined reads+writes. Falls back to
 * DEFAULT_API_DAILY_CAP when unset or invalid.
 */
export async function loadApiCap(db: Db, companyId: string): Promise<number> {
  const snap = await db.doc(`companies/${companyId}`).get();
  const raw = snap.exists ? (snap.data() as Record<string, unknown>).fieldRoutesApiDailyCap : undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_API_DAILY_CAP;
}

export interface Budget {
  cap: number;
  usedReads: number;
  usedWrites: number;
  used: number;
  remaining: number;
}

/** Load the cap and current usage together, returning the remaining budget. */
export async function loadBudget(db: Db, companyId: string): Promise<Budget> {
  const [usage, cap] = await Promise.all([loadApiUsage(db, companyId), loadApiCap(db, companyId)]);
  return {
    cap,
    usedReads: usage.reads,
    usedWrites: usage.writes,
    used: usage.total,
    remaining: Math.max(0, cap - usage.total),
  };
}

/**
 * Atomically add to today's read/write tallies. Resets the counters first if the
 * stored doc belongs to a previous Central day. Safe to call concurrently.
 */
export async function recordApiUsage(
  db: Db,
  companyId: string,
  delta: { reads?: number; writes?: number },
): Promise<void> {
  const reads = toCount(delta.reads);
  const writes = toCount(delta.writes);
  if (reads === 0 && writes === 0) return;

  const today = centralTodayISO();
  const ref = usageRef(db, companyId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? (snap.data() as Record<string, unknown>) : null;
    const sameDay = Boolean(data && data.date === today);
    tx.set(
      ref,
      {
        date: today,
        reads: (sameDay ? toCount(data?.reads) : 0) + reads,
        writes: (sameDay ? toCount(data?.writes) : 0) + writes,
        updatedAt: new Date().toISOString(),
      },
      { merge: true },
    );
  });
}
