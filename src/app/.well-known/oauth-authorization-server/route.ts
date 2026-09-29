export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { oauthRoute } from "@/lib/mcp/oauth/next";
export const GET = oauthRoute((f) => () => f.authorizationServerMetadata());
export const OPTIONS = oauthRoute((f) => () => f.preflight());
