// The MCP server's ONLY window onto the database. It is deliberately read-only: there is
// no method here that can write, so no tool can ever change anything — that property is
// enforced by this interface, not by convention.

import type { MonthlyDone } from "@/lib/fieldroutes/monthly-done";
import type { JobRec, RouteRec } from "@/lib/dashboard";

/** Company facts the dashboard uses. Whitelisted at the source — the company document also
 *  holds FieldRoutes API credentials, which must never be readable through this interface. */
export interface CompanyMeta {
  id: string;
  name: string;
  /** Route-group titles chosen as dashboard filters (Settings → Route Groups). */
  routeGroups: string[];
  /** Technicians Needed forecast: manual monthly growth %, 0 = automatic. */
  forecastMonthlyGrowthPct: number;
}

/** A technician as the dashboard sees one. Home start/end coordinates are stored on the
 *  technician document; they are personal data and are intentionally NOT part of this type. */
export interface TechRecord {
  id: string;
  name: string;
  employeeId?: string;
  fieldRoutesEmployeeId?: string;
  fieldRoutesTechId?: string;
  skillNames: string[];
}

export interface SyncStatus {
  lastRunAt: string | null;
  lastRunMode: string | null;
  lastFullSyncAt: string | null;
  lastIncrementalAt: string | null;
  /** A resumable sync is mid-flight right now. */
  runActive: boolean;
  /** Routes on or before this date are finalized and no longer re-verified. */
  finalizedThrough: string | null;
  lastInScopeCount: number | null;
  /** FieldRoutes API reads/writes spent today, against the daily cap. */
  apiUsage: { date: string | null; reads: number; writes: number } | null;
}

export interface DashboardDataSource {
  readonly companyId: string;
  /** When the OLDEST data served so far was read from the database (ISO) — an honest upper bound on staleness. */
  readonly readAt: () => string;
  getCompanyMeta(): Promise<CompanyMeta>;
  /** Every in-scope subscription, exactly as the dashboard loads them. */
  getJobs(): Promise<JobRec[]>;
  /** Route documents with `start <= date <= end` (inclusive, YYYY-MM-DD). */
  getRoutes(start: string, end: string): Promise<RouteRec[]>;
  getTechnicians(): Promise<TechRecord[]>;
  /** companies/{id}/monthlyDone/{YYYY-MM}, or null if that month was never computed. */
  getMonthlyDone(month: string): Promise<MonthlyDone | null>;
  /** The legacy single "current month" aggregate behind the Completed This Month cards. */
  getLiveMonthlyDone(): Promise<MonthlyDone | null>;
  getSyncStatus(): Promise<SyncStatus>;
}

export interface McpContext {
  data: DashboardDataSource;
  /** Today in America/Chicago, YYYY-MM-DD. Injected so tests are deterministic. */
  today: string;
  /** Current time. Injected so tests are deterministic. */
  now: () => Date;
}
