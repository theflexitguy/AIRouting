// FieldRoutes API client.
//
// Verified contract (do not re-derive):
//  - POST {base}/{module}/{action}, Content-Type application/x-www-form-urlencoded.
//  - authenticationKey + authenticationToken are sent as form fields, appended LAST.
//  - search → returns an ID array under the key named in response.propertyName;
//    response.idName is the PK param used for pagination. Hard cap 50,000 IDs.
//    Never send includeData on search.
//  - get → POST /{module}/get with { "{module}IDs": [...] }; returns objects under
//    "{module}s". Hard cap 1,000 entities per call.
//  - response.ignoredParams must be []; if a filter is echoed there it was silently
//    dropped and we must fail loud.
//  - Limits: 3,000 reads/day, 60/min. Throttle to <= ~1 request/second.

const SEARCH_ID_CAP = 50_000;
const GET_CHUNK = 1_000;
const MIN_REQUEST_INTERVAL_MS = 1_100; // <= ~1 req/s, comfortably under 60/min

export interface FieldRoutesConfig {
  baseUrl: string;
  authKey: string;
  authToken: string;
  timeoutMs: number;
}

export function fieldRoutesConfigFromEnv(): FieldRoutesConfig {
  const baseUrl = (
    process.env.FR_BASE_URL ||
    process.env.FIELDROUTES_BASE_URL ||
    process.env.FIELDROUTES_NWA_BASE_URL ||
    ""
  )
    .trim()
    .replace(/\/+$/, "");
  const authKey = (process.env.FR_AUTH_KEY || process.env.FIELDROUTES_AUTH_KEY || "").trim();
  const authToken = (process.env.FR_AUTH_TOKEN || process.env.FIELDROUTES_AUTH_TOKEN || "").trim();

  if (!baseUrl) throw new Error("FR_BASE_URL (or FIELDROUTES_NWA_BASE_URL) is required.");
  if (!authKey) throw new Error("FR_AUTH_KEY (or FIELDROUTES_AUTH_KEY) is required.");
  if (!authToken) throw new Error("FR_AUTH_TOKEN (or FIELDROUTES_AUTH_TOKEN) is required.");

  return {
    baseUrl,
    authKey,
    authToken,
    timeoutMs: Number(process.env.FIELDROUTES_TIMEOUT_MS || 30_000) || 30_000,
  };
}

// Serialized request spacing that is correct even under concurrent callers:
// nextSlot is advanced synchronously before any await.
let nextSlot = 0;
async function acquireRateSlot() {
  const now = Date.now();
  const start = Math.max(now, nextSlot);
  nextSlot = start + MIN_REQUEST_INTERVAL_MS;
  const wait = start - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

type FilterValue = string | number | boolean | Record<string, unknown> | Array<unknown>;

function encodeForm(payload: Record<string, FilterValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    // FieldRoutes accepts JSON-encoded values for object/array filters (operators, ID lists).
    params.append(
      key,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    );
  }
  return params.toString();
}

export class FieldRoutesApiError extends Error {
  status?: number;
  endpoint?: string;
  body?: unknown;
  constructor(message: string, opts: { status?: number; endpoint?: string; body?: unknown } = {}) {
    super(message);
    this.name = "FieldRoutesApiError";
    this.status = opts.status;
    this.endpoint = opts.endpoint;
    this.body = opts.body;
  }
}

// Thrown when a request would exceed the per-run read budget (the company's
// daily API cap minus what's already been spent today). Callers catch this to
// stop gracefully and persist progress rather than blow past the FieldRoutes
// account-wide quota.
export class FieldRoutesBudgetError extends Error {
  readsSoFar: number;
  maxReads: number;
  constructor(readsSoFar: number, maxReads: number) {
    super(
      `FieldRoutes read budget exhausted: ${readsSoFar} reads this run reached the cap of ${maxReads}.`,
    );
    this.name = "FieldRoutesBudgetError";
    this.readsSoFar = readsSoFar;
    this.maxReads = maxReads;
  }
}

export class FieldRoutesClient {
  private reads = 0;
  // Hard cap on reads this client instance may perform (the remaining daily
  // budget). Defaults to no limit; set via setMaxReads() before a run.
  private maxReads = Infinity;

  constructor(private config: FieldRoutesConfig = fieldRoutesConfigFromEnv()) {}

  get readCount() {
    return this.reads;
  }

  /** Cap the reads this client may perform; the next read past it throws FieldRoutesBudgetError. */
  setMaxReads(limit: number) {
    this.maxReads = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  }

  private async request(
    module: string,
    action: string,
    payload: Record<string, FilterValue>,
  ): Promise<Record<string, unknown>> {
    // Refuse before consuming quota when the daily budget is exhausted.
    if (this.reads >= this.maxReads) {
      throw new FieldRoutesBudgetError(this.reads, this.maxReads);
    }
    const endpoint = `/${module}/${action}`;
    const url = `${this.config.baseUrl}${endpoint}`;
    // Auth fields appended LAST, per the verified contract.
    const form = encodeForm({
      ...payload,
      authenticationKey: this.config.authKey,
      authenticationToken: this.config.authToken,
    });

    const maxRetries = 4;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await acquireRateSlot();
      this.reads++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
          signal: controller.signal,
        });
        clearTimeout(timer);

        const text = await res.text();
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          body = { raw: text };
        }

        if (res.status === 429 || res.status >= 500) {
          lastErr = new FieldRoutesApiError(`HTTP ${res.status} on ${endpoint}`, {
            status: res.status,
            endpoint,
            body,
          });
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, Math.min(8000, 2 ** attempt * 500)));
            continue;
          }
          throw lastErr;
        }
        if (res.status >= 400) {
          throw new FieldRoutesApiError(`HTTP ${res.status} on ${endpoint}`, {
            status: res.status,
            endpoint,
            body,
          });
        }

        // Fail loud if any filter was silently dropped.
        const ignored = body.ignoredParams;
        if (Array.isArray(ignored) && ignored.length > 0) {
          throw new FieldRoutesApiError(
            `FieldRoutes ignored params on ${endpoint}: ${JSON.stringify(ignored)}`,
            { endpoint, body },
          );
        }
        const success = body.success;
        if (success === false) {
          throw new FieldRoutesApiError(
            `FieldRoutes reported failure on ${endpoint}: ${JSON.stringify(body.errors ?? body.error ?? "")}`,
            { endpoint, body },
          );
        }

        return body;
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof FieldRoutesApiError && err.status && err.status < 500 && err.status !== 429) {
          throw err;
        }
        lastErr = err;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, Math.min(8000, 2 ** attempt * 500)));
          continue;
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new FieldRoutesApiError(`Request failed for /${module}/${action}`, { endpoint });
  }

  /**
   * Search a module, returning the full list of primary-key IDs.
   * Handles the 50,000-ID pagination cap dynamically using the response's
   * own propertyName / idName fields. Never sends includeData.
   */
  async searchIds(module: string, filters: Record<string, FilterValue> = {}): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | number | null = null;

    // Fallback PK names if the response doesn't echo idName/propertyName.
    const fallbackIdName = `${module}ID`;
    const fallbackPropertyName = `${module}IDs`;
    let idName = fallbackIdName;

    for (;;) {
      const payload: Record<string, FilterValue> = { ...filters };
      if (cursor !== null) {
        payload[idName] = { operator: ">", value: cursor };
      }
      const body = await this.request(module, "search", payload);

      const propertyName =
        (typeof body.propertyName === "string" && body.propertyName) || fallbackPropertyName;
      idName = (typeof body.idName === "string" && body.idName) || fallbackIdName;

      const page = body[propertyName];
      const pageIds: string[] = Array.isArray(page) ? page.map((v) => String(v)) : [];
      ids.push(...pageIds);

      if (pageIds.length < SEARCH_ID_CAP) break;
      cursor = pageIds[pageIds.length - 1];
    }

    return ids;
  }

  /**
   * Fetch full entities for a list of IDs, chunked to the 1,000-entity cap.
   * Returns objects from the "{module}s" key (with dynamic fallback).
   *
   * Most modules take a `{module}IDs` param, but a few break the convention
   * (e.g. serviceType/get wants `typeIDs`). Pass `opts.idParam` to override.
   */
  async getEntities(
    module: string,
    ids: string[],
    opts: { idParam?: string } = {},
  ): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    const idParam = opts.idParam ?? `${module}IDs`;
    const primaryKey = `${module}s`;

    for (let i = 0; i < ids.length; i += GET_CHUNK) {
      const chunk = ids.slice(i, i + GET_CHUNK);
      if (chunk.length === 0) continue;
      const body = await this.request(module, "get", { [idParam]: chunk });

      let entities = body[primaryKey];
      if (!Array.isArray(entities)) {
        // Dynamic fallback: first array-valued property in the response.
        const arrayProp = Object.values(body).find((v) => Array.isArray(v));
        entities = Array.isArray(arrayProp) ? arrayProp : [];
      }
      out.push(...(entities as Record<string, unknown>[]));
    }

    return out;
  }
}
