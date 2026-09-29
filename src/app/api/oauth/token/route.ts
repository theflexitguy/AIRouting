export const dynamic = "force-dynamic";
export const runtime = "nodejs";
import { oauthRoute } from "@/lib/mcp/oauth/next";
export const POST = oauthRoute((f) => f.token);
export const OPTIONS = oauthRoute((f) => () => f.preflight());
