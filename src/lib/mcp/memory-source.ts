// In-memory DashboardDataSource for tests and local experiments. Same contract as the
// Firestore one, so the tools cannot tell the difference.

import type { MonthlyDone } from "@/lib/fieldroutes/monthly-done";
import type { JobRec, RouteRec } from "@/lib/dashboard";
import type { CompanyMeta, DashboardDataSource, SyncStatus, TechRecord } from "./data-source.ts";

export interface MemoryFixture {
  companyId?: string;
  meta?: Partial<CompanyMeta>;
  jobs?: JobRec[];
  routes?: RouteRec[];
  techs?: TechRecord[];
  monthlyDone?: Record<string, MonthlyDone>;
  liveMonthlyDone?: MonthlyDone | null;
  sync?: Partial<SyncStatus>;
}

export class MemoryDataSource implements DashboardDataSource {
  readonly companyId: string;
  readonly readAt = () => "2026-01-01T00:00:00.000Z";
  private readonly fx: MemoryFixture;
  // (No constructor parameter properties: the test runner strips types but cannot transform them.)
  constructor(fx: MemoryFixture = {}) {
    this.fx = fx;
    this.companyId = fx.companyId ?? "test-company";
  }
  async getCompanyMeta(): Promise<CompanyMeta> {
    return { id: this.companyId, name: "Test Co", routeGroups: [], forecastMonthlyGrowthPct: 0, ...this.fx.meta };
  }
  async getJobs() { return (this.fx.jobs ?? []).map((j) => ({ ...j })); }
  async getRoutes(start: string, end: string) {
    return (this.fx.routes ?? []).filter((r) => r.date >= start && r.date <= end).map((r) => ({ ...r }));
  }
  async getTechnicians() { return this.fx.techs ?? []; }
  async getMonthlyDone(month: string) { return this.fx.monthlyDone?.[month] ?? null; }
  async getLiveMonthlyDone() { return this.fx.liveMonthlyDone ?? null; }
  async getSyncStatus(): Promise<SyncStatus> {
    return {
      lastRunAt: null, lastRunMode: null, lastFullSyncAt: null, lastIncrementalAt: null,
      runActive: false, finalizedThrough: null, lastInScopeCount: null, apiUsage: null,
      ...this.fx.sync,
    };
  }
}
