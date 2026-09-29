// Extracted VERBATIM from src/app/(dashboard)/dashboard/page.tsx so the dashboard and the
// MCP server compute every number with the same code. Do not fork the logic — change it here.

import { formatCurrency } from "@/lib/production-value";
// Same constants the SYNC used to stamp overdueActionable — imported rather than
// restated so the audit can never drift from the real thresholds.
import { BALANCE_GATE, MAX_OVERDUE_DAYS, pastDueGraceDays } from "@/lib/fieldroutes/scope";
import type { JobRec, OverdueRow } from "./types.ts";

export interface OverdueInput {
  rawJobs: JobRec[];
  today: string;
}

/**
 * The Overdue Stops audit: the subscriptions the card COUNTS, plus the past-due ones
 * it EXCLUDES with the reason for each.
 */
export function buildOverdueDrill(input: OverdueInput) {
  const { rawJobs, today } = input;
  const daysBetweenISO = (from: string, to: string) =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

  const counted: OverdueRow[] = [];
  const excluded: OverdueRow[] = [];

  for (const j of rawJobs) {
    const dueDate = String(j.scheduledDate || "");
    const daysOverdue = dueDate ? daysBetweenISO(dueDate, today) : 0;
    // Grace scales with service frequency: a monthly sub is "past due" at 5
    // days, a quarterly one at 15.
    const graceDays = pastDueGraceDays(j.frequency);
    const balance = Number(j.subscriptionBalance ?? 0) || 0;
    const note = String(j.schedulingRequest || "").trim();
    const row: OverdueRow = {
      docId: String(j.docId || ""),
      customerId: String(j.customerId || ""),
      customerName: String(j.customerName || j.customerId || ""),
      address: String(j.address || ""),
      balance,
      serviceType: String(j.serviceType || ""),
      frequencyLabel: String(j.recurringFrequency || ""),
      serviceLine: String(j.serviceLine || ""),
      dueDate,
      daysOverdue,
      graceDays,
      lastCompleted: String(j.subscriptionLastCompletedDate || ""),
      reasons: [],
    };

    // Counted rows are EXACTLY the stamped flag, with no re-filtering on the
    // dates — otherwise this list would disagree with the card whenever the
    // flag is older than the data (it is refreshed by sync, not live). Such a
    // row still shows its real due date and day count, which is the point.
    if (j.overdueActionable === true) {
      counted.push(row);
      continue;
    }

    // Everything below is the EXCLUDED half: genuinely past its own window,
    // but not carrying the flag.
    if (!dueDate || dueDate >= today) continue;
    if (daysOverdue <= graceDays) continue; // still inside its window — Pending, not overdue

    // Say which gate it failed, in the order scope.ts applies them. A row can
    // fail several.
    const reasons: string[] = [];
    if (daysOverdue > MAX_OVERDUE_DAYS) reasons.push(`stale — due ${daysOverdue} days ago`);
    if (balance > BALANCE_GATE) reasons.push(`balance ${formatCurrency(balance)} (over ${formatCurrency(BALANCE_GATE)})`);
    if (note) reasons.push(`scheduling note: ${note}`);
    if (j.alreadyScheduled === true) {
      reasons.push(`already booked${j.fieldRoutesScheduledDate ? ` ${j.fieldRoutesScheduledDate}` : ""}`);
    }
    if (j.pendingCancel === true) reasons.push("pending cancel");
    if (j.potentialCustomer === true) reasons.push("prospect, not a customer");
    // Nothing else explains it: the stamped flag predates the current dates
    // (it is refreshed by the sync / recompute-past-due cron, not live).
    if (reasons.length === 0) reasons.push("flag not refreshed since last sync");
    excluded.push({ ...row, reasons });
  }

  const byMostOverdue = (a: OverdueRow, b: OverdueRow) => b.daysOverdue - a.daysOverdue;
  counted.sort(byMostOverdue);
  excluded.sort(byMostOverdue);
  return {
    counted,
    excluded,
    // The card counts customers, not subscriptions — show both so the number
    // is never ambiguous.
    customerCount: new Set(counted.map((r) => r.customerId).filter(Boolean)).size,
    excludedBalanceTotal: excluded.reduce((sum, r) => sum + (r.balance > BALANCE_GATE ? r.balance : 0), 0),
  };
}
export type OverdueDrill = ReturnType<typeof buildOverdueDrill>;
