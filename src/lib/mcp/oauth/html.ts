// The two pages a person actually sees: the consent screen and error pages. Both display text that
// an attacker can influence (a client's chosen name and redirect address), so every interpolated
// value goes through esc(). The pages send anti-framing headers so they cannot be embedded in a
// hostile site for clickjacking, and a CSP that forbids scripts entirely (there are none).
//
// The CSP deliberately has no `form-action`: Chrome applies form-action to the redirects that
// follow a form POST, and the consent POST answers with a redirect to the client's own address.

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" })[c] as string);
}

const HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

const STYLE = `
body{font:16px/1.5 system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;display:grid;place-items:center;min-height:100vh;padding:1rem}
main{background:#1e293b;border:1px solid #334155;border-radius:12px;max-width:34rem;width:100%;padding:1.75rem}
h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:.5rem 0;color:#cbd5e1}
code{background:#0f172a;padding:.15rem .4rem;border-radius:4px;word-break:break-all;color:#e2e8f0}
.warn{border-left:3px solid #f59e0b;padding-left:.75rem;color:#fcd34d}
.row{display:flex;gap:.75rem;margin-top:1.25rem}
button{font:inherit;padding:.6rem 1.1rem;border-radius:8px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;cursor:pointer}
button.allow{background:#2563eb;border-color:#2563eb;color:#fff}`;

const doc = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

export function htmlResponse(status: number, title: string, body: string, extra: Record<string, string> = {}): Response {
  return new Response(doc(title, body), { status, headers: { ...HEADERS, ...extra } });
}

export function errorPage(status: number, title: string, message: string, extra: Record<string, string> = {}): Response {
  return htmlResponse(status, title, `<h1>${esc(title)}</h1><p>${esc(message)}</p><p>You can close this window.</p>`, extra);
}

export function consentPage(p: { email: string; clientName: string; redirectUri: string; token: string; action: string }, extra: Record<string, string> = {}): Response {
  return htmlResponse(
    200,
    "Authorize access to Routiq",
    `<h1>Allow <code>${esc(p.clientName)}</code> to access Routiq?</h1>
<p>Signed in as <strong>${esc(p.email)}</strong>.</p>
<p>This application will be able to <strong>read</strong> Routiq dashboard data as you: routes, stops, service targets and overdue accounts — <strong>including customer names, addresses and balances</strong>. It cannot change anything.</p>
<p>After you choose, you will be sent to:<br><code>${esc(p.redirectUri)}</code></p>
<p class="warn">Only continue if you just started connecting this application yourself. If someone sent you here, choose Cancel.</p>
<form method="post" action="${esc(p.action)}">
<input type="hidden" name="token" value="${esc(p.token)}">
<div class="row"><button class="allow" type="submit" name="decision" value="allow">Allow</button><button type="submit" name="decision" value="deny">Cancel</button></div>
</form>`,
    extra,
  );
}
