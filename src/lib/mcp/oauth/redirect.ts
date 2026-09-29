// Redirect-URI policy. The redirect URI is where an authorization code is sent, so it is the
// single most attacked field in OAuth. Rules:
//  - https, or http ONLY to a loopback host (native apps), or a private-use custom scheme
//  - no fragment, no embedded credentials, bounded length
//  - dangerous schemes (javascript:, data:, …) are refused outright
//  - at /authorize the requested URI must EXACTLY equal a registered one — except that for a
//    registered loopback URI the port may differ (RFC 8252 §7.3: native apps bind a random port)

const MAX_LEN = 512;
const DENIED_SCHEMES = new Set(["javascript", "data", "vbscript", "file", "blob", "about", "ftp", "ws", "wss", "chrome", "view-source"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** null when acceptable, otherwise a human-readable reason. */
export function validateRedirectUri(uri: unknown): string | null {
  if (typeof uri !== "string" || uri.length === 0) return "redirect_uri must be a non-empty string";
  if (uri.length > MAX_LEN) return `redirect_uri is longer than ${MAX_LEN} characters`;
  if (/[\s\u0000-\u001f]/.test(uri)) return "redirect_uri must not contain whitespace or control characters";
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return "redirect_uri is not a valid URI";
  }
  if (u.hash) return "redirect_uri must not contain a fragment";
  if (u.username || u.password) return "redirect_uri must not contain credentials";
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (DENIED_SCHEMES.has(scheme)) return `redirect_uri scheme "${scheme}" is not allowed`;
  if (scheme === "https") return u.hostname ? null : "redirect_uri needs a host";
  if (scheme === "http") return LOOPBACK.has(u.hostname) ? null : "http redirect_uri is only allowed for localhost";
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) ? null : "redirect_uri scheme is not valid";
}

const isLoopbackHttp = (u: URL) => u.protocol === "http:" && LOOPBACK.has(u.hostname);

export function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let r: URL;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackHttp(r)) return false;
  return registered.some((reg) => {
    try {
      const g = new URL(reg);
      return isLoopbackHttp(g) && g.hostname === r.hostname && g.pathname === r.pathname && g.search === r.search;
    } catch {
      return false;
    }
  });
}
