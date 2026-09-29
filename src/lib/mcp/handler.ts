// The HTTP-facing half of the MCP server, kept out of the Next.js route file so it can be
// exercised in tests with an in-memory data source.
//
// Request order matters and is deliberate:
//   1. CORS preflight (carries no credentials, exposes nothing)
//   2. authentication — fail closed: no configured key => 503, bad/missing token => 401
//   3. method check
//   4. company resolution
//   5. the MCP transport itself
// Nothing about the company, its data or its tools is reachable before step 2 succeeds.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authorize } from "./auth.ts";
import type { McpConfig } from "./config.ts";
import type { McpContext } from "./data-source.ts";
import { createRoutiqMcpServer } from "./server.ts";

const CORS: Record<string, string> = {
  // Credentials travel in the Authorization header, never in cookies, so there is no ambient
  // authority for a cross-origin page to abuse; a wildcard origin is the norm for MCP servers.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-API-Key, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

const BASE_HEADERS: Record<string, string> = {
  ...CORS,
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json", ...extra },
  });
}

export interface HandlerDeps {
  config: McpConfig;
  /** Resolves the data source (and today's date) for an authenticated request. */
  resolveContext: () => Promise<McpContext | { error: string }>;
}

export async function handleMcpRequest(request: Request, deps: HandlerDeps): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: BASE_HEADERS });

  const auth = authorize(request.headers, deps.config.keys);
  if (!auth.ok) {
    if (auth.status === 503) console.error("[mcp] refused: no valid MCP_API_KEY configured");
    else console.warn("[mcp] refused: bad credentials");
    return json(
      auth.status,
      { error: auth.message },
      auth.status === 401 ? { "WWW-Authenticate": 'Bearer realm="routiq-mcp"' } : {},
    );
  }
  // Which key is in use (a short digest, never the key) — lets you see when the old key stops
  // being used during a rotation.
  console.log(`[mcp] authorized key=${auth.keyId}`);
  if (deps.config.rejectedShortKeys > 0) {
    console.warn(`[mcp] ${deps.config.rejectedShortKeys} configured key(s) ignored: keys must be at least 24 characters`);
  }

  // Stateless: there is no server-initiated stream or session to open or close.
  if (request.method !== "POST") {
    return json(405, { error: "This MCP endpoint is stateless and accepts POST only." }, { Allow: "POST, OPTIONS" });
  }

  let ctx: Awaited<ReturnType<HandlerDeps["resolveContext"]>>;
  try {
    ctx = await deps.resolveContext();
  } catch (err) {
    // e.g. the database is unreachable. Log the cause; tell the caller nothing about internals.
    console.error("[mcp] cannot reach the database", err);
    return json(503, { error: "The dashboard database is temporarily unavailable. Try again shortly." });
  }
  if ("error" in ctx) {
    console.error(`[mcp] cannot resolve company: ${ctx.error}`);
    return json(503, { error: ctx.error });
  }

  const server = createRoutiqMcpServer(ctx);
  // One transport per request. JSON responses (not SSE) so serverless never holds a stream open.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    // Apply our headers to whatever the transport produced.
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(BASE_HEADERS)) headers.set(k, v);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (err) {
    console.error("[mcp] transport error", err);
    return json(500, { error: "Internal server error." });
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

