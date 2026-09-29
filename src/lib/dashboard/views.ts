// Extracted VERBATIM from src/app/(dashboard)/dashboard/page.tsx so the dashboard and the
// MCP server compute every number with the same code. Do not fork the logic — change it here.

import { endOfMonth, format, parseISO, startOfMonth } from "date-fns";
import {
  DASHBOARD_PERIODS,
  TARGET_SERVICE_LINES,
  TARGET_SERVICE_LINE_LABELS,
  completedByLineFromRoutes,
  monthKeysForPeriod,
  monthlyPace,
  monthlyTargetsByLine,
  routesCoverRange,
  targetsByLineForMonths,
  type DashboardPeriod,
} from "@/lib/metrics/operational";
import type { JobRec, RangeDone, RouteRec } from "./types.ts";

export interface AsOfInput {
  asOfDate: string;
  today: string;
  rawJobs: JobRec[];
  rawRoutes: RouteRec[];
  asOfRoutes: RouteRec[] | null;
  jobsByDocId: Map<string, JobRec>;
}

/** Targets by Service rewound to `asOfDate` (null when live). */
export function buildAsOfView(input: AsOfInput) {
  const { asOfDate, today, rawJobs, rawRoutes, asOfRoutes, jobsByDocId } = input;
  if (!asOfDate || asOfDate >= today) return null;
  const d = parseISO(asOfDate);
  const monthStart = format(startOfMonth(d), "yyyy-MM-dd");
  const monthEnd = format(endOfMonth(d), "yyyy-MM-dd");
  const rows = monthlyTargetsByLine(rawJobs, Number(asOfDate.slice(5, 7)), monthStart, monthEnd, asOfDate);
  const routes = asOfRoutes ?? rawRoutes;
  const covered = routesCoverRange(routes, monthStart, asOfDate);
  const doneByLine = covered
    ? completedByLineFromRoutes(routes, (id) => String(jobsByDocId.get(id)?.serviceLine ?? ""), monthStart, asOfDate)
    : null;
  return {
    monthStart,
    covered,
    rows: rows.map((r) => {
      const done = !doneByLine
        ? r.done
        : r.line === "total"
          ? TARGET_SERVICE_LINES.reduce((s, l) => s + (doneByLine[l] || 0), 0)
          : doneByLine[r.line] || 0;
      return {
        line: r.line,
        label: r.line === "total" ? "Total (All)" : r.label,
        target: r.target,
        done,
        pace: monthlyPace(r.target, done, asOfDate),
        rounds: r.rounds,
      };
    }),
  };
}
export type AsOfView = NonNullable<ReturnType<typeof buildAsOfView>>;

export interface PeriodInput {
  period: DashboardPeriod;
  today: string;
  rawJobs: JobRec[];
  rangeDone: RangeDone | null;
}

/** Historical period view (null for the current month, which uses the live cards). */
export function buildPeriodView(input: PeriodInput) {
  const { period, today, rawJobs, rangeDone } = input;
  if (period === "this_month") return null;
  const months = monthKeysForPeriod(period, today);
  const targets = targetsByLineForMonths(rawJobs, months);
  const rows = TARGET_SERVICE_LINES.map((line) => ({
    line,
    label: TARGET_SERVICE_LINE_LABELS[line],
    target: targets[line] || 0,
    done: rangeDone?.byLine?.[line] || 0,
  }));
  const total = {
    target: rows.reduce((s, r) => s + r.target, 0),
    done: rows.reduce((s, r) => s + r.done, 0),
  };
  const label = DASHBOARD_PERIODS.find((p) => p.value === period)?.label || "";
  return { months, rows, total, label };
}
export type PeriodView = NonNullable<ReturnType<typeof buildPeriodView>>;
