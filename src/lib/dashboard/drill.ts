// Extracted VERBATIM from src/app/(dashboard)/dashboard/page.tsx so the dashboard and the
// MCP server compute every number with the same code. Do not fork the logic — change it here.

import type { JobRec, RouteRec } from "./types.ts";

export interface DrillInput {
  scopedRoutes: RouteRec[];
  jobsByDocId: Map<string, JobRec>;
  today: string;
}

/** The exact routes/stops behind the Routes / Stops / Completed / Remaining / Drive / Value cards. */
export function buildDrillData(input: DrillInput) {
  const { scopedRoutes, jobsByDocId, today } = input;
  const routes = [...scopedRoutes].sort(
    (a, b) => a.date.localeCompare(b.date) || String(a.techName || "").localeCompare(String(b.techName || ""))
  );

  interface StopRow {
    key: string;
    customerId: string;
    customerName: string;
    techName: string;
    date: string;
    template: string;
    group: string;
    serviceType: string;
    address: string;
    status: "completed" | "pending" | "scheduled" | "unknown";
  }
  const stopRows: StopRow[] = [];
  const routeRows = routes.map((r) => {
    const seq: string[] = Array.isArray(r.stopSequence) ? r.stopSequence.map(String) : [];
    const detailById = new Map((Array.isArray(r.stops) ? r.stops : []).map((s) => [String(s.id), s]));
    let liveCompleted = 0;
    for (const id of seq) {
      const detail = detailById.get(id);
      const job = jobsByDocId.get(id);
      let status: StopRow["status"];
      if (r.date > today) status = "scheduled";
      else if (detail && typeof detail.completed === "boolean") {
        // Per-stop appointment truth stamped by the reconcile — covers past
        // days AND today (as of the last sync).
        status = detail.completed ? "completed" : "pending";
      } else if (r.date === today) {
        // Today's docs that predate the appointment rebuild: job-doc fallback.
        status = job?.subscriptionLastCompletedDate === today ? "completed" : "pending";
      } else {
        // Past day, doc predates the stops array — unknown until re-verified.
        status = "unknown";
      }
      if (status === "completed") liveCompleted++;
      stopRows.push({
        key: `${r.date}-${String(r.techId || r.techName)}-${id}`,
        customerId: String(job?.customerId || ""),
        customerName: String(detail?.customerName || job?.customerName || id),
        techName: String(r.techName || r.techId || "—"),
        date: r.date,
        template: String(r.routeTemplateTitle || "").trim(),
        group: String(r.routeGroupTitle || "").trim(),
        serviceType: String(job?.serviceType || ""),
        address: String(job?.address || ""),
        status,
      });
    }
    // Completed on the route card: trust the reconcile-stamped count when
    // present (past days and today alike); docs that predate the field use
    // the per-stop tally above.
    const completed = typeof r.completedStops === "number" ? r.completedStops : liveCompleted;
    // Working hours for the per-route Stops/Hr column — same formula as the
    // stopsPerHour KPI (work minutes when present, else drive + service).
    const workMinutes = (Number(r.totalWorkMinutes) || 0) > 0
      ? Number(r.totalWorkMinutes)
      : (Number(r.totalDriveTimeMinutes) || 0) + (Number(r.totalServiceMinutes) || 0);
    return {
      key: `${r.date}-${String(r.techId || r.techName)}`,
      date: r.date,
      techName: String(r.techName || r.techId || "—"),
      template: String(r.routeTemplateTitle || "").trim(),
      group: String(r.routeGroupTitle || "").trim(),
      totalStops: r.totalStops || 0,
      completed,
      driveMinutes: Number(r.totalDriveTimeMinutes) || 0,
      driveEstimated: String(r.driveTimeSource || "") !== "routes_api_matrix",
      routeValue: Number(r.routeValue) || 0,
      workMinutes,
      stopsPerHour: workMinutes > 0 ? (r.totalStops || 0) / (workMinutes / 60) : null,
    };
  });

  return {
    routeRows,
    stopRows,
    completedRows: stopRows.filter((s) => s.status === "completed"),
    remainingRows: stopRows.filter((s) => s.status === "pending" || s.status === "scheduled"),
    hasUnknown: stopRows.some((s) => s.status === "unknown"),
    hasEstimatedDrive: routeRows.some((r) => r.driveEstimated),
  };
}
export type DrillData = ReturnType<typeof buildDrillData>;
