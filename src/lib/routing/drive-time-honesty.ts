/**
 * Drive-time honesty + SensAI routing defaults for the Routes tab.
 *
 * Office 101 Scheduling Logic: ~14–16 stops/day (Bella Vista ~12), max ~60 min
 * TOTAL drive, ~2 stops/hour; Tuesday ~9am start; Saturday half-day; specialty
 * (termite / GR / bed bugs / commercial / wildlife / lawn) off GPC routes;
 * horizon min 2 days, prefer ~1 week, max 2 weeks.
 * Routing v2 ROUTING RHYTHM: slinky = even distribution; no week should carry
 * what two weeks should share.
 *
 * Never treat haversine / straight-line as a real road drive time.
 */

export const SENSAI_TARGET_STOPS_MIN = 14;
export const SENSAI_TARGET_STOPS_MAX = 16;
export const SENSAI_DEFAULT_MAX_STOPS = 16;
export const SENSAI_BELLA_VISTA_STOPS = 12;
export const SENSAI_MAX_DRIVE_MINUTES = 60;
/** Hard generate ceiling — slack above the 16/60 standard, not a 30/600 planner. */
export const SENSAI_HARD_MAX_STOPS = 18;
export const SENSAI_HARD_MAX_DRIVE_MINUTES = 90;
export const SENSAI_MIN_STOPS = 1;
export const SENSAI_MIN_DRIVE_MINUTES = 15;
export const SENSAI_STOPS_PER_HOUR = 2;
export const SENSAI_TUESDAY_STOP_REDUCTION = 3;
export const SENSAI_SATURDAY_STOP_FRACTION = 0.5;
export const SENSAI_HORIZON_MIN_DAYS = 2;
export const SENSAI_HORIZON_PREFER_DAYS = 7;
export const SENSAI_HORIZON_MAX_DAYS = 14;

export const TRUSTED_DRIVE_TIME_SOURCES = new Set([
  "routes_api_polyline",
  "routes_api_matrix",
]);

export type DriveTimeSourceKind = "road" | "estimate";
export type DriveTimeSourceBadgeLabel = "ROAD" | "ESTIMATE";
export type PolylineRenderMode = "road" | "estimate";

export type HorizonLevel = "ok" | "too_soon" | "prefer_week" | "too_far";

export interface HorizonGuidance {
  level: HorizonLevel;
  daysAhead: number | null;
  message: string;
}

const WEEKDAY_LABELS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isTrustedDriveTimeSource(source?: string | null): boolean {
  const normalized = String(source || "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  // Generate can join multiple sources with commas; every token must be trusted.
  return normalized.split(",").every((part) => TRUSTED_DRIVE_TIME_SOURCES.has(part.trim()));
}

export function driveTimeSourceKind(source?: string | null, paused = false): DriveTimeSourceKind {
  return isTrustedDriveTimeSource(displayDriveTimeSource(source, paused)) ? "road" : "estimate";
}

export function driveTimeSourceBadgeLabel(source?: string | null, paused = false): DriveTimeSourceBadgeLabel {
  return driveTimeSourceKind(source, paused) === "road" ? "ROAD" : "ESTIMATE";
}

/** Inline HTML for map / print popups (no React). */
export function driveTimeSourceBadgeHtml(source?: string | null, paused = false): string {
  const label = driveTimeSourceBadgeLabel(source, paused);
  const estimate = label === "ESTIMATE";
  const color = estimate ? "#b45309" : "#047857";
  const bg = estimate ? "#fef3c7" : "#d1fae5";
  return `<span style="display:inline-block;margin-left:4px;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:800;letter-spacing:.04em;color:${color};background:${bg}">${label}</span>`;
}

export function polylineRenderMode(source?: string | null, paused = false): PolylineRenderMode {
  return driveTimeSourceKind(source, paused);
}

export const ESTIMATE_DRIVE_TIME_SOURCE = "haversine_fallback";

/**
 * UI contract: while Google is paused, every displayed drive source is ESTIMATE
 * — including stored routes_api_* values from before the pause.
 */
export function displayDriveTimeSource(source?: string | null, paused = false): string {
  if (paused) return ESTIMATE_DRIVE_TIME_SOURCE;
  const trimmed = String(source || "").trim();
  return trimmed || ESTIMATE_DRIVE_TIME_SOURCE;
}

/**
 * Minutes may be shown as ROAD only when the source is a trusted Routes API
 * token AND Google is not paused. A bare minute count never mints ROAD.
 */
export function trustedRoadMinutes(
  minutes: unknown,
  source?: string | null,
  paused = false,
): number | undefined {
  if (paused) return undefined;
  if (!isTrustedDriveTimeSource(source)) return undefined;
  const n = Number(minutes);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

export function clampGenerateMaxStops(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return SENSAI_DEFAULT_MAX_STOPS;
  return Math.min(SENSAI_HARD_MAX_STOPS, Math.max(SENSAI_MIN_STOPS, n));
}

export function clampGenerateMaxDriveMinutes(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return SENSAI_MAX_DRIVE_MINUTES;
  return Math.min(SENSAI_HARD_MAX_DRIVE_MINUTES, Math.max(SENSAI_MIN_DRIVE_MINUTES, n));
}

export function outsideSensaiStandard(stops: number, driveMinutes: number): boolean {
  return stops > SENSAI_TARGET_STOPS_MAX || driveMinutes > SENSAI_MAX_DRIVE_MINUTES;
}

export const SENSAI_OVERRIDE_WARNING =
  "outside SensAI standard (14–16 stops / 60 min drive)";

export const SHARED_GENERATE_ROUTE_CLASS = "__shared";

/** Generate-only classing — does not change deriveServiceLine / dashboard KPIs. */
export function generateRouteClass(input: {
  serviceType?: string | null;
  serviceLine?: string | null;
}): string {
  if (isBedBugServiceType(input.serviceType)) return "bed_bugs";
  const line = String(input.serviceLine || "").trim().toLowerCase();
  if (line === "commercial") return "commercial";
  if (line === "gr" || line === "termite" || line === "lawn" || line === "wildlife") return line;
  return SHARED_GENERATE_ROUTE_CLASS;
}

export const PAUSED_ROUTING_SUMMARY =
  "Google APIs are PAUSED (GOOGLE_APIS_PAUSED). No billable calls are being made. " +
  "While paused, every Routes drive time, badge, and polyline is ESTIMATE — including " +
  "stored routes_api_* values from before the pause (those minutes may be stale). " +
  "Dashed map lines are stop-to-stop, never fake snapped roads. " +
  "Route generation is refused so we never return a silent haversine success. " +
  "The FieldRoutes sync and the dashboard are unaffected.";

export const UNPAUSED_ROUTING_SUMMARY =
  "Google routing is not paused. Generate uses road drive times when Routes API is available.";

export function routingStatusSummaryPayload(paused: boolean) {
  return {
    paused,
    probed: false as const,
    generateRefused: paused,
    summary: paused ? PAUSED_ROUTING_SUMMARY : UNPAUSED_ROUTING_SUMMARY,
  };
}

export function routingStatusSummaryKeys(): string[] {
  return ["generateRefused", "paused", "probed", "summary"];
}

export function publicRouteGeometryPayload(input: {
  driveTimeSource?: string;
  polylineSource?: string;
  encodedPolyline?: string;
  path?: Array<{ lat: number; lng: number }>;
  driveMinutes: number;
  distanceMeters?: number;
  status: string;
  failedSegments: number;
  warnings?: string[];
  paused: boolean;
}) {
  const displayedSource = displayDriveTimeSource(input.driveTimeSource, input.paused);
  const estimate = driveTimeSourceKind(displayedSource) === "estimate";
  return {
    encodedPolyline: estimate ? undefined : input.encodedPolyline,
    path: estimate ? [] : input.path || [],
    driveMinutes: Math.round(input.driveMinutes * 10) / 10,
    distanceMeters: estimate ? undefined : input.distanceMeters,
    status: input.paused ? "GOOGLE_APIS_PAUSED" : input.status,
    failedSegments: input.failedSegments,
    driveTimeSource: displayedSource,
    polylineSource: displayDriveTimeSource(input.polylineSource, input.paused),
    estimate,
    paused: input.paused,
    warnings: input.warnings,
  };
}

export function weekdayLabelForIsoDate(dateStr: string): string {
  if (!isIsoDate(dateStr)) return "";
  const date = new Date(`${dateStr}T00:00:00Z`);
  return WEEKDAY_LABELS[date.getUTCDay()] || "";
}

export function sensaiMaxStopsForDate(baseMaxStops: number, routeDate: string): number {
  const base = Math.max(1, Math.floor(Number(baseMaxStops)) || SENSAI_DEFAULT_MAX_STOPS);
  const weekday = weekdayLabelForIsoDate(routeDate);
  if (weekday === "TUE") return Math.max(1, base - SENSAI_TUESDAY_STOP_REDUCTION);
  if (weekday === "SAT") return Math.max(1, Math.round(base * SENSAI_SATURDAY_STOP_FRACTION));
  return base;
}

export function daysBetweenIso(from: string, to: string): number | null {
  if (!isIsoDate(from) || !isIsoDate(to)) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** Add (or subtract) whole days on an ISO date using UTC, matching daysBetweenIso. */
export function addDaysIso(iso: string, days: number): string {
  if (!isIsoDate(iso)) return "";
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + days * 86400000).toISOString().slice(0, 10);
}

export function chicagoTodayIso(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

export interface GenerateHorizonDefaults {
  startDate: string;
  endDate: string;
}

/**
 * Default generate window: earliest today+2, prefer targeting ~1 week ahead,
 * never past today+14.
 */
export function defaultGenerateHorizon(today: string): GenerateHorizonDefaults {
  const startDate = addDaysIso(today, SENSAI_HORIZON_MIN_DAYS);
  const preferredEnd = addDaysIso(today, SENSAI_HORIZON_PREFER_DAYS);
  const latest = addDaysIso(today, SENSAI_HORIZON_MAX_DAYS);
  let endDate = preferredEnd || startDate;
  if (latest && endDate > latest) endDate = latest;
  if (startDate && endDate < startDate) endDate = startDate;
  return { startDate, endDate };
}

export interface HorizonValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  startDaysAhead: number | null;
  endDaysAhead: number | null;
}

/**
 * Validate a generate date range against Office 101.
 * Optimize-day (rebalance) skips this — it may target an already-built day.
 */
export function validateGenerateHorizon(
  startDate: string,
  endDate: string,
  today: string,
): HorizonValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const startDaysAhead = daysBetweenIso(today, startDate);
  const endDaysAhead = daysBetweenIso(today, endDate);
  const earliest = addDaysIso(today, SENSAI_HORIZON_MIN_DAYS);
  const latest = addDaysIso(today, SENSAI_HORIZON_MAX_DAYS);

  if (startDaysAhead === null || endDaysAhead === null) {
    errors.push("Generate dates must be YYYY-MM-DD.");
    return { ok: false, errors, warnings, startDaysAhead, endDaysAhead };
  }
  if (startDate > endDate) {
    errors.push("Start date must be on or before end date.");
  }
  if (startDaysAhead < SENSAI_HORIZON_MIN_DAYS) {
    errors.push(
      `Office 101: earliest generate day is ${earliest} (today+${SENSAI_HORIZON_MIN_DAYS}). Routes must be built at least 2 days out.`,
    );
  }
  if (startDaysAhead > SENSAI_HORIZON_MAX_DAYS || endDaysAhead > SENSAI_HORIZON_MAX_DAYS) {
    errors.push(
      `Office 101: don't schedule more than 2 weeks out (latest ${latest}).`,
    );
  }
  if (
    errors.length === 0 &&
    startDaysAhead >= SENSAI_HORIZON_MIN_DAYS &&
    startDaysAhead < 5
  ) {
    warnings.push("Routing v2: aim to stay ~1 week ahead.");
  }
  return { ok: errors.length === 0, errors, warnings, startDaysAhead, endDaysAhead };
}

export function horizonGuidance(startDate: string, today: string): HorizonGuidance {
  const daysAhead = daysBetweenIso(today, startDate);
  if (daysAhead === null) {
    return { level: "ok", daysAhead: null, message: "" };
  }
  if (daysAhead < SENSAI_HORIZON_MIN_DAYS) {
    return {
      level: "too_soon",
      daysAhead,
      message:
        "Office 101: build at least 2 days ahead (lock by midnight two days before service).",
    };
  }
  if (daysAhead > SENSAI_HORIZON_MAX_DAYS) {
    return {
      level: "too_far",
      daysAhead,
      message: "Office 101: don't schedule more than 2 weeks out.",
    };
  }
  if (daysAhead < 5) {
    return {
      level: "prefer_week",
      daysAhead,
      message: "Routing v2: aim to stay ~1 week ahead.",
    };
  }
  return { level: "ok", daysAhead, message: "" };
}

/** ISO week key (YYYY-Www) for a calendar date. Weeks start Monday (ISO-8601). */
export function isoWeekKey(dateStr: string): string {
  if (!isIsoDate(dateStr)) return "";
  const [year, month, day] = dateStr.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const weekday = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - weekday);
  const isoYear = utc.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Soft slinky warning: one week carrying far more stops than the others.
 * Cheap client-side check — no extra API calls.
 */
export function slinkyWeekWarning(stopsByIsoWeek: Record<string, number>): string | null {
  const entries = Object.entries(stopsByIsoWeek).filter(([, n]) => Number(n) > 0);
  if (entries.length < 2) return null;
  const values = entries.map(([, n]) => n);
  const total = values.reduce((sum, n) => sum + n, 0);
  const avg = total / values.length;
  const max = Math.max(...values);
  if (avg <= 0) return null;
  if (max >= avg * 1.4 && max - avg >= 8) {
    const piled = entries.find(([, n]) => n === max)?.[0] || "";
    return `Week ${piled} looks piled (${max} stops vs ~${Math.round(avg)} average). Slinky risk — spread work so no week carries what two weeks should share.`;
  }
  return null;
}

export function isBedBugServiceType(serviceType?: string | null): boolean {
  return /bed\s*bugs?/i.test(String(serviceType || ""));
}

export const SENSAI_GENERATE_HELP =
  "Office 101: ~14–16 stops/day (Bella Vista ~12), max ~60 min total drive, ~2 stops/hour. Tuesday ~9am start (3 fewer stops). Saturday half-day. Specialty (termite / GR / bed bugs / commercial / wildlife / lawn) stays off GPC routes. Generate hard-caps at 18 stops / 90 min; values above 16 / 60 are outside SensAI standard.";

export const SENSAI_HORIZON_COPY =
  "Build window: earliest 2 days out, prefer ~1 week ahead, never more than 2 weeks. Generate defaults to day-after-tomorrow through +1 week. Change dates to view other days — Generate still enforces the window.";

export const SENSAI_EXCEPTION_COPY =
  "Recurring GPC work should fill automatically. Use this tab for exceptions: skill-blocked, specialty, preferred-tech spills, preferred-day conflicts, and rebalance.";
