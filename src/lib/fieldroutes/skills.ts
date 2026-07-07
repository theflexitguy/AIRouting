// FieldRoutes Skills extraction — confirmed against live data via
// /api/fieldroutes/debug-skills:
//   - employee.skills: string[] (skillIDs; empty until the office assigns one)
//   - the `skill` module is a real catalog: { skillID, name, serviceIDs[], productIDs[] }
//   - the LINK to service types is on the SKILL record's serviceIDs array
//     (skill -> which service types need it), NOT a field on the service type
//     itself — service type entities carry no skill-ish field at all.
//
// extractSkillRefs() stays adaptive (scans any skill-ish key) so it keeps
// working if FieldRoutes adds a differently-named field later or another
// instance's employee shape differs slightly; the skill-catalog functions
// below encode the confirmed skill -> serviceIDs join direction.

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
    if (label !== undefined) {
      collectRefs(label, out);
      return;
    }
    // No recognized label field. FieldRoutes returns a populated employee.skills
    // as an ID->name MAP ({"3":"Termite"}) — not an array or {skillID,name} object
    // — so collect both the keys (skill IDs, resolvable via the catalog) and the
    // values (already-human names). Empty skills come back as [] and hit the
    // array branch above, never here.
    for (const [k, v] of Object.entries(obj)) {
      collectRefs(k, out);
      collectRefs(v, out);
    }
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

export interface SkillCatalogRow {
  id: string;
  name: string;
  serviceTypeIds: string[]; // FieldRoutes service-type IDs this skill applies to
}

type SearchClient = { searchWithData: (module: string, filters?: Record<string, unknown>) => Promise<Record<string, unknown>[]> };

/** Best-effort full skill catalog: { skillID, name, serviceIDs[] } rows. Empty array if FieldRoutes exposes no `skill` module. */
export async function fetchSkillCatalogRows(client: SearchClient): Promise<SkillCatalogRow[]> {
  try {
    const rows = await client.searchWithData("skill");
    return rows
      .map((r) => ({
        id: String(r.skillID ?? r.id ?? r.skillId ?? "").trim(),
        name: String(r.name ?? r.description ?? r.title ?? "").trim(),
        serviceTypeIds: Array.isArray(r.serviceIDs)
          ? Array.from(new Set((r.serviceIDs as unknown[]).map((v) => String(v).trim()).filter((v) => v && v !== "0")))
          : [],
      }))
      .filter((r) => r.id && r.name);
  } catch {
    return [];
  }
}

/** skillID -> name, from catalog rows. */
export function skillCatalogIdToName(rows: SkillCatalogRow[]): Map<string, string> {
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * normalized service-type description -> required skill names, built from the
 * catalog's skill -> serviceTypeIds linkage. typeIdToDescription maps a
 * FieldRoutes serviceType typeID to its description (the join key the rest of
 * the app already uses between a subscription and its service type).
 */
export function requiredSkillsByServiceTypeDescription(
  rows: SkillCatalogRow[],
  typeIdToDescription: Map<string, string>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const skill of rows) {
    for (const typeId of skill.serviceTypeIds) {
      const description = typeIdToDescription.get(typeId);
      if (!description) continue;
      const key = description.toLowerCase();
      const list = out[key] || (out[key] = []);
      if (!list.includes(skill.name)) list.push(skill.name);
    }
  }
  return out;
}

/** Resolve refs (IDs or already-human-readable labels) to display names, deduped + sorted. */
export function resolveSkillNames(refs: string[], catalog: Map<string, string>): string[] {
  const names = refs.map((r) => catalog.get(r) || r);
  return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
}
