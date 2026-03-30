import { initializeApp, getApps, cert, App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAuth } from 'firebase-admin/auth';

let adminApp: App;

function parseServiceAccount(raw: string) {
  // Try plain JSON first, then base64url, then standard base64
  try { return JSON.parse(raw); } catch { /* not plain JSON */ }
  try { return JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')); } catch { /* not base64url */ }
  try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf-8')); } catch { /* not base64 */ }
  return null;
}

function getAdminApp(): App {
  if (getApps().length === 0) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT;
    const serviceAccount = raw && raw !== '{}' && raw !== 'undefined' ? parseServiceAccount(raw) : null;

    if (!serviceAccount) {
      adminApp = initializeApp({
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'routeiq-dev',
      });
    } else {
      adminApp = initializeApp({
        credential: cert(serviceAccount),
        storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
      });
    }
  } else {
    adminApp = getApps()[0];
  }
  return adminApp;
}

export const adminDb = () => getFirestore(getAdminApp());
export const adminStorage = () => getStorage(getAdminApp());
export const adminAuth = () => getAuth(getAdminApp());
