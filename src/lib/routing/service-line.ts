// Service-line classification for routing.
//
// Flex segregates work by service line: General Pest rides the general routes,
// while German Roach (GR), Termite, and Lawn each ride their own certified /
// Specialty routes (and Mosquito, Commercial, and Wildlife carry their own
// intervals). (Sensei: Routing & Scheduling v1 "Map View" Exclude list; v2
// "Route Filling"; v2 Bi-Weekly Job Pool Audit interval table.)
//
// The line is derived from the FieldRoutes serviceType label, with the route-group
// title (when known) as a fallback. Detection is keyword-based and intentionally
// loose so spelling/casing variants still bucket correctly — same philosophy as
// canonicalRouteGroup in src/lib/route-groups.ts.

import { canonicalRouteGroup } from "@/lib/route-groups";

export type ServiceLine =
  | "general"
  | "gr"
  | "termite"
  | "lawn"
  | "mosquito"
  | "commercial"
  | "wildlife";

export interface ServiceLineMeta {
  /** Rides its own certified/specialty route — excluded from general pest routes. */
  requiresOwnRoute: boolean;
  /** Fallback service interval (days) when the subscription frequency is missing. */
  defaultIntervalDays: number;
  /** Days before the hard deadline to start flagging the stop as urgent. */
  flagLeadDays: number;
  /** Seasonal line (serviced only in-season). Mosquito/outdoor = Apr–Sep. */
  seasonal: boolean;
}

// Per-line metadata sourced from the v2 Bi-Weekly Job Pool Audit interval table.
export const SERVICE_LINE_META: Record<ServiceLine, ServiceLineMeta> = {
  general:    { requiresOwnRoute: false, defaultIntervalDays: 30,  flagLeadDays: 14, seasonal: false },
  gr:         { requiresOwnRoute: true,  defaultIntervalDays: 14,  flagLeadDays: 3,  seasonal: false },
  termite:    { requiresOwnRoute: true,  defaultIntervalDays: 365, flagLeadDays: 60, seasonal: false },
  lawn:       { requiresOwnRoute: true,  defaultIntervalDays: 42,  flagLeadDays: 7,  seasonal: false },
  mosquito:   { requiresOwnRoute: false, defaultIntervalDays: 30,  flagLeadDays: 5,  seasonal: true  },
  commercial: { requiresOwnRoute: false, defaultIntervalDays: 90,  flagLeadDays: 14, seasonal: false },
  wildlife:   { requiresOwnRoute: true,  defaultIntervalDays: 30,  flagLeadDays: 14, seasonal: false },
};

// Ordered keyword rules over a normalized (lowercased, non-alphanumeric stripped)
// serviceType string. First match wins; order matters (termite/GR before general).
const RULES: Array<{ line: ServiceLine; test: (n: string) => boolean }> = [
  { line: "termite",    test: (n) => n.includes("termit") },
  { line: "gr",         test: (n) => n.includes("germanroach") || n === "gr" || n.startsWith("grroach") },
  { line: "lawn",       test: (n) => n.includes("lawn") },
  { line: "mosquito",   test: (n) => n.includes("mosquit") || n.includes("boatdock") || n.includes("outdoorpackage") || n.includes("odp") || n.includes("outdoor") },
  { line: "wildlife",   test: (n) => n.includes("wild") },
  { line: "commercial", test: (n) => n.includes("commercial") || n.includes("gpc") || n.startsWith("comm") || n === "wei" },
];

// Canonical route-group → service line, used only as a fallback when the
// serviceType label alone doesn't match a keyword. (Specialty is intentionally
// omitted — it carries mixed work, so we don't force a line from it.)
const GROUP_TO_LINE: Record<string, ServiceLine> = {
  Termite: "termite",
  Lawn: "lawn",
  Mosquito: "mosquito",
  Wildlife: "wildlife",
  GPC: "commercial",
};

function normalize(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Classify a stop's service line from its serviceType label, falling back to the
 * route-group title when the label doesn't match a known keyword. Defaults to
 * "general" (general pest) when nothing matches.
 */
export function deriveServiceLine(serviceType: unknown, routeGroupTitle?: unknown): ServiceLine {
  const n = normalize(serviceType);
  if (n) {
    for (const r of RULES) {
      if (r.test(n)) return r.line;
    }
  }
  const group = canonicalRouteGroup(String(routeGroupTitle ?? ""));
  if (group && GROUP_TO_LINE[group]) return GROUP_TO_LINE[group];
  return "general";
}

export function serviceLineMeta(line: ServiceLine): ServiceLineMeta {
  return SERVICE_LINE_META[line] ?? SERVICE_LINE_META.general;
}
