// Assembles the Routiq MCP server: tools, resources and prompts over a DashboardDataSource.
// One server instance per request (stateless), which is what serverless hosting needs.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpContext } from "./data-source.ts";
import { SERVER_INSTRUCTIONS, buildGlossary } from "./glossary.ts";
import { registerCatalogTools } from "./tools/catalog.ts";
import { registerJobTools } from "./tools/jobs.ts";
import { registerOverviewTools } from "./tools/overview.ts";
import { registerRouteTools } from "./tools/routes.ts";
import { registerTargetTools } from "./tools/targets.ts";

export const SERVER_NAME = "routiq";
export const SERVER_VERSION = "1.0.0";

const TOOL_CATALOG = `
## Tools, broad → granular

**Orientation**
- get_dashboard_overview — the whole dashboard in one call (START HERE)
- get_data_freshness — when the numbers were last synced
- get_configuration — targets, thresholds, settings · explain_metric — what any number means · get_filter_options — valid filter values

**Routes & stops** (accept the dashboard filters)
- get_route_summary → list_routes → get_route / list_stops
- get_kpis_and_trend — weekly efficiency vs targets, 8-week trend

**Service targets**
- get_targets_by_service (live / as-of a past date / historical period) → audit_target (every subscription behind a target)

**Accounts**
- get_overdue_stops — counted and excluded, with reasons
- search_jobs · get_job · aggregate_jobs — the underlying subscriptions

**Results & planning**
- get_completed_breakdown · get_monthly_history — initials, reservices, follow-ups, specialty, wildlife, new business
- get_technician_forecast — technicians needed over 12 months
- list_technicians — workload per technician
`;

function prompt(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function createRoutiqMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "Routiq" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerOverviewTools(server, ctx);
  registerRouteTools(server, ctx);
  registerTargetTools(server, ctx);
  registerJobTools(server, ctx);
  registerCatalogTools(server, ctx);

  // ---- resources: reference material a client can attach without spending a tool call ----
  server.registerResource(
    "guide",
    "routiq://guide",
    { title: "Routiq MCP guide", description: "How to use this server, and the tool map from broad to granular.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: `${SERVER_INSTRUCTIONS}\n${TOOL_CATALOG}` }] }),
  );
  server.registerResource(
    "glossary",
    "routiq://glossary",
    { title: "Metric glossary", description: "Definition, formula, data source and caveats for every dashboard metric.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(buildGlossary(), null, 2) }] }),
  );

  // ---- prompts: ready-made workflows ----
  server.registerPrompt(
    "daily_briefing",
    { title: "Daily briefing", description: "A morning operations briefing: what is on today, what is behind, what needs attention." },
    () =>
      prompt(
        "Write a concise operations briefing for today using the Routiq tools.\n" +
          "1. Call get_data_freshness; if the data is stale, say so first.\n" +
          "2. Call get_dashboard_overview and summarize today's routes, month-to-date pace by service line, and overdue customers.\n" +
          "3. Call list_routes sorted by drive time (desc) and by stopsPerHour (asc) to flag the least efficient routes today.\n" +
          "4. Call get_overdue_stops (include=both, sorted by daysOverdue) and pull out the three biggest problems and any pattern in why accounts are excluded.\n" +
          "Finish with 3-5 concrete actions ranked by impact. Cite the numbers and name the tool each came from.",
      ),
  );
  server.registerPrompt(
    "weekly_review",
    { title: "Weekly review", description: "How efficiently routes ran this week and whether service targets are on pace." },
    () =>
      prompt(
        "Review this week using the Routiq tools.\n" +
          "1. get_kpis_and_trend — compare each KPI to its target and describe the 8-week direction.\n" +
          "2. get_targets_by_service (mode=live) — which lines are behind pace, by how many points, and what is already booked for the rest of the month.\n" +
          "3. list_technicians — who is over- or under-loaded, and whose stops/hour lags.\n" +
          "4. get_completed_breakdown — note reservices and follow-ups (rework) relative to recurring work.\n" +
          "Give a verdict per area (good / watch / problem) and the single most valuable change to make next week.",
      ),
  );
  server.registerPrompt(
    "audit_metric",
    {
      title: "Audit a metric",
      description: "Explain how a dashboard number is calculated and verify it against the underlying records.",
      argsSchema: { metric: z.string().describe("The metric or card to audit, e.g. 'Lawn target' or 'Overdue Stops'.") },
    },
    ({ metric }) =>
      prompt(
        `Audit the dashboard metric: "${metric}".\n` +
          "1. explain_metric to state the definition and formula.\n" +
          "2. Use the matching drill-down (audit_target for a service target, get_overdue_stops for Overdue, list_routes/list_stops for route cards) to get the rows behind the number.\n" +
          "3. Re-add the rows yourself and confirm the total matches the card; report any difference and its likely cause (data freshness, a filter, a definition quirk).\n" +
          "4. Call get_data_freshness and state how current the figure is.",
      ),
  );
  server.registerPrompt(
    "technician_review",
    {
      title: "Technician review",
      description: "A focused look at one technician's routes and accounts.",
      argsSchema: { technician: z.string().describe("Technician name.") },
    },
    ({ technician }) =>
      prompt(
        `Review ${technician}'s recent work.\n` +
          `1. list_technicians (this week) for their workload; get_kpis_and_trend with technicians=["${technician}"] for efficiency versus targets.\n` +
          `2. list_routes with technicians=["${technician}"] sorted by stopsPerHour ascending to find their weakest days; use get_route on one to see the stop order.\n` +
          `3. search_jobs with technician="${technician}" and overdue=true for accounts of theirs that are overdue.\n` +
          "Summarize strengths, concerns, and one specific coaching or routing suggestion.",
      ),
  );
  server.registerPrompt(
    "collections_focus",
    { title: "Collections focus", description: "Past-due accounts held back by balance, and what is recoverable." },
    () =>
      prompt(
        "Find overdue revenue that is blocked by unpaid balances.\n" +
          "1. get_overdue_stops with include=excluded, sortBy=balance, minBalance=1.\n" +
          "2. Group what you find by service line and by reason (use aggregate_jobs if useful).\n" +
          "3. List the largest balances that are otherwise ready to service, with customer, subscription and amount.\n" +
          "Recommend an order of outreach and quantify how many stops would return to the schedule if the top accounts paid.",
      ),
  );

  return server;
}
