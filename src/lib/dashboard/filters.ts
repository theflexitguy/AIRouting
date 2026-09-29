// Extracted VERBATIM from src/app/(dashboard)/dashboard/page.tsx so the dashboard and the
// MCP server compute every number with the same code. Do not fork the logic — change it here.

import { canonicalRouteGroup } from "@/lib/route-groups";
import { calculateStopProductionValue } from "@/lib/production-value";
import type { JobRec, RouteRec, RouteStopDetail, TechOption } from "./types.ts";

export const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

// Stop Type filter: a route mixes regular services, initials (a new signup's
// first visit) and reservices (a return trip, booked with no subscription
// behind it). FieldRoutes files all three under the same subscription service
// type, so this is the only way to separate them.
export const STOP_KIND_OPTIONS = [
  { value: "regular", label: "Regular Stops" },
  { value: "initial", label: "Initials" },
  { value: "reservice", label: "Reservices" },
];
export const stopKindOf = (v: unknown) => {
  const k = norm(v);
  return k === "initial" || k === "reservice" ? k : "regular";
};

/** Saturday/Sunday check for a YYYY-MM-DD date string. */
export const isWeekendISO = (iso: string) => {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

// Does a route belong to the selected technician? Routes carry techId/techName;
// match against any of the tech's known identifiers.
export function routeMatchesTech(r: RouteRec, keys: Set<string>): boolean {
  if (keys.size === 0) return true;
  return [r.techId, r.techName].map(norm).filter(Boolean).some((k) => keys.has(k));
}

/** Identifier set for the selected technicians — a route/job matching ANY of them passes. */
export function buildTechKeys(filterTechs: string[], techs: TechOption[]): Set<string> {
  const keys = new Set<string>();
  for (const id of filterTechs) {
    const t = techs.find(x => x.id === id);
    for (const k of [t?.id, t?.name, t?.employeeId, t?.fieldRoutesEmployeeId, t?.fieldRoutesTechId]) {
      const v = norm(k);
      if (v) keys.add(v);
    }
  }
  return keys;
}

/** Join route stopSequence ids (sub_<subscriptionId> / appt_<id>) back to job docs. */
export function buildJobsByDocId(rawJobs: JobRec[]): Map<string, JobRec> {
  const m = new Map<string, JobRec>();
  for (const j of rawJobs) if (j.docId) m.set(j.docId, j);
  return m;
}

export interface RouteFilterInput {
  filterGroups: string[];
  filterTemplates: string[];
  filterSubTypes: string[];
  filterStopKinds: string[];
  techKeys: Set<string>;
  jobsByDocId: Map<string, JobRec>;
}

/**
 * Apply technician + route-group + route-template + subscription-type + stop-type
 * filters to a set of routes. Each filter is a multi-select: empty = all, otherwise
 * match ANY selection. Tech/group/template include or exclude WHOLE routes;
 * subscription type and stop type are STOP-level — each route is rewritten to just
 * its matching stops so every downstream metric reads the rewritten numbers.
 */
export function makeRouteFilter(input: RouteFilterInput) {
  const { filterGroups, filterTemplates, filterSubTypes, filterStopKinds, techKeys, jobsByDocId } = input;
  const stopLevelActive = filterSubTypes.length > 0 || filterStopKinds.length > 0;
  const stopMatches = (id: string, detail: RouteStopDetail | undefined) => {
    if (filterSubTypes.length > 0) {
      // The job doc is the authority on the subscription's type; the stop
      // detail covers stops with no job doc (stand-alone reservices, and
      // subscriptions whose doc was purged after a one-time completed).
      const t = String(jobsByDocId.get(id)?.serviceType || detail?.serviceType || "").trim();
      if (t === "" || !filterSubTypes.includes(t)) return false;
    }
    if (filterStopKinds.length > 0) {
      const kind = detail?.kind !== undefined
        ? stopKindOf(detail.kind)
        : stopKindOf(jobsByDocId.get(id)?.fieldRoutesStopKind);
      if (!filterStopKinds.includes(kind)) return false;
    }
    return true;
  };
  return (routes: RouteRec[]) => {
    const base = routes.filter(r => {
      // A route with no stops is a phantom (its underlying job docs were purged
      // out from under it) — never count or display it as a route.
      if ((r.totalStops || 0) <= 0) return false;
      // Match on the canonical bucket so every FieldRoutes spelling variant of a
      // group (GPC/gpc, Wildlife/WILD LIFE, …) is included under one selection.
      if (filterGroups.length > 0 && !filterGroups.includes(canonicalRouteGroup(String(r.routeGroupTitle || "")))) return false;
      if (filterTemplates.length > 0 && !filterTemplates.includes(String(r.routeTemplateTitle || "").trim())) return false;
      if (!routeMatchesTech(r, techKeys)) return false;
      return true;
    });
    if (!stopLevelActive) return base;
    const rewritten: RouteRec[] = [];
    for (const r of base) {
      const seq = Array.isArray(r.stopSequence) ? r.stopSequence.map(String) : [];
      const allById = new Map((Array.isArray(r.stops) ? r.stops : []).map(s => [String(s.id), s]));
      const keep = seq.filter(id => stopMatches(id, allById.get(id)));
      if (keep.length === 0) continue;
      const keepSet = new Set(keep);
      const detail = (Array.isArray(r.stops) ? r.stops : []).filter(s => keepSet.has(String(s.id)));
      const detailById = new Map(detail.map(s => [String(s.id), s]));
      // Per-stop value: the reconcile-stamped stop value, falling back to the
      // job's production value for docs that predate the stops detail.
      const routeValue = keep.reduce((sum, id) => {
        const d = detailById.get(id);
        if (d && Number.isFinite(Number(d.value))) return sum + Number(d.value);
        const j = jobsByDocId.get(id);
        return sum + (j ? calculateStopProductionValue(j).value || 0 : 0);
      }, 0);
      const totalServiceMinutes = keep.reduce(
        (sum, id) => sum + (Number(jobsByDocId.get(id)?.duration) || 25), 0
      );
      rewritten.push({
        ...r,
        stopSequence: keep,
        stops: detail,
        totalStops: keep.length,
        completedStops: detail.filter(s => s.completed).length,
        routeValue,
        totalServiceMinutes,
        // Drive time stays the whole route's (a drive isn't attributable to a
        // single stop); work minutes pair it with the filtered service time.
        totalWorkMinutes: (Number(r.totalDriveTimeMinutes) || 0) + totalServiceMinutes,
      });
    }
    return rewritten;
  };
}
export type RouteFilter = ReturnType<typeof makeRouteFilter>;

export interface ScopedRoutesInput {
  dateFilterEnabled: boolean;
  excludeWeekends: boolean;
  rangeRoutes: RouteRec[] | null;
  rawRoutes: RouteRec[];
  filterRoutes: RouteFilter;
  today: string;
}

/** Route set behind the "Today" cards: the custom range when enabled, else today's routes. */
export function selectScopedRoutes(input: ScopedRoutesInput): RouteRec[] {
  const { dateFilterEnabled, excludeWeekends, rangeRoutes, rawRoutes, filterRoutes, today } = input;
  const rangeSet = dateFilterEnabled
    ? (excludeWeekends ? (rangeRoutes ?? []).filter(r => !isWeekendISO(String(r.date))) : (rangeRoutes ?? []))
    : null;
  return filterRoutes(rangeSet ?? rawRoutes.filter(r => r.date === today));
}
