/**
 * Generate selection helpers (Office 101 + Routing v2).
 *
 * Preferred tech, skills, weekday priority, GPC vs specialty segregation,
 * and day-fill toward 14–16 stops. Pure functions — no Google, no Firestore.
 *
 * Does not change Jobs-tab queries or dashboard metrics.
 */

import { parseSchedulingRequest, CRITICAL_CLASSES } from "../scheduling-constraints.ts";
import {
  SENSAI_TARGET_STOPS_MIN,
  SHARED_GENERATE_ROUTE_CLASS,
  generateRouteClass,
  weekdayLabelForIsoDate,
} from "./drive-time-honesty.ts";

type ServiceLine =
  | "general"
  | "gr"
  | "termite"
  | "lawn"
  | "mosquito"
  | "commercial"
  | "wildlife";

export const SHARED_ROUTE_CLASS = SHARED_GENERATE_ROUTE_CLASS;

const VALID_SERVICE_LINES = new Set<ServiceLine>([
  "general",
  "gr",
  "termite",
  "lawn",
  "mosquito",
  "commercial",
  "wildlife",
]);

const WEEKDAY_TOKEN_TO_LABEL: Record<string, string> = {
  sun: "SUN",
  sunday: "SUN",
  sundays: "SUN",
  mon: "MON",
  monday: "MON",
  mondays: "MON",
  tue: "TUE",
  tues: "TUE",
  tuesday: "TUE",
  tuesdays: "TUE",
  wed: "WED",
  weds: "WED",
  wednesday: "WED",
  wednesdays: "WED",
  thu: "THU",
  thur: "THU",
  thurs: "THU",
  thursday: "THU",
  thursdays: "THU",
  fri: "FRI",
  friday: "FRI",
  fridays: "FRI",
  sat: "SAT",
  saturday: "SAT",
  saturdays: "SAT",
};

export type GenerateExceptionKind =
  | "skill_blocked"
  | "preferred_tech_spill"
  | "preferred_tech_missing"
  | "preferred_day_conflict"
  | "specialty_review";

export interface GenerateException {
  kind: GenerateExceptionKind;
  jobId: string;
  customerName: string;
  reason: string;
  requiredSkills?: string[];
  preferredTech?: string;
  spilledToTech?: string;
}

export type SelectionJob = {
  docId: string;
  customerName?: string;
  scheduledDate?: string;
  serviceType?: string;
  serviceLine?: string;
  requiredSkills?: unknown;
  assignedTechId?: string;
  fieldRoutesServicedBy?: string;
  fieldRoutesServicedById?: string;
  preferredTech?: string;
  schedulingRequest?: string;
  overdueActionable?: boolean;
};

export type SelectionTech = {
  id: string;
  name?: unknown;
  employeeId?: unknown;
  fieldRoutesEmployeeId?: unknown;
  fieldRoutesTechId?: unknown;
  skillNames?: unknown;
};

export function normalizeName(s: string) {
  return s
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function techMatchTokens(tech: SelectionTech) {
  return [
    String(tech.id || "").trim(),
    String(tech.name || "").trim(),
    String(tech.employeeId || "").trim(),
    String(tech.fieldRoutesEmployeeId || "").trim(),
    String(tech.fieldRoutesTechId || "").trim(),
  ].filter(Boolean);
}

export function jobHasExplicitAssignment(job: SelectionJob) {
  return [job.assignedTechId, job.fieldRoutesServicedBy, job.fieldRoutesServicedById].some(
    (value) => String(value || "").trim().length > 0,
  );
}

export function jobAssignedToTech(job: SelectionJob, tech: SelectionTech) {
  const assignedValues = [
    job.assignedTechId,
    job.fieldRoutesServicedBy,
    job.fieldRoutesServicedById,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (assignedValues.length === 0) return true;

  const tokens = techMatchTokens(tech);
  return assignedValues.some((assigned) => {
    const assignedNormalized = normalizeName(assigned);
    return tokens.some((token) => token === assigned || normalizeName(token) === assignedNormalized);
  });
}

export function techIsPreferredForJob(job: SelectionJob, tech: SelectionTech) {
  const preferred = String(job.preferredTech || "").trim();
  if (!preferred) return false;
  const normalizedPreferred = normalizeName(preferred);
  return techMatchTokens(tech).some(
    (token) => token === preferred || normalizeName(token) === normalizedPreferred,
  );
}

export function jobHasPreferredOrAssigned(job: SelectionJob) {
  return jobHasExplicitAssignment(job) || String(job.preferredTech || "").trim().length > 0;
}

/** Assigned tech if present in the roster; otherwise preferred tech if present. */
export function homeTechForJob<T extends SelectionTech>(job: SelectionJob, techs: T[]): T | null {
  if (jobHasExplicitAssignment(job)) {
    const assigned = techs.find((tech) => jobAssignedToTech(job, tech));
    if (assigned) return assigned;
  }
  return techs.find((tech) => techIsPreferredForJob(job, tech)) || null;
}

export function techSkillSet(tech: SelectionTech): Set<string> {
  const raw = Array.isArray(tech.skillNames) ? (tech.skillNames as unknown[]) : [];
  return new Set(raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean));
}

export function jobRequiredSkills(job: SelectionJob): string[] {
  const raw = Array.isArray(job.requiredSkills) ? (job.requiredSkills as unknown[]) : [];
  return raw.map((s) => String(s).trim()).filter(Boolean);
}

export function techHasRequiredSkills(tech: SelectionTech, job: SelectionJob): boolean {
  const required = jobRequiredSkills(job);
  if (required.length === 0) return true;
  const skills = techSkillSet(tech);
  return required.every((skill) => skills.has(skill.toLowerCase()));
}

export function jobServiceLine(job: SelectionJob): ServiceLine {
  const stored = String(job.serviceLine || "").trim().toLowerCase();
  if (VALID_SERVICE_LINES.has(stored as ServiceLine)) return stored as ServiceLine;
  const n = String(job.serviceType || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (n.includes("termit")) return "termite";
  if (n.includes("germanroach") || n === "gr" || n.startsWith("grroach")) return "gr";
  if (
    n.includes("lawn") ||
    /^round\d/.test(n) ||
    n.includes("emergent") ||
    n.includes("fertiliz") ||
    n.includes("weedcontrol") ||
    n.includes("winteriz")
  ) {
    return "lawn";
  }
  if (n.includes("mosquit") || n.includes("boatdock") || n.includes("outdoor")) return "mosquito";
  if (n.includes("wild")) return "wildlife";
  if (n.includes("commercial") || n.startsWith("comm") || n === "wei") return "commercial";
  return "general";
}

/**
 * Route class: general + mosquito share GPC-style days. Specialty
 * (termite / GR / bed bugs / commercial / wildlife / lawn) never mix onto those.
 */
export function routeClassOf(job: SelectionJob): string {
  return generateRouteClass({
    serviceType: job.serviceType,
    serviceLine: jobServiceLine(job),
  });
}

export function isSpecialtyRouteClass(routeClass: string): boolean {
  return routeClass !== SHARED_ROUTE_CLASS;
}

export function classesCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  return a === SHARED_ROUTE_CLASS && b === SHARED_ROUTE_CLASS;
}

export function unitCompatibleWithSlotJobs(unitJobsArr: SelectionJob[], slotJobs: SelectionJob[]): boolean {
  const classes = new Set<string>();
  for (const job of unitJobsArr) classes.add(routeClassOf(job));
  for (const job of slotJobs) classes.add(routeClassOf(job));
  if (classes.size <= 1) return true;
  return Array.from(classes).every((cls) => cls === SHARED_ROUTE_CLASS);
}

function weekdaySet(value: string) {
  return new Set(
    value
      .split(",")
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean),
  );
}

function weekdaysMentionedInText(text: string): Set<string> {
  const out = new Set<string>();
  const matches = String(text || "")
    .toLowerCase()
    .match(/\b[a-z]{3,10}\b/g) || [];
  for (const token of matches) {
    const label = WEEKDAY_TOKEN_TO_LABEL[token];
    if (label) out.add(label);
  }
  return out;
}

/** Preferred / required weekdays from the scheduling request (hard or soft). */
export function jobPreferredWeekdays(job: SelectionJob): Set<string> {
  const parsed = parseSchedulingRequest(String(job.schedulingRequest || ""));
  const allowed = weekdaySet(parsed.schedulingAllowedWeekdays);
  if (allowed.size > 0) return allowed;
  if (
    parsed.schedulingRequestClass === "SOFT_WEEKDAY_PREFERENCE" ||
    parsed.schedulingRequestClass === "HARD_WEEKDAY_ONLY"
  ) {
    return weekdaysMentionedInText(parsed.schedulingRequestRaw);
  }
  return weekdaysMentionedInText(parsed.schedulingRequestRaw);
}

export function jobHasPreferredWeekday(job: SelectionJob): boolean {
  return jobPreferredWeekdays(job).size > 0;
}

export function jobMatchesPreferredWeekday(job: SelectionJob, slotDate: string): boolean {
  const preferred = jobPreferredWeekdays(job);
  if (preferred.size === 0) return false;
  const weekday = weekdayLabelForIsoDate(slotDate);
  return Boolean(weekday) && preferred.has(weekday);
}

export function jobScheduleBlockReason(job: SelectionJob, slotDate: string): string {
  const parsed = parseSchedulingRequest(String(job.schedulingRequest || ""));
  if (!parsed.schedulingRequestClass) return "";

  if (CRITICAL_CLASSES.has(parsed.schedulingRequestClass)) {
    return parsed.schedulingConstraintNote || parsed.schedulingRequestClass;
  }

  const weekday = weekdayLabelForIsoDate(slotDate);
  const allowed = weekdaySet(parsed.schedulingAllowedWeekdays);
  if (allowed.size > 0 && !allowed.has(weekday)) {
    return `requires ${parsed.schedulingAllowedWeekdays}`;
  }

  const blocked = weekdaySet(parsed.schedulingBlockedWeekdays);
  if (blocked.has(weekday)) {
    return `no ${weekday}`;
  }

  return "";
}

export function canScheduleJobOnDate(job: SelectionJob, slotDate: string): boolean {
  return !jobScheduleBlockReason(job, slotDate);
}

export function compareJobsForGenerate(
  a: SelectionJob,
  b: SelectionJob,
  opts: { slotDate?: string; poolBehind?: boolean } = {},
): number {
  if (opts.slotDate) {
    const matchA = jobMatchesPreferredWeekday(a, opts.slotDate) ? 0 : 1;
    const matchB = jobMatchesPreferredWeekday(b, opts.slotDate) ? 0 : 1;
    if (matchA !== matchB) return matchA - matchB;
  }

  const overdueA = a.overdueActionable === true ? 0 : 1;
  const overdueB = b.overdueActionable === true ? 0 : 1;
  if (overdueA !== overdueB) return overdueA - overdueB;

  const dateA = String(a.scheduledDate || (opts.poolBehind || overdueA === 0 ? "9999-12-31" : ""));
  const dateB = String(b.scheduledDate || (opts.poolBehind || overdueB === 0 ? "9999-12-31" : ""));
  if (opts.poolBehind || overdueA === 0 || overdueB === 0) {
    const dateDiff = dateA.localeCompare(dateB);
    if (dateDiff !== 0) return dateDiff;
  } else if (dateA && dateB) {
    const dateDiff = dateA.localeCompare(dateB);
    if (dateDiff !== 0) return dateDiff;
  }

  return String(a.customerName || a.docId).localeCompare(String(b.customerName || b.docId));
}

export function exceptionForJob(
  kind: GenerateExceptionKind,
  job: SelectionJob,
  reason: string,
  extra: Partial<GenerateException> = {},
): GenerateException {
  return {
    kind,
    jobId: job.docId,
    customerName: String(job.customerName || job.docId),
    reason,
    requiredSkills: jobRequiredSkills(job),
    preferredTech: String(job.preferredTech || "").trim() || undefined,
    ...extra,
  };
}

export type TechPlacement =
  | {
      kind: "place";
      techId: string;
      spill?: GenerateException;
    }
  | {
      kind: "skill_blocked";
      exception: GenerateException;
    };

function pickNearestTech<T extends SelectionTech>(
  candidates: T[],
  loadByTechId: Map<string, number>,
  nearestDriveMinutes: (techId: string) => number,
): T | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const tech of candidates) {
    const load = loadByTechId.get(tech.id) || 0;
    const score = nearestDriveMinutes(tech.id) + load * 4;
    if (score < bestScore) {
      bestScore = score;
      best = tech;
    }
  }
  return best;
}

/**
 * Place a job: stay on preferred/assigned tech unless skills or capacity block.
 * Never place on a tech missing required skills.
 */
export function placeJobOnTech<T extends SelectionTech>(opts: {
  job: SelectionJob;
  techs: T[];
  loadByTechId: Map<string, number>;
  perTechCapacity: number;
  nearestDriveMinutes: (techId: string) => number;
}): TechPlacement {
  const { job, techs, loadByTechId, perTechCapacity, nearestDriveMinutes } = opts;
  const qualified = techs.filter((tech) => techHasRequiredSkills(tech, job));
  const required = jobRequiredSkills(job);
  const skillsLabel = required.length > 0 ? required.join(", ") : "required skills";

  if (qualified.length === 0) {
    return {
      kind: "skill_blocked",
      exception: exceptionForJob(
        "skill_blocked",
        job,
        `requires skill(s) ${skillsLabel} — no selected technician has them`,
      ),
    };
  }

  const withRoom = (pool: T[]) =>
    pool.filter((tech) => (loadByTechId.get(tech.id) || 0) < perTechCapacity);

  const home = homeTechForJob(job, techs);
  if (jobHasPreferredOrAssigned(job) && !home) {
    const spillPool = withRoom(qualified).length > 0 ? withRoom(qualified) : qualified;
    const best = pickNearestTech(spillPool, loadByTechId, nearestDriveMinutes);
    if (!best) {
      return {
        kind: "skill_blocked",
        exception: exceptionForJob(
          "skill_blocked",
          job,
          `requires skill(s) ${skillsLabel} — no selected technician has them`,
        ),
      };
    }
    return {
      kind: "place",
      techId: best.id,
      spill: exceptionForJob(
        "preferred_tech_missing",
        job,
        `preferred/assigned tech is not in the selected roster — placed with nearest skilled tech ${String(best.name || best.id)}`,
        { spilledToTech: String(best.name || best.id) },
      ),
    };
  }

  if (home) {
    const homeQualified = techHasRequiredSkills(home, job);
    const homeLoad = loadByTechId.get(home.id) || 0;
    const homeHasRoom = homeLoad < perTechCapacity;
    if (homeQualified && homeHasRoom) {
      return { kind: "place", techId: home.id };
    }

    const spillPool = withRoom(qualified.filter((tech) => tech.id !== home.id));
    const candidates = spillPool.length > 0 ? spillPool : qualified.filter((tech) => tech.id !== home.id);
    const best = pickNearestTech(candidates.length > 0 ? candidates : qualified, loadByTechId, nearestDriveMinutes);
    if (!best) {
      return {
        kind: "skill_blocked",
        exception: exceptionForJob(
          "skill_blocked",
          job,
          `requires skill(s) ${skillsLabel} — no selected technician has them`,
        ),
      };
    }
    if (best.id === home.id && homeQualified) {
      return { kind: "place", techId: home.id };
    }
    const reason = !homeQualified
      ? `preferred/assigned ${String(home.name || home.id)} missing skill(s) ${skillsLabel} — spilled to nearest skilled tech ${String(best.name || best.id)}`
      : `preferred/assigned ${String(home.name || home.id)} at capacity (${homeLoad}/${perTechCapacity}) — spilled to nearest skilled tech ${String(best.name || best.id)}`;
    return {
      kind: "place",
      techId: best.id,
      spill: exceptionForJob("preferred_tech_spill", job, reason, {
        spilledToTech: String(best.name || best.id),
        preferredTech: String(job.preferredTech || home.name || home.id),
      }),
    };
  }

  const open = withRoom(qualified);
  const candidates = open.length > 0 ? open : qualified;
  const best = pickNearestTech(candidates, loadByTechId, nearestDriveMinutes);
  if (!best) {
    return {
      kind: "skill_blocked",
      exception: exceptionForJob(
        "skill_blocked",
        job,
        `requires skill(s) ${skillsLabel} — no selected technician has them`,
      ),
    };
  }
  return { kind: "place", techId: best.id };
}

/**
 * Pick the day's service class. Prefer GPC/mosquito (shared) when it can fill
 * toward 14–16 stops so specialty leftovers don't create 2-stop underfilled days.
 */
export function pickRouteClassForDay(
  remainingByClass: Map<string, { length: number }>,
  cap: number,
): string {
  const shared = remainingByClass.get(SHARED_ROUTE_CLASS);
  const sharedScore = shared ? Math.min(shared.length, cap) : 0;
  if (sharedScore >= SENSAI_TARGET_STOPS_MIN) return SHARED_ROUTE_CLASS;

  let best = "";
  let bestScore = -1;
  for (const [cls, jobs] of remainingByClass) {
    if (!jobs || jobs.length === 0) continue;
    const score = Math.min(jobs.length, cap);
    if (
      score > bestScore ||
      (score === bestScore && cls === SHARED_ROUTE_CLASS)
    ) {
      bestScore = score;
      best = cls;
    }
  }
  return best;
}

export interface ClassPick {
  tech: string;
  date: string;
  routeClass: string;
  filled: number;
}

export function fillDaysByRouteClass<T extends SelectionJob>(opts: {
  techId: string;
  jobs: T[];
  dates: string[];
  pinnedSlotByJobId: Map<string, string>;
  isProtected: (id: string) => boolean;
  capForDate: (date: string) => number;
  poolBehind: boolean;
}): {
  selected: T[];
  deferred: T[];
  classPicks: ClassPick[];
  exceptions: GenerateException[];
} {
  const { techId, jobs, dates, pinnedSlotByJobId, isProtected, capForDate, poolBehind } = opts;
  const pinned = jobs.filter((job) => isProtected(job.docId));
  const unpinned = jobs.filter((job) => !isProtected(job.docId));
  const taken: T[] = [];
  const takenIds = new Set<string>();
  const classPicks: ClassPick[] = [];

  for (const routeDate of dates) {
    const cap = capForDate(routeDate);
    const pinnedToday = pinned.filter((job) =>
      String(pinnedSlotByJobId.get(job.docId) || "").startsWith(`${routeDate}::`),
    );

    let dayClass = "";
    for (const job of pinnedToday) {
      const cls = routeClassOf(job);
      if (cls !== SHARED_ROUTE_CLASS) {
        dayClass = cls;
        break;
      }
    }
    if (!dayClass && pinnedToday.length > 0) dayClass = SHARED_ROUTE_CLASS;

    const remainingByClass = new Map<string, T[]>();
    for (const job of unpinned) {
      if (takenIds.has(job.docId)) continue;
      if (!canScheduleJobOnDate(job, routeDate)) continue;
      const key = routeClassOf(job);
      if (!remainingByClass.has(key)) remainingByClass.set(key, []);
      remainingByClass.get(key)!.push(job);
    }
    for (const list of remainingByClass.values()) {
      list.sort((a, b) => compareJobsForGenerate(a, b, { slotDate: routeDate, poolBehind }));
    }

    if (!dayClass) {
      dayClass = pickRouteClassForDay(remainingByClass, cap);
    }
    if (!dayClass) continue;

    let room = Math.max(0, cap - pinnedToday.length);
    const beforeRoom = room;
    for (const job of remainingByClass.get(dayClass) || []) {
      if (room <= 0) break;
      if (takenIds.has(job.docId)) continue;
      taken.push(job);
      takenIds.add(job.docId);
      room--;
    }
    classPicks.push({
      tech: techId,
      date: routeDate,
      routeClass: dayClass,
      filled: beforeRoom - room + pinnedToday.length,
    });
  }

  const deferred = unpinned.filter((job) => !takenIds.has(job.docId));
  const exceptions: GenerateException[] = [];
  for (const job of deferred) {
    const anyOpenDay = dates.some((date) => canScheduleJobOnDate(job, date));
    if (!anyOpenDay && jobHasPreferredWeekday(job)) {
      const days = Array.from(jobPreferredWeekdays(job)).join(", ") || "preferred weekday";
      exceptions.push(
        exceptionForJob(
          "preferred_day_conflict",
          job,
          `preferred day ${days} does not match ${dates.join(", ") || "the generate window"}`,
        ),
      );
      continue;
    }
    if (isSpecialtyRouteClass(routeClassOf(job))) {
      exceptions.push(
        exceptionForJob(
          "specialty_review",
          job,
          `${routeClassOf(job)} stays off GPC/mosquito shared routes — left for a specialty day / human queue`,
        ),
      );
    }
  }

  return {
    selected: [...pinned, ...taken],
    deferred,
    classPicks,
    exceptions,
  };
}

export const GENERATE_EXCEPTION_LABELS: Record<GenerateExceptionKind, string> = {
  skill_blocked: "Skill-blocked",
  preferred_tech_spill: "Preferred tech spill",
  preferred_tech_missing: "Preferred tech not selected",
  preferred_day_conflict: "Preferred-day conflict",
  specialty_review: "Specialty review",
};
