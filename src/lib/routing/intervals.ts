// Service-interval / deadline model.
//
// The Flex Router schedules to each customer's service interval, counted from
// their LAST COMPLETED service — not the missed-appointment date. Each service
// line has a reference interval (GR 14d, Lawn 6wk, Termite annual, etc.), but the
// subscription's own frequency (days) is the source of truth when present, with
// the recurringFrequency label and the service-line default as fallbacks.
// (Sensei: Routing & Scheduling v2 — Bi-Weekly Job Pool Audit.)
//
// Deadline-relative flags (flagZone / pastDeadline / grEscalation) shift with the
// calendar, so sync stamps them and recomputePastDue re-derives them daily.

import { parseFrequencyDays } from "@/lib/production-value";
import { shiftISODate } from "@/lib/fieldroutes/scope";
import { ServiceLine, serviceLineMeta } from "./service-line";

export interface IntervalInput {
  serviceLine: ServiceLine;
  frequency?: unknown; // raw subscription.frequency in days
  recurringFrequency?: unknown; // label fallback, e.g. "Every 90 Days"
  lastCompleted?: string; // YYYY-MM-DD
  scheduledDate?: string; // YYYY-MM-DD (serviceDue) — anchor fallback
}

const toNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const isISODate = (v: string | undefined): v is string => /^\d{4}-\d{2}-\d{2}$/.test(v || "");

/** Service interval in days: raw frequency → parsed label → service-line default. */
export function serviceIntervalDays(input: IntervalInput): number {
  const raw = toNum(input.frequency);
  if (raw > 0) return raw;
  const parsed = parseFrequencyDays(input.recurringFrequency);
  if (parsed && parsed > 0) return parsed;
  return serviceLineMeta(input.serviceLine).defaultIntervalDays;
}

/**
 * The hard service deadline (YYYY-MM-DD): last completed + interval. Falls back to
 * the next service date (serviceDue) when there's no completion on record. Returns
 * "" when neither anchor is available.
 */
export function serviceDeadline(input: IntervalInput): string {
  const interval = serviceIntervalDays(input);
  if (isISODate(input.lastCompleted)) return shiftISODate(input.lastCompleted, interval);
  // No completion on record — the FieldRoutes next-service date IS the deadline.
  return isISODate(input.scheduledDate) ? input.scheduledDate : "";
}

/** Whole-day difference b − a (YYYY-MM-DD), or null when either is missing. */
function dayDiff(a: string, b: string): number | null {
  const pa = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a || "");
  const pb = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b || "");
  if (!pa || !pb) return null;
  const ma = Date.UTC(+pa[1], +pa[2] - 1, +pa[3]);
  const mb = Date.UTC(+pb[1], +pb[2] - 1, +pb[3]);
  return Math.round((mb - ma) / 86400000);
}

export interface DeadlineFlags {
  serviceLine: ServiceLine;
  intervalDays: number;
  deadline: string; // YYYY-MM-DD, "" when unknown
  daysUntilDeadline: number | null; // deadline − today (negative = past)
  pastDeadline: boolean; // today > deadline
  flagZone: boolean; // within flagLeadDays of the deadline, or past it
  grEscalation: boolean; // GR line AND past its 14-day deadline (always urgent)
}

/** Deadline-relative urgency flags for `today` (Central YYYY-MM-DD). */
export function computeDeadlineFlags(input: IntervalInput, today: string): DeadlineFlags {
  const intervalDays = serviceIntervalDays(input);
  const deadline = serviceDeadline(input);
  const daysUntilDeadline = deadline ? dayDiff(today, deadline) : null;
  const pastDeadline = daysUntilDeadline !== null && daysUntilDeadline < 0;
  const lead = serviceLineMeta(input.serviceLine).flagLeadDays;
  const flagZone = daysUntilDeadline !== null && daysUntilDeadline <= lead;
  const grEscalation = input.serviceLine === "gr" && pastDeadline;
  return {
    serviceLine: input.serviceLine,
    intervalDays,
    deadline,
    daysUntilDeadline,
    pastDeadline,
    flagZone,
    grEscalation,
  };
}
