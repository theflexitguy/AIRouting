// The granular end: the subscription records the dashboard's targets and overdue counts are
// built from. Search them, look one up (and see where it is booked), or aggregate them.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { canonicalRouteGroup } from "@/lib/route-groups";
import { norm, type JobRec } from "@/lib/dashboard";
import type { McpContext } from "../data-source.ts";
import { ToolInputError, paginate, round } from "../format.ts";
import { jobBalance, jobField, publicJob } from "../public.ts";
import { loadDashboardState } from "../snapshot.ts";
import { defineTool, pageShape } from "./define.ts";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const SERVICE_LINES = ["general", "gr", "termite", "lawn", "mosquito", "commercial", "wildlife"] as const;
const STATUSES = ["pending", "scheduled", "review", "inactive", "completed"] as const;

const jobFilterShape = {
  query: z.string().optional().describe("Case-insensitive match on customer name, address, subscription id or customer id."),
  serviceLines: z.array(z.enum(SERVICE_LINES)).optional(),
  serviceTypes: z.array(z.string()).optional().describe('Exact FieldRoutes service types (case-insensitive), e.g. "General Pest".'),
  statuses: z.array(z.enum(STATUSES)).optional().describe("pending = due and routable; scheduled = booked; review = needs a human; completed = done this cycle; inactive."),
  technician: z.string().optional().describe("Matches the subscription's preferred technician OR the technician it is booked with (partial names work)."),
  routeGroup: z.string().optional().describe("Route group the subscription is booked on (booked subscriptions only)."),
  dueFrom: z.string().optional().describe("Next-due date on or after, YYYY-MM-DD."),
  dueTo: z.string().optional().describe("Next-due date on or before, YYYY-MM-DD."),
  overdue: z.boolean().optional().describe("true = only subscriptions counted in the Overdue Stops card; false = only those not."),
  booked: z.boolean().optional().describe("true = already has a FieldRoutes appointment on the books."),
  pendingCancel: z.boolean().optional(),
  minBalance: z.number().optional().describe("Customer balance, dollars."),
  maxBalance: z.number().optional(),
};

type JobFilters = { [K in keyof typeof jobFilterShape]?: z.infer<(typeof jobFilterShape)[K]> };

const preferredTech = (j: JobRec) => String(jobField(j, "preferredTech") ?? "");

export function applyJobFilters(jobs: JobRec[], f: JobFilters): JobRec[] {
  for (const d of [f.dueFrom, f.dueTo]) if (d && !ISO.test(d)) throw new ToolInputError("Dates must be YYYY-MM-DD.");
  const q = (f.query ?? "").trim().toLowerCase();
  const types = (f.serviceTypes ?? []).map((t) => t.trim().toLowerCase());
  const tech = norm(f.technician);
  const group = f.routeGroup ? canonicalRouteGroup(f.routeGroup) : "";
  return jobs.filter((j) => {
    if (q && !`${j.customerName} ${j.address} ${j.subscriptionId} ${j.customerId} ${j.docId}`.toLowerCase().includes(q)) return false;
    if (f.serviceLines?.length && !f.serviceLines.includes(String(j.serviceLine) as (typeof SERVICE_LINES)[number])) return false;
    if (types.length && !types.includes(String(j.serviceType || "").trim().toLowerCase())) return false;
    if (f.statuses?.length && !f.statuses.includes(String(j.status) as (typeof STATUSES)[number])) return false;
    if (tech && !norm(`${preferredTech(j)} ${j.scheduledTech ?? ""}`).includes(tech)) return false;
    if (group && canonicalRouteGroup(String(j.fieldRoutesRouteGroup || "")) !== group) return false;
    if (f.dueFrom && !(String(j.scheduledDate || "") >= f.dueFrom)) return false;
    if (f.dueTo && !(String(j.scheduledDate || "") !== "" && String(j.scheduledDate) <= f.dueTo)) return false;
    if (f.overdue !== undefined && (j.overdueActionable === true) !== f.overdue) return false;
    if (f.booked !== undefined && (j.alreadyScheduled === true) !== f.booked) return false;
    if (f.pendingCancel !== undefined && (j.pendingCancel === true) !== f.pendingCancel) return false;
    const bal = jobBalance(j);
    if (f.minBalance !== undefined && bal < f.minBalance) return false;
    if (f.maxBalance !== undefined && bal > f.maxBalance) return false;
    return true;
  });
}

const count = <T>(rows: T[], key: (r: T) => string) => {
  const m: Record<string, number> = {};
  for (const r of rows) {
    const k = key(r) || "(none)";
    m[k] = (m[k] || 0) + 1;
  }
  return m;
};

export function registerJobTools(server: McpServer, ctx: McpContext) {
  defineTool(
    server,
    ctx,
    {
      name: "search_jobs",
      title: "Search subscriptions",
      description:
        "Search the in-scope recurring subscriptions ('jobs') that Targets by Service and Overdue Stops are computed from. Filter by customer/address text, service line or type, status, technician, route group, next-due window, overdue, booked, balance. " +
        "Returns customer, address, service type, frequency, next due, last completed, balance, booking and overdue flag — detail=full adds price, production value, seasonality, deadline and routing flags. Paginated; also returns counts by line and status for everything that matched.",
      inputSchema: {
        ...jobFilterShape,
        sortBy: z.enum(["dueDate", "balance", "customer", "lastCompleted"]).default("dueDate"),
        detail: z.enum(["summary", "full"]).default("summary"),
        ...pageShape,
      },
    },
    async (args) => {
      const all = await ctx.data.getJobs();
      const matched = applyJobFilters(all, args);
      const sorted = [...matched].sort((a, b) => {
        switch (args.sortBy) {
          case "balance": return jobBalance(b) - jobBalance(a);
          case "customer": return String(a.customerName).localeCompare(String(b.customerName));
          case "lastCompleted": return String(b.subscriptionLastCompletedDate || "").localeCompare(String(a.subscriptionLastCompletedDate || ""));
          default: return String(a.scheduledDate || "9999").localeCompare(String(b.scheduledDate || "9999"));
        }
      });
      const page = paginate(sorted, args.limit, args.offset);
      return {
        totalInScope: all.length,
        matching: matched.length,
        byServiceLine: count(matched, (j) => String(j.serviceLine)),
        byStatus: count(matched, (j) => String(j.status)),
        ...page,
        items: page.items.map((j) => publicJob(j, args.detail)),
      };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "get_job",
      title: "Look up a subscription",
      description:
        "One subscription in full, by id (e.g. sub_20219), subscriptionId, or customerId (a customer can have several). Includes price, production value, seasonality, deadline/overdue flags and booking — and WHERE it is scheduled: every recent/upcoming route (this week and the 8-week window) whose stops include it. " +
        "Use it to answer 'why is this customer overdue / not booked / behind?'",
      inputSchema: {
        id: z.string().optional().describe("Document id, e.g. sub_20219."),
        subscriptionId: z.string().optional(),
        customerId: z.string().optional(),
      },
    },
    async (args) => {
      if (!args.id && !args.subscriptionId && !args.customerId) {
        throw new ToolInputError("Provide one of id, subscriptionId or customerId.");
      }
      const st = await loadDashboardState(ctx, {});
      const hits = st.rawJobs.filter(
        (j) =>
          (args.id && j.docId === args.id) ||
          (args.subscriptionId && String(j.subscriptionId) === args.subscriptionId) ||
          (args.customerId && String(j.customerId) === args.customerId),
      );
      if (hits.length === 0) {
        throw new ToolInputError("No in-scope subscription matches. (Cancelled, inactive and test subscriptions are not in scope.) Try search_jobs with a name.");
      }
      const shown = hits.slice(0, 10);
      return {
        matches: hits.length,
        truncated: hits.length > shown.length,
        jobs: shown.map((j) => {
          const id = j.docId as string;
          const routes = st.rawRoutes
            .map((r) => ({ r, pos: (Array.isArray(r.stopSequence) ? r.stopSequence.map(String) : []).indexOf(id) }))
            .filter((x) => x.pos >= 0)
            .sort((a, b) => a.r.date.localeCompare(b.r.date))
            .slice(0, 30)
            .map(({ r, pos }) => {
              const d = (Array.isArray(r.stops) ? r.stops : []).find((s) => String(s.id) === id);
              return {
                date: r.date,
                technician: r.techName || r.techId || null,
                routeGroup: r.routeGroupTitle || null,
                position: pos + 1,
                completed: typeof d?.completed === "boolean" ? d.completed : null,
                stopType: d?.kind || "regular",
              };
            });
          return { job: publicJob(j, "full"), appearsOnRoutes: routes };
        }),
      };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "aggregate_jobs",
      title: "Aggregate subscriptions",
      description:
        "Group the subscriptions and total them — how many, how many distinct customers, total balance, how many are counted overdue, booked or pending cancel — by service line, service type, status, frequency, preferred technician, booked technician, route group, due month or city. " +
        "Accepts the same filters as search_jobs. The quick way to answer 'how many X by Y?' without paging through records.",
      inputSchema: {
        groupBy: z.enum(["serviceLine", "serviceType", "status", "frequency", "preferredTech", "bookedTech", "routeGroup", "dueMonth", "city"]),
        ...jobFilterShape,
        ...pageShape,
      },
    },
    async (args) => {
      const all = await ctx.data.getJobs();
      const matched = applyJobFilters(all, args);
      const key: Record<string, (j: JobRec) => string> = {
        serviceLine: (j) => String(j.serviceLine || ""),
        serviceType: (j) => String(j.serviceType || ""),
        status: (j) => String(j.status || ""),
        frequency: (j) => String(j.recurringFrequency || ""),
        preferredTech: (j) => preferredTech(j),
        bookedTech: (j) => String(j.scheduledTech || ""),
        routeGroup: (j) => canonicalRouteGroup(String(j.fieldRoutesRouteGroup || "")),
        dueMonth: (j) => String(j.scheduledDate || "").slice(0, 7),
        city: (j) => String(jobField(j, "city") ?? ""),
      };
      const groups = new Map<string, JobRec[]>();
      for (const j of matched) {
        const k = key[args.groupBy](j).trim() || "(none)";
        groups.set(k, [...(groups.get(k) ?? []), j]);
      }
      const rows = Array.from(groups.entries())
        .map(([group, js]) => ({
          group,
          subscriptions: js.length,
          customers: new Set(js.map((j) => String(j.customerId || "")).filter(Boolean)).size,
          balanceTotal: round(js.reduce((s, j) => s + jobBalance(j), 0), 2),
          countedOverdue: js.filter((j) => j.overdueActionable === true).length,
          booked: js.filter((j) => j.alreadyScheduled === true).length,
          pendingCancel: js.filter((j) => j.pendingCancel === true).length,
        }))
        .sort((a, b) => b.subscriptions - a.subscriptions || a.group.localeCompare(b.group));
      return { groupBy: args.groupBy, totalInScope: all.length, matching: matched.length, groups: rows.length, ...paginate(rows, args.limit, args.offset) };
    },
  );
}
