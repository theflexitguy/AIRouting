// Routiq MCP server — a read-only Model Context Protocol endpoint over the dashboard's data.
//
//   POST /api/mcp     Authorization: Bearer <MCP_API_KEY>
//
// See docs/MCP.md for setup, client configuration and the tool catalog.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { adminDb } from "@/lib/firebase-admin";
import { centralTodayISO } from "@/lib/fieldroutes/scope";
import { readMcpConfig } from "@/lib/mcp/config";
import { handleMcpRequest } from "@/lib/mcp/handler";
import { FirestoreDataSource } from "@/lib/mcp/firestore-source";
import { getOAuth } from "@/lib/mcp/oauth/runtime";

// Company ids already confirmed to exist, for the life of this server instance.
const verified = new Set<string>();
// The single company found by auto-detection, so it is not re-queried on every request.
let autoDetected: string | null = null;

async function resolveCompanyId(configured: string | null): Promise<string | { error: string }> {
  const db = adminDb();
  if (configured) {
    if (!verified.has(configured)) {
      const snap = await db.doc(`companies/${configured}`).get();
      if (!snap.exists) return { error: `The configured company "${configured}" does not exist. Check MCP_COMPANY_ID.` };
      verified.add(configured);
    }
    return configured;
  }
  // Nothing configured: only safe when there is exactly one company.
  if (autoDetected) return autoDetected;
  const companies = await db.collection("companies").limit(2).get();
  if (companies.size === 1) return (autoDetected = companies.docs[0].id);
  return { error: "MCP_COMPANY_ID is not set and the company cannot be determined unambiguously." };
}

async function handle(request: Request): Promise<Response> {
  const config = readMcpConfig();
  const oauth = getOAuth();
  return handleMcpRequest(request, {
    config,
    oauth: oauth ? { verifyAccessToken: oauth.verifyAccessToken, resourceMetadataUrl: oauth.resourceMetadataUrl } : null,
    resolveContext: async () => {
      const companyId = await resolveCompanyId(config.companyId);
      if (typeof companyId !== "string") return companyId;
      return {
        data: new FirestoreDataSource(companyId, config.cacheTtlMs, adminDb()),
        today: centralTodayISO(),
        now: () => new Date(),
      };
    },
  });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const OPTIONS = handle;
