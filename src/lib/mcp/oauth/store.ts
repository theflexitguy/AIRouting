// Persistence for the two things that MUST be stateful: single-use authorization codes and
// rotating refresh tokens. Only SHA-256 hashes of the secrets are stored, so a database read
// yields nothing usable. (Client registrations, pending logins and access tokens are stateless.)
//
// Both operations that consume a secret are atomic take-and-delete, which is what makes a code
// single-use even if it is presented twice at the same instant.

export interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  email: string;
  scope: string;
  resource: string;
  expiresAtMs: number;
}

export interface RefreshRecord {
  clientId: string;
  email: string;
  scope: string;
  resource: string;
  /** When the ORIGINAL login happened; a family is capped at this + refreshMaxAgeSec. */
  familyStartMs: number;
  expiresAtMs: number;
}

export interface OAuthStore {
  putCode(hash: string, rec: CodeRecord): Promise<void>;
  /** Atomically returns and deletes. null if absent (never issued, expired-and-purged, or already used). */
  takeCode(hash: string): Promise<CodeRecord | null>;
  putRefresh(hash: string, rec: RefreshRecord): Promise<void>;
  /** Atomically returns and deletes (rotation: the caller then puts the replacement). */
  takeRefresh(hash: string): Promise<RefreshRecord | null>;
  deleteRefresh(hash: string): Promise<void>;
}
