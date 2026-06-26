// Canonical route-group bucketing.
//
// FieldRoutes spawns a brand-new route group for every spelling/casing variant
// ("GPC" vs "gpc", "Wildlife" vs "WILD LIFE" vs "wildlife catch ups",
// "Specialty" vs "Specailty" vs "specality"). For the dashboard we fold those
// variants into a single logical group by keyword, so the owner selects one
// bucket instead of a dozen near-duplicates, and any new variant FieldRoutes
// invents later is matched automatically.

// Ordered keyword rules. The normalized title (lowercased, non-alphanumerics
// stripped — so "WILD LIFE" → "wildlife") is tested against each `key`
// substring; first match wins. Keys are intentionally short/loose so common
// misspellings still bucket correctly (e.g. "spec" catches "specailty").
const RULES: Array<{ canonical: string; key: string }> = [
  { canonical: "GPC", key: "gpc" },
  { canonical: "Wildlife", key: "wild" },
  { canonical: "Termite", key: "termit" },
  { canonical: "Specialty", key: "spec" },
  { canonical: "Lawn", key: "lawn" },
  { canonical: "Mosquito", key: "mosquit" },
];

/**
 * Map a raw FieldRoutes route-group title to its canonical bucket. Titles that
 * match no rule (e.g. "North Route", "Auto Routes") are returned trimmed as
 * their own bucket so they remain individually selectable.
 */
export function canonicalRouteGroup(title: string): string {
  const raw = String(title ?? "").trim();
  if (!raw) return "";
  const n = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const r of RULES) {
    if (n.includes(r.key)) return r.canonical;
  }
  return raw;
}

/**
 * Group a list of raw titles into canonical buckets, preserving the raw variants
 * for display. Buckets are sorted with known canonicals first, then alphabetically.
 */
export function groupRouteGroupTitles(
  titles: string[],
): Array<{ canonical: string; variants: string[] }> {
  const map = new Map<string, Set<string>>();
  for (const t of titles) {
    const raw = String(t ?? "").trim();
    if (!raw) continue;
    const canonical = canonicalRouteGroup(raw);
    if (!map.has(canonical)) map.set(canonical, new Set());
    map.get(canonical)!.add(raw);
  }
  const known = RULES.map((r) => r.canonical);
  return Array.from(map.entries())
    .map(([canonical, variants]) => ({
      canonical,
      variants: Array.from(variants).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => {
      const ai = known.indexOf(a.canonical);
      const bi = known.indexOf(b.canonical);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.canonical.localeCompare(b.canonical);
    });
}
