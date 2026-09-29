# Routiq MCP server

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that lets any MCP-capable
LLM read everything on the Routiq dashboard — from the one-call overview down to individual stops and
subscriptions — using the *same code* that computes the numbers you see in the app.

- **Endpoint:** `POST https://<your-domain>/api/mcp` (Streamable HTTP, stateless, JSON responses)
- **Auth:** `Authorization: Bearer <MCP_API_KEY>`
- **Surface:** 20 tools, 2 resources, 5 prompts
- **Writes:** none. Nothing here can change data — see [Security](#security-model).
- **Cost:** reads Firestore only. It never calls Google (Routes / Route Optimization) or FieldRoutes.

---

## 1. Set it up

### Environment variables

Add these in Vercel → project → Settings → Environment Variables (**Production**), then redeploy and promote.

| Variable | Required | Meaning |
|---|---|---|
| `MCP_API_KEY` | **yes** | The bearer token clients present. At least 24 characters. Generate one: `openssl rand -hex 32` |
| `MCP_API_KEYS` | no | Comma-separated extra keys, for zero-downtime rotation (see below) |
| `MCP_COMPANY_ID` | recommended | Which company to expose. Falls back to `FIELDROUTES_COMPANY_ID`, then to the only company if exactly one exists. Otherwise the server refuses rather than guess |
| `MCP_CACHE_TTL_SECONDS` | no | How long Firestore reads are reused (default `60`; `0` disables) |

**With no valid `MCP_API_KEY` the endpoint is closed (HTTP 503).** It cannot be left accidentally open.

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

### Rotate the key

1. Add the new key to `MCP_API_KEYS` (keep the old one in `MCP_API_KEY`), redeploy.
2. Move clients to the new key.
3. Promote the new key to `MCP_API_KEY`, clear `MCP_API_KEYS`, redeploy.

---

## 2. Connect a client

The server speaks Streamable HTTP with a static bearer token. Clients that support **custom headers** connect
directly; check your client's documentation for its exact syntax.

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

> **Limitation.** Clients that only support OAuth (or no authentication) cannot connect: this server uses a
> shared static key, not an OAuth flow. Use a header-capable client or the `mcp-remote` bridge.

---

## 3. What's in it — broad to granular

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

## 4. How fresh is the data?

**Nothing here is live from FieldRoutes.** Numbers reflect the last sync (a nightly cron plus manual syncs), and
route completions are stamped when the sync reconciles a day. Past days are finalized about a day after they
occur and are then no longer re-verified. `get_data_freshness` reports the last sync, whether one is running,
the finalized-through date and today's FieldRoutes API usage; the overview repeats a warning when the data
is more than ~30 hours old. A model should check it before calling anything "current".

The MCP shows what is **stored**. It does not trigger a sync or verify a range against FieldRoutes (the dashboard's
date-range picker can); for a past range that was never verified, the dashboard may show slightly different numbers.

---

## 5. Security model

**Read-only by construction.** Every tool reads through a `DashboardDataSource` interface that contains only
getters; there is no write method for a tool to call. Tools are annotated `readOnlyHint: true`. A test asserts both.

**Authentication.** Fail-closed (no key → 503). The token is compared as a SHA-256 digest with `timingSafeEqual`
against every configured key with no early exit. It is accepted from the `Authorization` header or `X-API-Key`
**only, never the query string** (URLs end up in logs). Nothing logs or returns a key. No data is read, and no
company is resolved, before authentication succeeds — a test asserts that.

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
- **One shared key.** There are no per-user identities, no per-user audit trail and no per-key scopes.
  Treat the key like a password: never paste it into a chat, rotate it if it may have leaked.
- **No rate limiting.** The read cache bounds Firestore cost (see below), but a leaked key can still be used to read data.
- **Free text is untrusted.** Customer names, addresses and scheduling notes are typed by other people and are returned
  to the model verbatim, so a hostile note could try to steer it (prompt injection). The server instructions tell the model to
  treat results as data, but that is a mitigation, not a guarantee: keep a human in the loop for any action a model takes
  on the strength of this data, and do not give the same model write access elsewhere without approval steps.
- **CORS is `*`.** Credentials travel in a header, never a cookie, so there is no ambient authority for a web page to abuse.

---

## 6. Cost

The MCP reads Firestore only. The expensive read is the in-scope `jobs` collection (one read per subscription —
the dashboard page does the same on every load). It is cached per server instance for `MCP_CACHE_TTL_SECONDS`
(default 60s), with concurrent callers sharing one in-flight read, and failed reads are never cached. A model
making ten tool calls in a minute therefore costs about one jobs read, not ten. It uses no Google or FieldRoutes API quota.

---

## 7. How it's built

```
src/app/api/mcp/route.ts        thin Next.js route: resolves the company, hands off to the handler
src/lib/mcp/handler.ts          CORS → auth → method → company → MCP transport
src/lib/mcp/auth.ts, config.ts  bearer auth, environment
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

## 8. Development

```bash
npm test          # auth, HTTP handler, Firestore source (against a fake db), every tool, the dashboard math
```

The tests use Node's built-in runner. `scripts/alias-hooks.mjs` (used only by `npm test`) resolves the `@/` path
alias so the real source is imported unchanged. Because Node strips types rather than compiling them, code that
the tests load avoids constructor parameter properties.

Tools run against an in-memory data source in tests (`memory-source.ts`, `test-fixtures.ts`), so no Firebase
credentials are needed.

## 9. Troubleshooting

| Symptom | Cause |
|---|---|
| `503 … not configured` | `MCP_API_KEY` is unset or shorter than 24 characters |
| `401 Invalid credentials` | Wrong key, or sent as a query parameter (only the header is accepted) |
| `503 … does not exist` / `cannot be determined` | `MCP_COMPANY_ID` is wrong or unset, and there is more than one company |
| `503 … temporarily unavailable` | Firestore unreachable or credentials missing (`FIREBASE_SERVICE_ACCOUNT`) |
| Tools return empty results | The configured company has no synced data — check `get_data_freshness` |
| Numbers look old | The last sync was a while ago — `get_data_freshness` says how long |
| A client can't connect | It may only support OAuth; use the `mcp-remote` bridge |

## 10. Not included

Routing and route generation, the Route Builder, the Jobs/History/Learning/Settings pages, and any write action.
The MCP covers the **dashboard** and the records beneath it.
