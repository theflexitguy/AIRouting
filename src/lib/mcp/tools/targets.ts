// The analytical middle of the dashboard: Targets by Service (live / as-of / historical
// period) with its audit, Overdue Stops, Completed buckets, monthly history and the
// technician forecast.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DASHBOARD_PERIODS,
  TARGET_SERVICE_LINES,
  TECH_CATEGORIES,
  deriveForecastGrowth,
  monthKeysForPeriod,
  routesCoverRange,
  targetAuditForLine,
  technicianForecast,
  trailingMonthKeys,
  type DashboardPeriod,
  type MonthlyDoneLike,
} from "@/lib/metrics/operational";
import { BALANCE_GATE, MAX_OVERDUE_DAYS, pastDueGraceDays } from "@/lib/fieldroutes/scope";
import { buildAsOfView, buildPeriodView, sumMonthlyDone, type OverdueRow } from "@/lib/dashboard";
import type { MonthlyDone } from "@/lib/fieldroutes/monthly-done";
import type { McpContext } from "../data-source.ts";
import { ToolInputError, money, paginate, pct, round } from "../format.ts";
import { publicMonthlyDone } from "../public.ts";
import { loadDashboardState } from "../snapshot.ts";
import { completedBuckets, paceSummary, targetLines, targetTotal } from "./overview.ts";
import { defineTool, pageShape } from "./define.ts";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PERIODS = DASHBOARD_PERIODS.map((p) => p.value) as [DashboardPeriod, ...DashboardPeriod[]];
const LINES = TARGET_SERVICE_LINES as unknown as [string, ...string[]];
const monthStartOf = (iso: string) => `${iso.slice(0, 7)}-01`;

function overdueRow(r: OverdueRow) {
  return {
    id: r.docId || null,
    customerId: r.customerId || null,
    customerName: r.customerName,
    address: r.address || null,
    serviceType: r.serviceType || null,
    serviceLine: r.serviceLine || null,
    frequency: r.frequencyLabel || null,
    dueDate: r.dueDate || null,
    daysOverdue: r.daysOverdue,
    windowDays: r.graceDays,
    lastCompleted: r.lastCompleted || null,
    balance: r.balance,
    ...(r.reasons.length ? { whyNotCounted: r.reasons } : {}),
  };
}

export function registerTargetTools(server: McpServer, ctx: McpContext) {
  defineTool(
    server,
    ctx,
    {
      name: "get_targets_by_service",
      title: "Targets by Service",
      description:
        "Per service line (General Pest, Mosquito, Lawn, Termite, Commercial + Total): the monthly target, how much is done, % of target vs % through the month (ahead/behind), what is already booked, and the week/day slices. " +
        "mode=live (default) is this month right now. mode=as_of + asOfDate rewinds to a past day this/any month ('where were we last Friday?'). mode=period + period shows last month / this or last quarter / this or last year from cached monthly aggregates. " +
        "Each line's target uses a different method (see `method`); audit_target shows the derivation with every subscription. Company-wide (route filters do not apply).",
      inputSchema: {
        mode: z.enum(["live", "as_of", "period"]).default("live"),
        asOfDate: z.string().optional().describe("mode=as_of: a past date, YYYY-MM-DD (must be before today)."),
        period: z.enum(PERIODS).optional().describe("mode=period: which historical period."),
      },
    },
    async (args) => {
      const st = await loadDashboardState(ctx, {});

      if (args.mode === "as_of") {
        const d = args.asOfDate ?? "";
        if (!ISO.test(d)) throw new ToolInputError("mode=as_of needs asOfDate as YYYY-MM-DD.");
        if (d >= ctx.today) throw new ToolInputError("asOfDate must be before today; use mode=live for right now.");
        // Same rule as the page: only fetch extra routes when the loaded window doesn't cover it.
        const mStart = monthStartOf(d);
        const asOfRoutes = routesCoverRange(st.rawRoutes, mStart, d) ? null : await ctx.data.getRoutes(mStart, d);
        const view = buildAsOfView({ asOfDate: d, today: ctx.today, rawJobs: st.rawJobs, rawRoutes: st.rawRoutes, asOfRoutes, jobsByDocId: st.jobsByDocId });
        if (!view) throw new ToolInputError("asOfDate must be before today.");
        return {
          mode: "as_of",
          asOfDate: d,
          monthToDate: { from: view.monthStart, to: d },
          completedSource: view.covered
            ? "finalized route documents (appointment truth)"
            : "subscription last-completed dates — routes are not synced for this range, so this may UNDERCOUNT",
          coveredByRoutes: view.covered,
          lines: view.rows.map((r) => ({ line: r.line, label: r.label, target: r.target, done: r.done, ...paceSummary(r.pace), rounds: r.rounds && r.rounds.length ? r.rounds : undefined })),
        };
      }

      if (args.mode === "period" && args.period && args.period !== "this_month") {
        const months = monthKeysForPeriod(args.period, ctx.today);
        const docs = await Promise.all(months.map((m) => ctx.data.getMonthlyDone(m)));
        const rangeDone = sumMonthlyDone(docs, months.length);
        const view = buildPeriodView({ period: args.period, today: ctx.today, rawJobs: st.rawJobs, rangeDone });
        if (!view) throw new ToolInputError("Unknown period.");
        return {
          mode: "period",
          period: args.period,
          label: view.label,
          months: view.months,
          monthsWithCachedData: rangeDone.monthsAvailable,
          monthsMissing: months.filter((_, i) => !docs[i]),
          lines: view.rows.map((r) => ({ line: r.line, label: r.label, target: r.target, done: r.done, percentOfTargetDone: r.target > 0 ? pct(r.done / r.target) : 0 })),
          total: { target: view.total.target, done: view.total.done, percentOfTargetDone: view.total.target > 0 ? pct(view.total.done / view.total.target) : 0 },
          note:
            "Targets here are a rate-based baseline for the months; done comes from cached monthly aggregates. Missing months (see monthsMissing) are simply not counted until a refresh computes them.",
        };
      }
      if (args.mode === "period" && !args.period) throw new ToolInputError("mode=period needs a period. Valid: " + PERIODS.join(", "));

      const b = st.bounds;
      const methods = new Map(
        TARGET_SERVICE_LINES.map((line) => {
          const a = targetAuditForLine(st.rawJobs, line, b.monthIndex, b.monthStart, b.monthEnd, ctx.today);
          return [line, { method: a.method, formula: a.formula, subscriptionsConsidered: a.considered, contributing: a.contributing }] as const;
        }),
      );
      return {
        mode: "live",
        month: { start: b.monthStart, end: b.monthEnd },
        total: targetTotal(st),
        lines: targetLines(st).map((l) => ({ ...l, ...methods.get(l.line as (typeof TARGET_SERVICE_LINES)[number]) })),
        howToRead: "percentOfTargetDone above percentThroughMonth means ahead of pace. bookedRestOfMonth is work already on the schedule from today to month end.",
      };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "audit_target",
      title: "Audit a service line's target",
      description:
        "Why a Targets by Service number is what it is. For one line: the method used, the formula with real numbers, grouped inputs, and EVERY subscription considered — including those that contributed nothing and the reason. " +
        "`reconciles` confirms the rows add up to the card. Use this to check or explain a target. Paginated; onlyContributing hides subscriptions that added nothing.",
      inputSchema: {
        line: z.enum(LINES).describe("general, mosquito, lawn, termite or commercial."),
        onlyContributing: z.boolean().optional(),
        search: z.string().optional().describe("Case-insensitive match on customer name or service type."),
        ...pageShape,
      },
    },
    async (args) => {
      const st = await loadDashboardState(ctx, {});
      const b = st.bounds;
      const line = args.line as (typeof TARGET_SERVICE_LINES)[number];
      const audit = targetAuditForLine(st.rawJobs, line, b.monthIndex, b.monthStart, b.monthEnd, ctx.today);
      const card = st.stats().lineTargets.find((t) => t.line === line);
      const q = (args.search ?? "").trim().toLowerCase();
      const rows = audit.rows.filter(
        (r) => (!args.onlyContributing || r.counts) && (!q || `${r.customerName} ${r.serviceType}`.toLowerCase().includes(q)),
      );
      return {
        line,
        month: { start: b.monthStart, end: b.monthEnd },
        method: audit.method,
        formula: audit.formula,
        cardTarget: card?.target ?? null,
        cardDone: card?.done ?? null,
        auditTarget: audit.rowsTarget,
        auditDone: audit.rowsDone,
        reconciles: card ? card.target === audit.rowsTarget && card.done === audit.rowsDone : null,
        subscriptionsConsidered: audit.considered,
        subscriptionsContributing: audit.contributing,
        groups: audit.groups.map((g) => ({ ...g, contribution: round(g.contribution, 3) })),
        ...(() => {
          const page = paginate(rows, args.limit, args.offset);
          return { ...page, items: page.items.map((r) => ({ ...r, contribution: round(r.contribution, 3) })) };
        })(),
      };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "get_overdue_stops",
      title: "Overdue Stops audit",
      description:
        "The Overdue Stops card, auditable. `counted` = the subscriptions behind the number (distinct customers = the card): who, what subscription, when due, days overdue, balance. " +
        "`excluded` = subscriptions that are past due but NOT counted, each with the reason (balance over the gate, scheduling note, already booked, pending cancel, stale…) — where collections and constraint backlog hides. " +
        "Company-wide. include=counted|excluded|both; filter by service line, minimum days overdue or balance, or search a name. Paginated per list.",
      inputSchema: {
        include: z.enum(["counted", "excluded", "both"]).default("counted"),
        serviceLine: z.enum(["general", "gr", "termite", "lawn", "mosquito", "commercial", "wildlife"]).optional(),
        minDaysOverdue: z.number().int().min(0).optional(),
        minBalance: z.number().min(0).optional().describe("Only subscriptions whose customer balance is at least this many dollars."),
        search: z.string().optional().describe("Case-insensitive match on customer name, address or service type."),
        sortBy: z.enum(["daysOverdue", "balance", "customer"]).default("daysOverdue"),
        ...pageShape,
      },
    },
    async (args) => {
      const st = await loadDashboardState(ctx, {});
      const o = st.overdue();
      const q = (args.search ?? "").trim().toLowerCase();
      const keep = (r: OverdueRow) =>
        (!args.serviceLine || r.serviceLine === args.serviceLine) &&
        (args.minDaysOverdue === undefined || r.daysOverdue >= args.minDaysOverdue) &&
        (args.minBalance === undefined || r.balance >= args.minBalance) &&
        (!q || `${r.customerName} ${r.address} ${r.serviceType}`.toLowerCase().includes(q));
      const order = (rows: OverdueRow[]) =>
        [...rows].sort((a, b) =>
          args.sortBy === "balance" ? b.balance - a.balance : args.sortBy === "customer" ? a.customerName.localeCompare(b.customerName) : b.daysOverdue - a.daysOverdue,
        );
      const counted = paginate(order(o.counted.filter(keep)), args.limit, args.offset);
      const excluded = paginate(order(o.excluded.filter(keep)), args.limit, args.offset);
      return {
        card: { customers: o.customerCount, subscriptions: o.counted.length },
        excludedSummary: { subscriptions: o.excluded.length, balanceOverGateTotal: o.excludedBalanceTotal, balanceOverGateTotalFormatted: money(o.excludedBalanceTotal) },
        rules: [
          `A subscription is past due once it is later than its frequency-scaled window (${[30, 60, 90, 365].map((d) => `${d}-day interval: ${pastDueGraceDays(d)}d`).join(", ")}).`,
          `It counts only if: under ${MAX_OVERDUE_DAYS} days late, customer balance ≤ $${BALANCE_GATE}, no special-scheduling note, not already booked, not pending cancel, not a prospect.`,
          "The flag is refreshed by the sync, so a row can lag the data by up to one sync.",
        ],
        appliedFilters: { include: args.include, serviceLine: args.serviceLine ?? null, minDaysOverdue: args.minDaysOverdue ?? null, minBalance: args.minBalance ?? null, search: args.search ?? null },
        ...(args.include !== "excluded" ? { counted: { ...counted, items: counted.items.map(overdueRow) } } : {}),
        ...(args.include !== "counted" ? { excluded: { ...excluded, items: excluded.items.map(overdueRow) } } : {}),
      };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "get_completed_breakdown",
      title: "Completed work by bucket",
      description:
        "The 'Completed This Month' (or any period's) buckets: recurring completions by line, Initials by line, Reservices, Follow-ups, Specialty (German Roach, one-time, flea…), Wildlife — plus New Business (new customers and subscriptions). " +
        "Also `unclassifiedTypes`: completed work whose service type names no known line, counted in NO line. Periods other than this_month sum the cached monthly aggregates and list which months are missing.",
      inputSchema: { period: z.enum(PERIODS).default("this_month") },
    },
    async (args) => {
      if (args.period === "this_month") {
        const month = ctx.today.slice(0, 7);
        const live = (await ctx.data.getLiveMonthlyDone()) ?? (await ctx.data.getMonthlyDone(month));
        const doc = live && live.month === month ? live : null;
        return {
          period: "this_month",
          available: Boolean(doc),
          ...(doc
            ? { summary: completedBuckets(doc, ctx.today), detail: publicMonthlyDone(doc) }
            : { message: "This month's aggregate has not been computed yet; a sync populates it." }),
        };
      }
      const months = monthKeysForPeriod(args.period, ctx.today);
      const docs = await Promise.all(months.map((m) => ctx.data.getMonthlyDone(m)));
      const sum = sumMonthlyDone(docs, months.length);
      const unclassifiedTypes: Record<string, number> = {};
      for (const d of docs) for (const [k, v] of Object.entries(d?.unclassifiedTypes ?? {})) unclassifiedTypes[k] = (unclassifiedTypes[k] || 0) + Number(v || 0);
      return {
        period: args.period,
        label: DASHBOARD_PERIODS.find((p) => p.value === args.period)?.label,
        months,
        monthsWithData: sum.monthsAvailable,
        monthsMissing: months.filter((_, i) => !docs[i]),
        totals: {
          completedAppointments: sum.completedAppointments,
          recurringDoneByLine: sum.byLine,
          initials: { total: sum.initials, byLine: sum.initialsByLine },
          reservices: sum.reservices,
          followUps: sum.followups,
          specialty: sum.specialty,
          wildlife: sum.wildlife,
          newCustomers: sum.newCustomers,
          newSubscriptions: sum.newSubscriptions,
        },
        unclassifiedTypes,
        perMonth: months.map((m, i) => (docs[i] ? publicMonthlyDone(docs[i] as MonthlyDone) : { month: m, computed: false })),
      };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "get_monthly_history",
      title: "Monthly history",
      description:
        "The cached per-month aggregates, oldest first — completed appointments, recurring completions by line, initials, reservices, follow-ups, specialty, wildlife, new customers/subscriptions, and unclassified work — for trend and year-over-year questions. Months never computed are listed as missing.",
      inputSchema: { months: z.number().int().min(1).max(24).default(12).describe("How many months back, ending with the current month.") },
    },
    async (args) => {
      const keys = trailingMonthKeys(ctx.today, args.months);
      const docs = await Promise.all(keys.map((k) => ctx.data.getMonthlyDone(k)));
      return {
        months: keys.length,
        history: docs.filter((d): d is MonthlyDone => Boolean(d)).map(publicMonthlyDone),
        missing: keys.filter((_, i) => !docs[i]),
      };
    },
  );

  defineTool(
    server,
    ctx,
    {
      name: "get_technician_forecast",
      title: "Technicians needed — 12-month forecast",
      description:
        "How many technicians the next 12 months need (starting with the current month), by category (GPC, Specialty, Lawn, Termite, Wildlife): workload, fractional need, and whole-person hires after cross-coverage, plus the growth driver (automatic from new-subscription trend vs last year, or a manual monthly %). " +
        "Pass growthPct to see a what-if (nothing is saved). Built from live subscriptions plus up to 15 months of history.",
      inputSchema: { growthPct: z.number().min(-50).max(50).optional().describe("What-if monthly growth %. Omit to use the saved setting / automatic rate.") },
    },
    async (args) => {
      const [meta, jobs] = await Promise.all([ctx.data.getCompanyMeta(), ctx.data.getJobs()]);
      const keys = trailingMonthKeys(ctx.today, 15);
      const docs = await Promise.all(keys.map((k) => ctx.data.getMonthlyDone(k)));
      const history = docs.filter((d): d is MonthlyDone => Boolean(d)) as unknown as MonthlyDoneLike[];
      const manual = args.growthPct ?? meta.forecastMonthlyGrowthPct;
      const rows = jobs.length === 0 ? [] : technicianForecast(jobs, history, ctx.today, Number(manual) || 0);
      const growth = deriveForecastGrowth(history, ctx.today, Number(manual) || 0);
      const peak = rows.reduce<(typeof rows)[number] | null>((p, r) => (!p || r.totalHires > p.totalHires ? r : p), null);
      return {
        growth: { source: growth.source, annualPct: growth.annualPct, manualMonthlyPct: Number(manual) || 0, isWhatIf: args.growthPct !== undefined },
        historyMonthsAvailable: history.length,
        categories: TECH_CATEGORIES.map((c) => ({ key: c.key, label: c.label, appointmentsPerTechDay: c.perDay, handles: c.handles })),
        headline: rows.length ? { firstMonth: rows[0].month, firstMonthHires: rows[0].totalHires, peakMonth: peak?.month, peakHires: peak?.totalHires } : null,
        months: rows.map((r) => ({
          month: r.month,
          totalHires: r.totalHires,
          totalNeed: round(r.totalNeed, 1),
          totalWorkload: r.totalWorkload,
          byCategory: r.byCategory,
        })),
        note: "Fewer than 12 months of history makes the seasonality flat (recent 3-month average).",
      };
    },
  );
}
