// Shared wrapper for the thin Next.js OAuth routes: 404 when sign-in isn't configured (so clients
// conclude there is no OAuth and fall back), and a generic 500 that never leaks internals.

import type { OAuthFlow } from "./flow.ts";
import { getOAuth } from "./runtime.ts";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

export const oauthRoute =
  (pick: (flow: OAuthFlow) => (req: Request) => Response | Promise<Response>) =>
  async (req: Request): Promise<Response> => {
    const flow = getOAuth();
    if (!flow) return new Response(JSON.stringify({ error: "Google sign-in is not configured on this server." }), { status: 404, headers: JSON_HEADERS });
    try {
      return await pick(flow)(req);
    } catch (err) {
      console.error("[mcp-oauth] unhandled error", err);
      return new Response(JSON.stringify({ error: "server_error" }), { status: 500, headers: JSON_HEADERS });
    }
  };
