// Authentication and tenant isolation for the app's API routes.
//
// These routes talk to Firestore with the Admin SDK, which BYPASSES the Firestore security rules — so the routes
// themselves are the only thing standing between the internet and every company's data. Every route therefore
// goes through `guarded(...)`; a test (api-auth.routes.test.ts) fails the build if a route file forgets to.
//
// Three ways in:
//   * a signed-in user  — `Authorization: Bearer <Firebase ID token>`. Their company comes from THEIR profile
//     (users/{uid}), never from the request; a request that names a different company is refused.
//   * the operator      — the deployment's CRON_SECRET (Vercel cron, and the maintainer's own curl commands).
//                         May act on any company.
//   * nobody            — 401.
//
// Access levels:
//   "company"        any signed-in member of the company (reads)
//   "company-write"  same, but refuses accounts explicitly marked role "viewer" (changes data / spends money)
//   "operator"       CRON_SECRET only — maintenance, debugging and destructive tools that no dashboard user needs

import { timingSafeEqual } from "node:crypto";

export type Access = "company" | "company-write" | "operator";

export interface Profile {
  companyId: string;
  role: string;
}

export interface AuthDeps {
  verifyIdToken(token: string): Promise<{ uid: string; email?: string }>;
  loadProfile(uid: string): Promise<Profile | null>;
  operatorSecret(): string;
  now(): number;
}

export interface ApiAuth {
  kind: "user" | "operator";
  uid?: string;
  email?: string;
  /** The signed-in user's own company (undefined for the operator). */
  companyId?: string;
  role?: string;
  /** May this caller act on `companyId`? The operator may act on any; a user only on their own. */
  mayAccess(companyId: string): boolean;
}

export interface GuardOptions {
  /**
   * The route knows how to fall back to the caller's own company (`auth.companyId`) when the request names none.
   * Otherwise a signed-in user's request must name its company, so no route can silently fall through to
   * "the first company in the database".
   */
  implicitCompany?: boolean;
  /** The request body is multipart (large upload); the route parses it itself and must call `auth.mayAccess`. */
  routeChecksCompany?: boolean;
}

type Handler<R extends Request> = (req: R, auth: ApiAuth) => Promise<Response> | Response;

const json = (status: number, error: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const unauthorized = () => json(401, "unauthorized", { "www-authenticate": 'Bearer realm="routiq"' });
const forbidden = () => json(403, "forbidden");

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Does the request carry the operator secret (Bearer, x-cron-secret, or ?secret=)? */
function presentsOperatorSecret(req: Request, secret: string): boolean {
  if (!secret) return false; // no secret configured => nobody is the operator (fail closed)
  const bearer = bearerToken(req);
  if (bearer && safeEqual(bearer, secret)) return true;
  const header = req.headers.get("x-cron-secret");
  if (header && safeEqual(header, secret)) return true;
  const query = new URL(req.url).searchParams.get("secret");
  return !!query && safeEqual(query, secret);
}

function bearerToken(req: Request): string {
  const h = req.headers.get("authorization") || "";
  return /^Bearer /i.test(h) ? h.slice(7).trim() : "";
}

/**
 * Every companyId the request names, wherever the route might read it from: the query string and a top-level
 * `companyId` in a JSON body. The body is parsed as JSON REGARDLESS of Content-Type, because the routes call
 * `request.json()` without looking at it — trusting the header would let a caller hide the value from this check.
 * Returns null if a value is present but isn't a string.
 */
async function claimedCompanyIds(req: Request, skipBody: boolean): Promise<string[] | null> {
  const ids: string[] = new URL(req.url).searchParams.getAll("companyId");
  if (!skipBody && req.method !== "GET" && req.method !== "HEAD") {
    let text = "";
    try {
      text = await req.clone().text();
    } catch {
      text = "";
    }
    if (text) {
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (body && typeof body === "object" && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, "companyId")) {
        const v = (body as Record<string, unknown>).companyId;
        if (v !== undefined && v !== null) {
          if (typeof v !== "string") return null;
          ids.push(v);
        }
      }
    }
  }
  return ids.filter((s) => s !== ""); // an empty value means "not given"
}

const PROFILE_TTL_MS = 30_000;
const PROFILE_CACHE_MAX = 500;

export function createGuard(deps: AuthDeps) {
  const cache = new Map<string, { profile: Profile; at: number }>();

  async function profileOf(uid: string): Promise<Profile | null> {
    const hit = cache.get(uid);
    if (hit && deps.now() - hit.at < PROFILE_TTL_MS) return hit.profile;
    const profile = await deps.loadProfile(uid);
    if (!profile) return null;
    if (cache.size >= PROFILE_CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(uid, { profile, at: deps.now() });
    return profile;
  }

  async function authorize(req: Request, access: Access, opts: GuardOptions): Promise<{ ok: true; auth: ApiAuth } | { ok: false; response: Response }> {
    if (presentsOperatorSecret(req, deps.operatorSecret())) {
      return { ok: true, auth: { kind: "operator", mayAccess: () => true } };
    }
    if (access === "operator") return { ok: false, response: unauthorized() };

    const token = bearerToken(req);
    if (!token) return { ok: false, response: unauthorized() };
    let decoded: { uid: string; email?: string };
    try {
      decoded = await deps.verifyIdToken(token);
    } catch {
      return { ok: false, response: unauthorized() };
    }
    let profile: Profile | null;
    try {
      profile = await profileOf(decoded.uid);
    } catch (e) {
      console.error("[api-auth] profile lookup failed", e instanceof Error ? e.message : e);
      return { ok: false, response: json(503, "temporarily unavailable") };
    }
    if (!profile || !profile.companyId) return { ok: false, response: forbidden() };
    if (access === "company-write" && profile.role === "viewer") return { ok: false, response: forbidden() };

    const mine = profile.companyId;
    const auth: ApiAuth = {
      kind: "user", uid: decoded.uid, email: decoded.email, companyId: mine, role: profile.role,
      mayAccess: (c) => c === mine,
    };

    const claimed = await claimedCompanyIds(req, !!opts.routeChecksCompany);
    if (claimed === null) return { ok: false, response: json(400, "companyId must be a string") };
    if (claimed.some((c) => c !== mine)) return { ok: false, response: forbidden() };
    if (claimed.length === 0 && !opts.implicitCompany && !opts.routeChecksCompany) return { ok: false, response: json(400, "companyId is required") };
    return { ok: true, auth };
  }

  function guarded<R extends Request>(access: Access, handler: Handler<R>, opts: GuardOptions = {}): (req: R) => Promise<Response> {
    return async (req: R) => {
      const g = await authorize(req, access, opts);
      if (!g.ok) return g.response;
      return handler(req, g.auth);
    };
  }

  return { authorize, guarded };
}
