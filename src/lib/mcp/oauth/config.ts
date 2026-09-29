// OAuth (Google sign-in) configuration, read from the environment.
//
//   MCP_PUBLIC_URL           the canonical https origin clients reach this server on, e.g.
//                            https://myroutiq.vercel.app  (no path). Tokens are bound to it.
//   MCP_GOOGLE_CLIENT_ID     Google OAuth "Web application" client id
//   MCP_GOOGLE_CLIENT_SECRET its secret
//   MCP_OAUTH_SECRET         32+ random characters; signs every token this server issues
//   MCP_ALLOWED_DOMAIN       Google Workspace domain allowed to sign in (default flexpestcontrol.com)
//   MCP_ALLOWED_EMAILS       optional comma-separated allow-list; empty = anyone in the domain
//
// If any required value is missing, sign-in is DISABLED (not half-enabled): the server then
// accepts only the static MCP_API_KEY, or refuses everything if that is unset too.

export const MIN_SECRET_LENGTH = 32;
export const SCOPE = "mcp:read";

export interface OAuthConfig {
  /** Origin only, no trailing slash. */
  publicUrl: string;
  /** The protected resource (the MCP endpoint) — the audience of every access token. */
  resource: string;
  googleClientId: string;
  googleClientSecret: string;
  secret: string;
  allowedDomain: string;
  /** Lower-cased. Empty = the whole domain. */
  allowedEmails: string[];
  accessTtlSec: number;
  refreshTtlSec: number;
  /** A refresh-token family can never live longer than this, however often it is rotated. */
  refreshMaxAgeSec: number;
  codeTtlSec: number;
}

type Env = Record<string, string | undefined>;

export interface OAuthConfigResult {
  config: OAuthConfig | null;
  /** Names of required variables that are missing or invalid (empty when configured, or when nothing was set). */
  missing: string[];
  /** True if ANY oauth variable was set — used to warn about a half-finished setup. */
  attempted: boolean;
}

export function readOAuthConfig(env: Env = process.env): OAuthConfigResult {
  const v = (k: string) => (env[k] || "").trim();
  const attempted = ["MCP_PUBLIC_URL", "MCP_GOOGLE_CLIENT_ID", "MCP_GOOGLE_CLIENT_SECRET", "MCP_OAUTH_SECRET"].some((k) => v(k));
  const missing: string[] = [];

  let publicUrl = "";
  try {
    const u = new URL(v("MCP_PUBLIC_URL"));
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol === "https:" || (u.protocol === "http:" && local)) publicUrl = u.origin;
  } catch {
    /* falls through to missing */
  }
  if (!publicUrl) missing.push("MCP_PUBLIC_URL (an https origin)");
  if (!v("MCP_GOOGLE_CLIENT_ID")) missing.push("MCP_GOOGLE_CLIENT_ID");
  if (!v("MCP_GOOGLE_CLIENT_SECRET")) missing.push("MCP_GOOGLE_CLIENT_SECRET");
  if (v("MCP_OAUTH_SECRET").length < MIN_SECRET_LENGTH) missing.push(`MCP_OAUTH_SECRET (at least ${MIN_SECRET_LENGTH} characters)`);
  if (missing.length) return { config: null, missing, attempted };

  return {
    attempted,
    missing: [],
    config: {
      publicUrl,
      resource: `${publicUrl}/api/mcp`,
      googleClientId: v("MCP_GOOGLE_CLIENT_ID"),
      googleClientSecret: v("MCP_GOOGLE_CLIENT_SECRET"),
      secret: v("MCP_OAUTH_SECRET"),
      allowedDomain: (v("MCP_ALLOWED_DOMAIN") || "flexpestcontrol.com").toLowerCase().replace(/^@/, ""),
      allowedEmails: v("MCP_ALLOWED_EMAILS").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
      accessTtlSec: 3600,
      refreshTtlSec: 30 * 86400,
      refreshMaxAgeSec: 90 * 86400,
      codeTtlSec: 60,
    },
  };
}
