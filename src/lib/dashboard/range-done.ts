// Extracted from src/app/(dashboard)/dashboard/page.tsx (loadRangeDone) so the dashboard and the
// MCP server sum cached monthly aggregates identically. The accumulation is verbatim; only the
// Firestore-snapshot access became a plain-document loop.

import { TARGET_SERVICE_LINES } from "@/lib/metrics/operational";
import type { MonthlyDone } from "@/lib/fieldroutes/monthly-done";
import type { RangeDone } from "./types.ts";

/** Sum the cached per-month aggregates for a period (null = that month isn't cached yet). */
export function sumMonthlyDone(docs: Array<MonthlyDone | null>, monthsTotal: number): RangeDone {
  const byLine: Record<string, number> = {};
  const initialsByLine: Record<string, number> = {};
  for (const l of TARGET_SERVICE_LINES) { byLine[l] = 0; initialsByLine[l] = 0; }
  let initials = 0, reservices = 0, followups = 0, specialty = 0, wildlife = 0;
  let newCustomers = 0, newSubscriptions = 0, completedAppointments = 0, monthsAvailable = 0;
  for (const d of docs) {
    if (!d) continue;
    monthsAvailable++;
    for (const l of TARGET_SERVICE_LINES) byLine[l] += Number(d.recurringDoneByLine?.[l] || 0);
    for (const k of Object.keys(d.initialsByLine || {})) initialsByLine[k] = (initialsByLine[k] || 0) + Number(d.initialsByLine[k] || 0);
    initials += Number(d.initialsTotal || 0);
    reservices += Number(d.reserviceDone || 0);
    followups += Number(d.followupDone || 0);
    specialty += Number(d.specialtyDone || 0);
    wildlife += Number(d.wildlifeDone || 0);
    newCustomers += Number(d.newCustomers || 0);
    newSubscriptions += Number(d.newSubscriptions || 0);
    completedAppointments += Number(d.completedAppointments || 0);
  }
  return { byLine, initials, initialsByLine, reservices, followups, specialty, wildlife, newCustomers, newSubscriptions, completedAppointments, monthsAvailable, monthsTotal };
}
