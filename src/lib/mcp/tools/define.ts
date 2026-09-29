// One place that registers every tool, so every tool is uniformly read-only, error-safe and
// logged. Logging records the tool name, duration and outcome — never arguments or results,
// which can contain customer names.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { McpContext } from "../data-source.ts";
import { DEFAULT_LIMIT, MAX_LIMIT, ToolInputError, fail, ok } from "../format.ts";
import { STOP_TYPES } from "../snapshot.ts";

export interface ToolSpec<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
}

export function meta(ctx: McpContext) {
  return {
    company: ctx.data.companyId,
    today: ctx.today,
    timezone: "America/Chicago",
    dataReadAt: ctx.data.readAt(),
    note: "Figures reflect the last FieldRoutes sync, not live data. See get_data_freshness.",
  };
}

export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  ctx: McpContext,
  spec: ToolSpec<S>,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<Record<string, unknown>>,
) {
  const callback = async (args: unknown): Promise<CallToolResult> => {
    const started = Date.now();
    try {
      const data = await run(args as z.infer<z.ZodObject<S>>);
      console.log(`[mcp] tool=${spec.name} ok ${Date.now() - started}ms`);
      return ok({ ...data, meta: meta(ctx) });
    } catch (err) {
      if (err instanceof ToolInputError) {
        console.log(`[mcp] tool=${spec.name} rejected-input ${Date.now() - started}ms`);
        return fail(err.message);
      }
      // Log the real error server-side; tell the model only that it failed, so internals
      // (paths, document ids, stack traces) are not disclosed.
      console.error(`[mcp] tool=${spec.name} failed ${Date.now() - started}ms`, err);
      return fail("Something went wrong reading the dashboard data. This is a server-side problem; retrying may help.");
    }
  };
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      annotations: { title: spec.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    callback as never,
  );
}

// ---- shared input shapes ----

export const filterShape = {
  technicians: z.array(z.string()).optional().describe("Technician names or ids (partial names work if unambiguous). Empty = everyone."),
  routeGroups: z.array(z.string()).optional().describe('Route groups, e.g. "GPC", "Specialty", "Wildlife". Spelling variants are folded together.'),
  routeTemplates: z.array(z.string()).optional().describe('Route templates, e.g. "Regular", "Rain Day", "Early Release".'),
  subscriptionTypes: z.array(z.string()).optional().describe('FieldRoutes service types, e.g. "General Pest", "Mosquito Fogging". Stop-level: routes are reduced to matching stops.'),
  stopTypes: z.array(z.enum(STOP_TYPES)).optional().describe("regular, initial (a new signup's first visit) or reservice (a return trip). Combines with subscriptionTypes."),
  startDate: z.string().optional().describe("YYYY-MM-DD. With endDate, switches from today to a date range (the dashboard's Date range)."),
  endDate: z.string().optional().describe("YYYY-MM-DD. Inclusive."),
  skipWeekends: z.boolean().optional().describe("Range only: exclude Saturday/Sunday routes from every number."),
};

export const pageShape = {
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe(`Rows per page (max ${MAX_LIMIT}).`),
  offset: z.number().int().min(0).default(0).describe("Rows to skip; use nextOffset from the previous page."),
};
