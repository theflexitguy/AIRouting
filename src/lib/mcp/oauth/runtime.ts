// Wires the OAuth flow to the real world (Firestore, Google). Imported only by Next.js routes —
// it pulls in firebase-admin, so it is deliberately kept out of the unit-tested modules.

import { adminDb } from "@/lib/firebase-admin";
import { readOAuthConfig } from "./config.ts";
import { FirestoreOAuthStore } from "./firestore-store.ts";
import { createOAuthFlow, type OAuthFlow } from "./flow.ts";
import { createGoogleClient } from "./google.ts";

let flow: OAuthFlow | null | undefined;

/** The OAuth flow, or null when sign-in is not (fully) configured. Built once per server instance. */
export function getOAuth(): OAuthFlow | null {
  if (flow !== undefined) return flow;
  const { config, missing, attempted } = readOAuthConfig();
  if (!config) {
    if (attempted) console.warn(`[mcp-oauth] Google sign-in is only partly configured and is DISABLED. Missing: ${missing.join(", ")}`);
    return (flow = null);
  }
  return (flow = createOAuthFlow({ config, store: new FirestoreOAuthStore(adminDb()), google: createGoogleClient(config) }));
}
