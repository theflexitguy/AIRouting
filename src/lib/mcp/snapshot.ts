// Builds the dashboard's working state from the data source — the same pipeline the
// dashboard page runs (load → resolve filters → filter routes → stats), using the same
// shared functions from src/lib/dashboard, so every number matches what the owner sees.

import { canonicalRouteGroup } from "@/lib/route-groups";
import {
  buildDrillData,
  buildJobsByDocId,
  buildOverdueDrill,
  buildTechKeys,
  computeDashboardBounds,
  computeDashboardStats,
  makeRouteFilter,
  norm,
  selectScopedRoutes,
  type DashboardBounds,
  type DashboardStats,
  type DrillData,
  type JobRec,
  type OverdueDrill,
  type RouteRec,
} from "@/lib/dashboard";
import type { McpContext, TechRecord } from "./data-source.ts";
import { ToolInputError } from "./format.ts";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400; // bounds Firestore reads for one call
export const STOP_TYPES = ["regular", "initial", "reservice"] as const;

/** The filter bar, as a tool accepts it. Every field is optional; empty = no filter. */
export interface FilterInput {
  technicians?: string[];
  routeGroups?: string[];
  routeTemplates?: string[];
  subscriptionTypes?: string[];
  stopTypes?: string[];
  /** With endDate: switch from "today" to a custom date range (the dashboard's Date range). */
  startDate?: string;
  endDate?: string;
  /** Range only: drop Saturday/Sunday routes from every number. */
  skipWeekends?: boolean;
}

export interface AppliedFilters {
  technicians: Array<{ id: string; name: string }>;
  routeGroups: string[];
  routeTemplates: string[];
  subscriptionTypes: string[];
  stopTypes: string[];
  dateRange: { from: string; to: string; skipWeekends: boolean } | null;
}

export interface DashboardState {
  today: string;
  bounds: DashboardBounds;
  techs: TechRecord[];
  rawJobs: JobRec[];
  rawRoutes: RouteRec[];
  rangeRoutes: RouteRec[] | null;
  jobsByDocId: Map<string, JobRec>;
  techKeys: Set<string>;
  scopedRoutes: RouteRec[];
  applied: AppliedFilters;
  window: { label: "Today" | "Selected range"; from: string; to: string };
  stats(): DashboardStats;
  drill(): DrillData;
  overdue(): OverdueDrill;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** Resolve free-text filter values against what actually exists, with actionable errors. */
function resolveNames(kind: string, wanted: string[], known: string[], caseSensitive = false): string[] {
  const key = (v: string) => (caseSensitive ? v.trim() : v.trim().toLowerCase());
  const out: string[] = [];
  for (const w of wanted) {
    const hit = known.find((k) => key(k) === key(w));
    if (!hit) {
      const list = known.slice(0, 60).join(", ") + (known.length > 60 ? `, … (${known.length} total)` : "");
      throw new ToolInputError(`Unknown ${kind} "${w}". Valid values: ${list || "(none found)"}. Use get_filter_options to see them all.`);
    }
    if (!out.includes(hit)) out.push(hit);
  }
  return out;
}

function resolveTechnicians(wanted: string[], techs: TechRecord[]): TechRecord[] {
  const out: TechRecord[] = [];
  for (const w of wanted) {
    const q = norm(w);
    const exact = techs.filter((t) =>
      [t.id, t.name, t.employeeId, t.fieldRoutesEmployeeId, t.fieldRoutesTechId].some((k) => norm(k) === q),
    );
    const partial = exact.length ? exact : techs.filter((t) => norm(t.name).includes(q));
    if (partial.length === 0) {
      throw new ToolInputError(
        `Unknown technician "${w}". Known technicians: ${techs.map((t) => t.name).join(", ") || "(none)"}.`,
      );
    }
    if (partial.length > 1) {
      throw new ToolInputError(
        `"${w}" matches several technicians (${partial.map((t) => t.name).join(", ")}). Use a full name or an id.`,
      );
    }
    if (!out.includes(partial[0])) out.push(partial[0]);
  }
  return out;
}

export async function loadDashboardState(ctx: McpContext, f: FilterInput = {}): Promise<DashboardState> {
  const { data, today } = ctx;
  const bounds = computeDashboardBounds(today);

  const hasRange = Boolean(f.startDate || f.endDate);
  if (hasRange) {
    if (!f.startDate || !f.endDate) throw new ToolInputError("Provide both startDate and endDate (YYYY-MM-DD) for a date range.");
    if (!ISO.test(f.startDate) || !ISO.test(f.endDate)) throw new ToolInputError("Dates must be YYYY-MM-DD.");
    if (f.startDate > f.endDate) throw new ToolInputError("startDate must be on or before endDate.");
    if (daysBetween(f.startDate, f.endDate) > MAX_RANGE_DAYS) {
      throw new ToolInputError(`Date range too long (max ${MAX_RANGE_DAYS} days). Split it into smaller ranges.`);
    }
  }

  const [rawJobs, rawRoutes, techs, rangeRoutes] = await Promise.all([
    data.getJobs(),
    data.getRoutes(bounds.trendStart, bounds.weekEnd),
    data.getTechnicians(),
    hasRange ? data.getRoutes(f.startDate as string, f.endDate as string) : Promise.resolve(null),
  ]);

  // ---- resolve the filter bar against real values ----
  const filterTechs = resolveTechnicians(f.technicians ?? [], techs);
  const seenGroups = new Set<string>();
  const seenTemplates = new Set<string>();
  for (const r of [...rawRoutes, ...(rangeRoutes ?? [])]) {
    const g = canonicalRouteGroup(String(r.routeGroupTitle || ""));
    if (g) seenGroups.add(g);
    const t = String(r.routeTemplateTitle || "").trim();
    if (t) seenTemplates.add(t);
  }
  const groups = resolveNames("route group", (f.routeGroups ?? []).map(canonicalRouteGroup), Array.from(seenGroups).sort());
  const templates = resolveNames("route template", f.routeTemplates ?? [], Array.from(seenTemplates).sort());
  const subTypeSet = new Set<string>();
  for (const j of rawJobs) {
    const t = String(j.serviceType || "").trim();
    if (t) subTypeSet.add(t);
  }
  const subTypes = resolveNames("subscription type", f.subscriptionTypes ?? [], Array.from(subTypeSet).sort());
  const stopKinds = (f.stopTypes ?? []).map((k) => k.toLowerCase());
  for (const k of stopKinds) {
    if (!(STOP_TYPES as readonly string[]).includes(k)) {
      throw new ToolInputError(`Unknown stop type "${k}". Valid values: ${STOP_TYPES.join(", ")}.`);
    }
  }

  // ---- the page's pipeline, verbatim ----
  const dateFilterEnabled = hasRange;
  const excludeWeekends = Boolean(f.skipWeekends);
  const techKeys = buildTechKeys(filterTechs.map((t) => t.id), techs);
  const jobsByDocId = buildJobsByDocId(rawJobs);
  const filterRoutes = makeRouteFilter({
    filterGroups: groups, filterTemplates: templates, filterSubTypes: subTypes, filterStopKinds: stopKinds,
    techKeys, jobsByDocId,
  });
  const scopedRoutes = selectScopedRoutes({ dateFilterEnabled, excludeWeekends, rangeRoutes, rawRoutes, filterRoutes, today });

  let stats: DashboardStats | null = null;
  let drill: DrillData | null = null;
  let overdue: OverdueDrill | null = null;

  return {
    today, bounds, techs, rawJobs, rawRoutes, rangeRoutes, jobsByDocId, techKeys, scopedRoutes,
    applied: {
      technicians: filterTechs.map((t) => ({ id: t.id, name: t.name })),
      routeGroups: groups,
      routeTemplates: templates,
      subscriptionTypes: subTypes,
      stopTypes: stopKinds,
      dateRange: hasRange ? { from: f.startDate as string, to: f.endDate as string, skipWeekends: excludeWeekends } : null,
    },
    window: hasRange
      ? { label: "Selected range", from: f.startDate as string, to: f.endDate as string }
      : { label: "Today", from: today, to: today },
    stats() {
      return (stats ??= computeDashboardStats({
        rawRoutes, rawJobs, rangeRoutes, dateFilterEnabled, excludeWeekends, filterRoutes,
        filterGroups: groups, filterTemplates: templates, filterSubTypes: subTypes, filterStopKinds: stopKinds,
        techKeys, bounds, today, scopedRoutes, jobsByDocId,
      }));
    },
    drill() {
      return (drill ??= buildDrillData({ scopedRoutes, jobsByDocId, today }));
    },
    overdue() {
      return (overdue ??= buildOverdueDrill({ rawJobs, today }));
    },
  };
}
