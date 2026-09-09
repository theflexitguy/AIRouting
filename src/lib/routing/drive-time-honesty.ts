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

export function driveTimeSourceKind(source?: string | null): DriveTimeSourceKind {
  return isTrustedDriveTimeSource(source) ? "road" : "estimate";
}

export function driveTimeSourceBadgeLabel(source?: string | null): DriveTimeSourceBadgeLabel {
  return isTrustedDriveTimeSource(source) ? "ROAD" : "ESTIMATE";
}

/** Inline HTML for map / print popups (no React). */
export function driveTimeSourceBadgeHtml(source?: string | null): string {
  const label = driveTimeSourceBadgeLabel(source);
  const estimate = label === "ESTIMATE";
  const color = estimate ? "#b45309" : "#047857";
  const bg = estimate ? "#fef3c7" : "#d1fae5";
  return `<span style="display:inline-block;margin-left:4px;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:800;letter-spacing:.04em;color:${color};background:${bg}">${label}</span>`;
}

export function polylineRenderMode(source?: string | null): PolylineRenderMode {
  return isTrustedDriveTimeSource(source) ? "road" : "estimate";
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

export function chicagoTodayIso(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
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
  "Office 101: ~14–16 stops/day (Bella Vista ~12), max ~60 min total drive, ~2 stops/hour. Tuesday ~9am start (3 fewer stops). Saturday half-day. Specialty (termite / GR / bed bugs / commercial / wildlife / lawn) stays off GPC routes.";

export const SENSAI_EXCEPTION_COPY =
  "Recurring GPC work should fill automatically. Use this tab for exceptions: specialty, holds, preferred-day conflicts, and rebalance.";
