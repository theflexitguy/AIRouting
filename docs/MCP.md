# Routiq MCP server

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that lets any MCP-capable
LLM read everything on the Routiq dashboard — from the one-call overview down to individual stops and
subscriptions — using the *same code* that computes the numbers you see in the app.

- **Endpoint:** `POST https://<your-domain>/api/mcp` (Streamable HTTP, stateless, JSON responses)
- **Auth:** sign in with your **@flexpestcontrol.com Google account** (OAuth 2.1 + PKCE), or — optionally — a static `Authorization: Bearer <MCP_API_KEY>`
- **Surface:** 20 tools, 2 resources, 5 prompts
- **Writes:** none. Nothing here can change data — see [Security](#security-model).
- **Cost:** reads Firestore only. It never calls Google (Routes / Route Optimization) or FieldRoutes.

---

## 1. Set it up

### Environment variables

Add these in Vercel → project → Settings → Environment Variables (**Production**), then redeploy and promote.

| Variable | Required | Meaning |
|---|---|---|
| `MCP_API_KEY` | no* | A static bearer token, 24+ characters (`openssl rand -hex 32`). **Leave it unset if you want sign-in only** |
| `MCP_API_KEYS` | no | Comma-separated extra static keys, for zero-downtime rotation (see below) |
| `MCP_COMPANY_ID` | recommended | Which company to expose. Falls back to `FIELDROUTES_COMPANY_ID`, then to the only company if exactly one exists. Otherwise the server refuses rather than guess |
| `MCP_CACHE_TTL_SECONDS` | no | How long Firestore reads are reused (default `60`; `0` disables) |

\* You need **either** Google sign-in ([§2](#2-sign-in-with-google)) **or** a static key. **With neither configured the endpoint is closed (HTTP 503)** — it cannot be left accidentally open.
The static key is a single shared secret with no notion of *who* is calling; if you use sign-in, prefer to leave it unset.

### Verify

```bash
URL=https://<your-domain>/api/mcp
KEY=<your MCP_API_KEY>

# 1. No token → 401
curl -s -X POST $URL -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 2. With the token → the 20 tools
curl -s -X POST $URL -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400

# 3. A real number
curl -s -X POST $URL -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_data_freshness","arguments":{}}}'
```

### Rotate the static key

1. Add the new key to `MCP_API_KEYS` (keep the old one in `MCP_API_KEY`), redeploy.
2. Move clients to the new key.
3. Promote the new key to `MCP_API_KEY`, clear `MCP_API_KEYS`, redeploy.

---

## 2. Sign in with Google

With this configured, anyone who connects to the MCP is sent to Google to sign in, and **only accounts on your
Google Workspace domain (default `flexpestcontrol.com`) are admitted**. Each person is identified, so requests
are attributable, and nothing is shared: there is no key to leak.

### What you do (about 10 minutes)

**a. Create a Google OAuth client** — Google Cloud Console → *APIs & Services* → *Credentials* → *Create credentials* → *OAuth client ID*.

| Field | Value |
|---|---|
| Application type | **Web application** |
| Authorized redirect URI | `https://<your-domain>/api/oauth/google/callback` — must match `MCP_PUBLIC_URL` **exactly** |

Then open *OAuth consent screen* and set the user type to **Internal**, if your Cloud project belongs to the
flexpestcontrol.com Workspace organisation. That makes Google itself refuse anyone outside the company — a second
layer under this server's own check. The only scopes needed are `openid` and `email`, which need no Google verification.

**b. Add these environment variables** (Vercel → Production), then redeploy and promote:

| Variable | Value |
|---|---|
| `MCP_PUBLIC_URL` | The one https address clients use, e.g. `https://myroutiq.vercel.app` (origin only, no path). Tokens are bound to it |
| `MCP_GOOGLE_CLIENT_ID` | From step a |
| `MCP_GOOGLE_CLIENT_SECRET` | From step a |
| `MCP_OAUTH_SECRET` | 32+ random characters (`openssl rand -hex 32`). Signs every token the server issues |
| `MCP_ALLOWED_DOMAIN` | Optional. Default `flexpestcontrol.com` |
| `MCP_ALLOWED_EMAILS` | Optional. Comma-separated. If set, only these people — a good idea, since *any* employee could otherwise read customer data |

If any of the four required values is missing, sign-in stays **off** (it is never half-enabled) and the server log says which is missing.

**c. (Optional) Let Firestore clean up.** Add a TTL policy on the field `expiresAt` for the collections `mcpOAuthCodes`
and `mcpOAuthRefreshTokens` so expired records are purged automatically. The server already refuses expired records; this is only housekeeping.

### What users see

1. They add the server URL to their client (§3). No key, no header.
2. The client opens a browser to Google. They sign in with their `@flexpestcontrol.com` account.
3. A consent screen says who is asking and where they'll be sent back, and that the app can **read** dashboard data including customer names, addresses and balances. They click **Allow**.
4. Done. The client stays signed in (a refresh token, rotated on every use, lasts up to 30 days and never beyond 90 without signing in again).

### How the domain is enforced

The server accepts a Google account only if **all** of these hold, checked on the server against Google's signed ID token:
`email_verified` is true · the `hd` (hosted-domain) claim equals the domain · the address ends in `@<domain>` · and, if set, it is on `MCP_ALLOWED_EMAILS`.

The `hd` check is the one that matters. Anyone can create a Google account using a non-Gmail address they can receive mail at, and
Google will report that address as verified — but only accounts actually managed by your Workspace carry `hd`. Checking the email
suffix alone would let a look-alike account in; a test covers exactly that case. The `hd` parameter sent to Google's account chooser is only a
display hint and is never trusted. The allow-list and domain are re-checked on **every** request, so removing someone takes effect immediately.

### Revoking access

| To stop… | Do this | Takes effect |
|---|---|---|
| One person | Remove them from `MCP_ALLOWED_EMAILS` (or, if you use only the domain, add an allow-list that excludes them) and redeploy | Immediately on next request |
| One person's long-lived session | Delete their documents in `mcpOAuthRefreshTokens` | Their access token dies within 1 hour |
| **Everyone, right now** | Change `MCP_OAUTH_SECRET` and redeploy | Immediately — every token and registration becomes invalid |

Access tokens live 1 hour and cannot be revoked individually before then; that is the trade for not hitting the database on every request.

---

## 3. Connect a client

### With Google sign-in (recommended)

Just give the client the URL — it discovers sign-in on its own and opens your browser.

- **Claude Code:** `claude mcp add --transport http routiq https://<your-domain>/api/mcp`, then run `/mcp` inside Claude Code and choose *Authenticate*.
- **Claude Desktop / claude.ai / other apps with "custom connectors":** add a connector with the URL `https://<your-domain>/api/mcp` and leave the OAuth fields blank — the app registers itself.
- **Cursor / VS Code / MCP Inspector:** add the server by URL; approve the sign-in when prompted.

Any client that implements MCP authorization (OAuth 2.1 with PKCE and dynamic client registration) works. If a client asks for a
"client ID"/"secret", leave them empty. Check your client's documentation for exact menus, which vary by version.

### With the static key (if you kept `MCP_API_KEY`)

Clients that support **custom headers** connect directly; check your client's documentation for its exact syntax.

**Claude Code**
```bash
claude mcp add --transport http routiq https://<your-domain>/api/mcp \
  --header "Authorization: Bearer <MCP_API_KEY>"
```

**Claude Desktop** (via the `mcp-remote` bridge, in `claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "routiq": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-domain>/api/mcp",
               "--header", "Authorization:${ROUTIQ_AUTH}"],
      "env": { "ROUTIQ_AUTH": "Bearer <MCP_API_KEY>" }
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json`) / **VS Code** (`.vscode/mcp.json`, use `"servers"` with `"type": "http"`)
```json
{ "mcpServers": { "routiq": { "url": "https://<your-domain>/api/mcp",
                              "headers": { "Authorization": "Bearer <MCP_API_KEY>" } } } }
```

**OpenAI Responses API**
```json
{ "type": "mcp", "server_label": "routiq", "server_url": "https://<your-domain>/api/mcp",
  "authorization": "<MCP_API_KEY>", "require_approval": "never" }
```

**MCP Inspector**: `npx @modelcontextprotocol/inspector` → Streamable HTTP → URL above → add the `Authorization` header.

> A client that supports neither MCP sign-in nor custom headers can't connect. For a header-only client with no sign-in support, `mcp-remote` bridges it to either method.

---

## 4. What's in it — broad to granular

Start with `get_dashboard_overview`. Every number in it says which tool opens the detail behind it.

| Dashboard element | Tool | Drill down to |
|---|---|---|
| **Whole dashboard** (cards, KPIs, targets, overdue, buckets, trend) | `get_dashboard_overview` | everything below |
| Today / date-range cards: Routes, Total Stops, Completed, Stops Remaining, Drive Time, Route Value, Stops/Hour | `get_route_summary` | `list_routes` → `get_route`, `list_stops` |
| This Week KPIs + 8-Week Trend | `get_kpis_and_trend` | |
| Targets by Service (live · as-of a past date · last month/quarter/year) | `get_targets_by_service` | `audit_target` (every subscription behind a target) |
| Overdue Stops (counted **and** excluded, with reasons) | `get_overdue_stops` | `get_job` |
| Completed This Month (initials, reservices, follow-ups, specialty, wildlife) + New Business | `get_completed_breakdown` | `get_monthly_history` |
| Technicians Needed — 12-month forecast | `get_technician_forecast` | |
| Jobs Due This Week | in the overview; `search_jobs` with `dueFrom`/`dueTo` | |
| The subscriptions themselves | `search_jobs` · `get_job` · `aggregate_jobs` | |
| Technicians and their workload | `list_technicians` | `get_route` |
| Filter dropdown contents | `get_filter_options` | |
| Thresholds and settings | `get_configuration` | |
| What a metric means | `explain_metric` | |
| How current the data is | `get_data_freshness` | |

**Resources** — `routiq://guide` (usage + tool map) and `routiq://glossary` (definition, formula, source and caveats for every metric).

**Prompts** — `daily_briefing`, `weekly_review`, `audit_metric`, `technician_review`, `collections_focus`.

### Filters

The route tools accept the dashboard's filter bar: `technicians`, `routeGroups`, `routeTemplates`,
`subscriptionTypes`, `stopTypes` (`regular` · `initial` · `reservice`), `startDate` + `endDate`, `skipWeekends`.
Values are matched case-insensitively and an unknown one returns an error that lists the valid values.
`subscriptionTypes` and `stopTypes` are **stop-level** and compose: *General Pest + initial* returns only the
General Pest first-visits. Targets and overdue are company-wide, as on the dashboard.

### Pagination

List tools take `limit` (1–200, default 50) and `offset`, and return `total`, `hasMore` and `nextOffset`.
A response over ~120k characters is refused with a message telling the model to narrow it.

### Example questions

- "Give me today's briefing." → `daily_briefing`
- "Which service lines are behind pace, and by how much?" → `get_targets_by_service`
- "Why is the Lawn target what it is?" → `audit_target` (`line: lawn`)
- "Who's overdue but blocked by a balance, biggest first?" → `get_overdue_stops` (`include: excluded`, `sortBy: balance`)
- "How many initials did Kalin do this week?" → `get_route_summary` (`technicians`, `stopTypes: ["initial"]`, week range)
- "Where was General Pest last Friday?" → `get_targets_by_service` (`mode: as_of`)
- "When is customer 29852's next service, and is it on a route?" → `get_job`

---

## 5. How fresh is the data?

**Nothing here is live from FieldRoutes.** Numbers reflect the last sync (a nightly cron plus manual syncs), and
route completions are stamped when the sync reconciles a day. Past days are finalized about a day after they
occur and are then no longer re-verified. `get_data_freshness` reports the last sync, whether one is running,
the finalized-through date and today's FieldRoutes API usage; the overview repeats a warning when the data
is more than ~30 hours old. A model should check it before calling anything "current".

The MCP shows what is **stored**. It does not trigger a sync or verify a range against FieldRoutes (the dashboard's
date-range picker can); for a past range that was never verified, the dashboard may show slightly different numbers.

---

## 6. Security model

**Read-only by construction.** Every tool reads through a `DashboardDataSource` interface that contains only
getters; there is no write method for a tool to call. Tools are annotated `readOnlyHint: true`. A test asserts both.

**Authentication.** Fail-closed: neither sign-in nor a key configured → 503. Credentials are accepted from the
`Authorization` header (or `X-API-Key`) **only, never the query string** (URLs end up in logs). No data is read, and no
company is resolved, before authentication succeeds — a test asserts that. Two credential types:
- **A signed-in user's access token** (a short-lived signed JWT). Its signature, issuer, **audience** (this exact MCP endpoint),
  expiry and the user's domain/allow-list are all checked on every request. The algorithm is pinned to HS256 (the `alg: none` downgrade is
  rejected), and each token type is signed with a different derived key, so a token minted for one purpose can't be replayed as another.
- **The static key**, if configured, compared as SHA-256 digests with `timingSafeEqual` against every key with no early exit. Nothing logs or returns a key.

**The sign-in flow (OAuth 2.1).** PKCE with S256 is mandatory (`plain` is refused). Redirect URIs must match exactly what a client
registered (loopback clients may vary only the port), and the server **never redirects** until the client and redirect address are
proven — so it can't be used as an open redirector. Authorization codes are single-use (consumed atomically, even on a failed attempt), expire in 60
seconds and are stored only as hashes. Refresh tokens rotate on every use, and a spent one is remembered: if it is ever presented again (a copy was stolen and used), the
whole session — every token descended from that sign-in — is revoked and the person signs in again. Only hashes are stored. Client registration is **stateless** (the client ID is a signed token), so an unauthenticated caller can never cause a database write. The sign-in must
finish in the browser that started it (a bound cookie), and the consent screen — which shows the requesting app and its return address, cannot be framed, and escapes
everything an app can influence — must be approved by the signed-in person before any code is issued.

**Output whitelists.** Every record passes through an explicit field whitelist; nothing is spread out of a
database document. In particular:
- The **company document holds FieldRoutes API credentials** — only `name`, saved route groups and the growth
  setting are ever read from it.
- **Technician documents hold home start/end coordinates** — read with a Firestore field mask that excludes them,
  so they never enter memory, let alone a response.
- Route documents are read through a field mask that excludes route geometry.
- A privacy test seeds a phone number, email, latitude and API key into the fixture and asserts none of them
  appear in the output of **any** tool.

**Errors.** A bad request returns a message naming the valid values. Server faults return a generic message; the
real error goes only to the server log. Logs record tool name, duration and outcome — never arguments or results.

### What it does *not* protect — read this

- **Customer names, addresses and balances are exposed** to whoever holds the key (subscriptions, overdue lists, stops).
  This is the same data the dashboard's drill-downs show, and it will be sent to whichever LLM provider your client uses.
  Only connect clients and providers you are comfortable receiving it.
- **Everyone in the domain sees everything.** There are no per-user roles or scopes: any admitted person can read all dashboard data.
  Use `MCP_ALLOWED_EMAILS` to limit it to specific people.
- **Who did what.** With sign-in, each request is logged as `authorized user:<email>` (plus `consent granted` and `token issued`), so you can see who is using it.
  The static key, if enabled, is anonymous — one shared secret. Treat it like a password and prefer leaving it unset.
- **Access tokens can't be revoked individually** for up to an hour (see *Revoking access*).
- **No rate limiting.** The read cache bounds Firestore cost (see below), but a compromised account or key can still read data.
- **Phishing.** Sign-in is only as safe as the person approving it: read the consent screen. If an unexpected consent screen appears, choose Cancel.
- **Free text is untrusted.** Customer names, addresses and scheduling notes are typed by other people and are returned
  to the model verbatim, so a hostile note could try to steer it (prompt injection). The server instructions tell the model to
  treat results as data, but that is a mitigation, not a guarantee: keep a human in the loop for any action a model takes
  on the strength of this data, and do not give the same model write access elsewhere without approval steps.
- **CORS is `*` on the API and token endpoints.** Credentials travel in a header, never a cookie, so there is no ambient authority for a web page to abuse. (The one cookie, a short-lived sign-in binding, is `HttpOnly`, `Secure`, `SameSite=Lax` and only used by the sign-in pages.)

---

## 7. Cost

The MCP reads Firestore only. The expensive read is the in-scope `jobs` collection (one read per subscription —
the dashboard page does the same on every load). It is cached per server instance for `MCP_CACHE_TTL_SECONDS`
(default 60s), with concurrent callers sharing one in-flight read, and failed reads are never cached. A model
making ten tool calls in a minute therefore costs about one jobs read, not ten. It uses no Google or FieldRoutes API quota.

---

## 8. How it's built

```
src/app/api/mcp/route.ts        thin Next.js route: resolves the company, hands off to the handler
src/lib/mcp/handler.ts          CORS → auth → method → company → MCP transport
src/lib/mcp/auth.ts, config.ts  bearer auth (user token or static key), environment
src/lib/mcp/oauth/*             Google sign-in: flow.ts (endpoints), google.ts (the domain policy), jwt.ts, pkce.ts,
                                redirect.ts, clients.ts (stateless registration), store (codes + refresh tokens)
src/app/api/oauth/*, .well-known/*   thin Next.js routes for the sign-in endpoints and discovery documents
src/lib/mcp/data-source.ts      the read-only contract (+ firestore-source.ts, memory-source.ts)
src/lib/mcp/snapshot.ts         builds the dashboard state — the same pipeline the page runs
src/lib/mcp/public.ts           output whitelists
src/lib/mcp/tools/*.ts          the 20 tools
src/lib/mcp/glossary.ts         metric dictionary + server instructions
src/lib/dashboard/*             THE dashboard math, shared with the page (see below)
```

**One source of truth.** The dashboard's calculations used to live inline in `page.tsx`. They now live in
`src/lib/dashboard/` and **both the page and the MCP call them**, so a number cannot differ between the two. When
that code was moved, it was spliced from the original source by line range and verified byte-identical. **If you
change how a dashboard number is computed, change it there — do not re-implement it in a tool.**

**Adding a tool**
1. Register it with `defineTool` in `src/lib/mcp/tools/` (uniform read-only annotations, error handling, logging).
2. Return only whitelisted fields (`public.ts`) — never spread a document.
3. Add it to the `ALL_TOOLS` and `CALLS` lists in `tools.test.ts` (the privacy test will then cover it).
4. Add a row to the table above.

---

## 9. Development

```bash
npm test          # auth, HTTP handler, Firestore source (against a fake db), every tool, the dashboard math
```

The tests use Node's built-in runner. `scripts/alias-hooks.mjs` (used only by `npm test`) resolves the `@/` path
alias so the real source is imported unchanged. Because Node strips types rather than compiling them, code that
the tests load avoids constructor parameter properties.

Tools run against an in-memory data source in tests (`memory-source.ts`, `test-fixtures.ts`), so no Firebase
credentials are needed.

## 10. Troubleshooting

| Symptom | Cause |
|---|---|
| `503 … not configured` | Neither sign-in nor `MCP_API_KEY` is configured (a key must be 24+ characters) |
| `401 Invalid credentials` | Wrong key, or sent as a query parameter (only the header is accepted) |
| `503 … does not exist` / `cannot be determined` | `MCP_COMPANY_ID` is wrong or unset, and there is more than one company |
| `503 … temporarily unavailable` | Firestore unreachable or credentials missing (`FIREBASE_SERVICE_ACCOUNT`) |
| Tools return empty results | The configured company has no synced data — check `get_data_freshness` |
| Numbers look old | The last sync was a while ago — `get_data_freshness` says how long |
| `404` on `/api/oauth/*` or `/.well-known/oauth-*` | Sign-in isn't configured. The server log names the missing variable (`[mcp-oauth] … Missing: …`) |
| Google shows `redirect_uri_mismatch` | The redirect URI in the Google console must be exactly `<MCP_PUBLIC_URL>/api/oauth/google/callback` (same scheme, host, no trailing slash) |
| "Access denied" after signing in | The account isn't a `flexpestcontrol.com` **Workspace** account (a personal account using that address won't pass), or it isn't on `MCP_ALLOWED_EMAILS` |
| "Sign-in must finish in the same browser" | The sign-in was started in another browser or window; start again from the app and finish in the same one |
| A client can't connect | It may support neither MCP sign-in nor custom headers; use the `mcp-remote` bridge |
| Sign-in works locally but not on a preview URL | Tokens are bound to `MCP_PUBLIC_URL`, and preview deployments have different addresses (and Vercel may require its own login); use the production address |

## 11. Not included

Routing and route generation, the Route Builder, the Jobs/History/Learning/Settings pages, and any write action.
The MCP covers the **dashboard** and the records beneath it.
