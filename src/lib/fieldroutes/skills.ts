// FieldRoutes Skills extraction — adaptive, not hardcoded to one field name.
//
// FieldRoutes' Skills feature assigns skills to technicians (e.g. "Termite",
// "Wildlife", "WI-I") and required skills to service types (e.g. the Wildlife
// Exclusion service type requires the Wildlife skill). The exact field name(s)
// FieldRoutes uses to carry this on the employee/serviceType entities hasn't
// been confirmed against live data (see /api/fieldroutes/debug-skills), so
// rather than hardcode a guess that could silently miss the real field (and
// break skill-aware routing without anyone noticing), every entity is scanned
// for ANY key that looks skill-related and every plausible value shape
// (array, comma/semicolon list, nested {name,id} object, plain scalar) is
// normalized into a flat list of refs. This is intentionally permissive: a
// false-positive key just adds a harmless extra "skill" string; a missed key
// just means that skill doesn't show up yet (safe default — Phase 2 routing
// must be a deliberate follow-up before this gates an actual assignment).

const isSkillKey = (key: string): boolean => /skill/i.test(key);

function collectRefs(value: unknown, out: Set<string>): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, out);
    return;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const label = obj.name ?? obj.skillName ?? obj.description ?? obj.title ?? obj.skillID ?? obj.id ?? obj.skillId;
    if (label !== undefined) collectRefs(label, out);
    return;
  }
  const s = String(value).trim();
  if (!s || s === "0") return;
  if (s.includes(",") || s.includes(";")) {
    for (const part of s.split(/[,;]/)) {
      const t = part.trim();
      if (t && t !== "0") out.add(t);
    }
    return;
  }
  out.add(s);
}

/** Scan an entity for every skill-ish field and flatten the values into refs (IDs or names, whichever FieldRoutes stores). */
export function extractSkillRefs(entity: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const [key, value] of Object.entries(entity)) {
    if (isSkillKey(key)) collectRefs(value, out);
  }
  return Array.from(out);
}

/**
 * Best-effort skillID -> name catalog from a dedicated `skill` module, when
 * FieldRoutes exposes one. Returns an empty map (not an error) when it doesn't —
 * callers then use the raw refs as-is, which is correct when skill fields
 * already carry human-readable labels directly on the entity.
 */
export async function buildSkillCatalog(
  client: { searchWithData: (module: string, filters?: Record<string, unknown>) => Promise<Record<string, unknown>[]> },
): Promise<Map<string, string>> {
  const catalog = new Map<string, string>();
  try {
    const rows = await client.searchWithData("skill");
    for (const r of rows) {
      const id = String(r.skillID ?? r.id ?? r.skillId ?? "").trim();
      const name = String(r.name ?? r.description ?? r.title ?? "").trim();
      if (id && name) catalog.set(id, name);
    }
  } catch {
    // No dedicated skill catalog endpoint — fine, refs are used as-is.
  }
  return catalog;
}

/** Resolve refs (IDs or already-human-readable labels) to display names, deduped + sorted. */
export function resolveSkillNames(refs: string[], catalog: Map<string, string>): string[] {
  const names = refs.map((r) => catalog.get(r) || r);
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}
