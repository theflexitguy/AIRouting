import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

// A static check over every route file under src/app: each HTTP method must be wrapped in `guarded(...)`, unless the
// route is listed here with the reason it authenticates some other way. Adding a route without a guard fails the build.

const ROOT = join(process.cwd(), "src/app");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** route (relative to src/app) -> why it is exempt, and a string its source must contain to prove it. */
const OWN_AUTH: Record<string, { why: string; proof: string }> = {
  "api/mcp/route.ts": { why: "the MCP endpoint checks its own bearer token / API key (lib/mcp/auth)", proof: "handleMcp" },
  "api/oauth/authorize/route.ts": { why: "OAuth endpoint, public by protocol", proof: "oauthRoute" },
  "api/oauth/consent/route.ts": { why: "OAuth endpoint, public by protocol", proof: "oauthRoute" },
  "api/oauth/google/callback/route.ts": { why: "OAuth endpoint, public by protocol", proof: "oauthRoute" },
  "api/oauth/register/route.ts": { why: "OAuth endpoint, public by protocol", proof: "oauthRoute" },
  "api/oauth/revoke/route.ts": { why: "OAuth endpoint, public by protocol", proof: "oauthRoute" },
  "api/oauth/token/route.ts": { why: "OAuth endpoint, public by protocol", proof: "oauthRoute" },
  ".well-known/oauth-authorization-server/route.ts": { why: "public discovery metadata", proof: "oauthRoute" },
  ".well-known/oauth-protected-resource/[[...path]]/route.ts": { why: "public discovery metadata", proof: "oauthRoute" },
  "api/account/init/route.ts": { why: "a brand-new user has no profile yet; verifies the ID token itself", proof: "verifyIdToken" },
  "api/fieldroutes/manual-sync/route.ts": { why: "verifies the ID token and uses the caller's own profile company", proof: "verifyIdToken" },
  "api/admin/routing-status/route.ts": { why: "?summary=1 is public and harmless; the full probe requires CRON_SECRET", proof: "CRON_SECRET" },
};

/** Routes that must never be reachable by a signed-in dashboard user. */
const OPERATOR_ONLY = [
  "api/admin/cleanup-csv-jobs", "api/admin/delete-company", "api/admin/diagnose-user",
  "api/fieldroutes/debug-appointments", "api/fieldroutes/debug-classification", "api/fieldroutes/debug-customer",
  "api/fieldroutes/debug-line-target", "api/fieldroutes/debug-skills", "api/fieldroutes/debug-sync-state",
  "api/fieldroutes/reset-jobs", "api/reset-routing",
  "api/fieldroutes/sync", "api/fieldroutes/recompute-past-due",
];

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

const files = routeFiles(ROOT).map((p) => ({ rel: relative(ROOT, p).split("\\").join("/"), src: readFileSync(p, "utf8") }));

describe("every API route is behind an auth guard", () => {
  it("finds the routes", () => {
    assert.ok(files.length > 30, `only found ${files.length} route files`);
  });

  for (const f of files) {
    it(f.rel, () => {
      const exempt = OWN_AUTH[f.rel];
      if (exempt) {
        assert.ok(f.src.includes(exempt.proof), `${f.rel} is exempt (${exempt.why}) but no longer contains "${exempt.proof}"`);
        return;
      }
      const exported = METHODS.filter((m) => new RegExp(`export\\s+(async\\s+function|const|function)\\s+${m}\\b`).test(f.src));
      assert.ok(exported.length > 0, `${f.rel} exports no HTTP method`);
      for (const m of exported) {
        assert.match(f.src, new RegExp(`export const ${m}\\s*=\\s*guarded\\(`), `${f.rel}: ${m} must be exported as guarded(...) — see src/lib/api-guard.ts`);
      }
    });
  }

  it("the exemption list has no stale entries", () => {
    for (const rel of Object.keys(OWN_AUTH)) assert.ok(files.some((f) => f.rel === rel), `${rel} is listed as exempt but does not exist`);
  });

  it("maintenance, debug and destructive routes accept the operator secret only", () => {
    for (const r of OPERATOR_ONLY) {
      const f = files.find((x) => x.rel === `${r}/route.ts`);
      assert.ok(f, `${r} not found`);
      for (const m of METHODS) {
        if (new RegExp(`export const ${m}\\s*=`).test(f!.src)) {
          assert.match(f!.src, new RegExp(`export const ${m}\\s*=\\s*guarded\\("operator"`), `${r} ${m} must be operator-only`);
        }
      }
    }
  });
});
