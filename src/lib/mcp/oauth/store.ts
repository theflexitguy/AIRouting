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
  /** Shared by every token descended from one login, so reuse of any spent token can revoke them all. */
  familyId: string;
  /** When the ORIGINAL login happened; a family is capped at this + refreshMaxAgeSec. */
  familyStartMs: number;
  expiresAtMs: number;
}

export interface OAuthStore {
  putCode(hash: string, rec: CodeRecord): Promise<void>;
  /** Atomically returns and deletes. null if absent (never issued, expired-and-purged, or already used). */
  takeCode(hash: string): Promise<CodeRecord | null>;
  /** Stores a token. Returns false (and stores nothing) if its family has been revoked — checked atomically with the write. */
  putRefresh(hash: string, rec: RefreshRecord): Promise<boolean>;
  /**
   * Atomically marks the token spent and returns it (rotation: the caller then puts the replacement).
   * A spent token is KEPT (until its expiry) as a tombstone, so presenting it again comes back with
   * `consumed: true` instead of looking like a token that never existed — that is how reuse is detected.
   */
  takeRefresh(hash: string): Promise<{ rec: RefreshRecord; consumed: boolean } | null>;
  /**
   * Revokes a whole family: records the revocation FIRST (so a rotation still in flight can't add a successor
   * afterwards — putRefresh refuses) and then deletes every token in it. The marker is kept until `untilMs`.
   */
  revokeFamily(familyId: string, untilMs: number): Promise<void>;
}
