import { initializeApp, getApps, cert, App, ServiceAccount } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAuth } from 'firebase-admin/auth';

let adminApp: App;
let firestoreInstance: Firestore | undefined;

type ServiceAccountJson = ServiceAccount & {
  project_id?: string;
  client_email?: string;
  private_key?: string;
};

function parseServiceAccount(raw: string) {
  const trimmed = raw.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^['"]|['"]$/g, ''),
  ];

  for (const candidate of candidates) {
    try {
      return normalizeServiceAccount(JSON.parse(candidate));
    } catch {
      // not plain JSON
    }
  }

  for (const encoding of ['base64url', 'base64'] as const) {
    try {
      const decoded = Buffer.from(trimmed, encoding).toString('utf-8');
      return normalizeServiceAccount(JSON.parse(decoded));
    } catch {
      // not this base64 variant
    }
  }

  return null;
}

function normalizeServiceAccount(value: ServiceAccountJson | null) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.private_key === 'string') {
    value.private_key = value.private_key.replace(/\\n/g, '\n');
  }
  return value;
}

function serviceAccountFromEnv() {
  const raw =
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (!raw || raw === '{}' || raw === 'undefined') return null;
  return parseServiceAccount(raw);
}

function getAdminApp(): App {
  if (getApps().length === 0) {
    const serviceAccount = serviceAccountFromEnv();

    if (!serviceAccount) {
      throw new Error(
        'Firebase Admin credentials are not configured. Set FIREBASE_SERVICE_ACCOUNT to the Firebase service account JSON, base64, or base64url value in the server runtime environment.',
      );
    }

    adminApp = initializeApp({
      credential: cert(serviceAccount),
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    });
  } else {
    adminApp = getApps()[0];
  }
  return adminApp;
}

export const adminDb = () => {
  if (!firestoreInstance) {
    firestoreInstance = getFirestore(getAdminApp());
    // Silently drop undefined fields on writes instead of throwing. A single
    // undefined value (e.g. a missing field on a rehydrated sync-run object)
    // would otherwise abort an entire batch mid-sync.
    firestoreInstance.settings({ ignoreUndefinedProperties: true });
  }
  return firestoreInstance;
};
export const adminStorage = () => getStorage(getAdminApp());
export const adminAuth = () => getAuth(getAdminApp());

/**
 * Service-account credentials parsed from the environment, or null when none is
 * configured. Exposed so other Google API clients that need OAuth (Route
 * Optimization, which does NOT accept a Maps API key) can mint tokens from the
 * same credential instead of introducing a second secret.
 */
export function serviceAccountCredentials(): { project_id?: string; client_email?: string; private_key?: string } | null {
  return serviceAccountFromEnv() as { project_id?: string; client_email?: string; private_key?: string } | null;
}
