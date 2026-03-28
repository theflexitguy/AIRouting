import { initializeApp, getApps, cert, App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAuth } from 'firebase-admin/auth';

let adminApp: App;

function getAdminApp(): App {
  if (getApps().length === 0) {
    const serviceAccount = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT;
    if (!serviceAccount || serviceAccount === '{}' || serviceAccount === 'undefined') {
      // For development without real credentials, use application default
      adminApp = initializeApp({
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'routeiq-dev',
      });
    } else {
      adminApp = initializeApp({
        credential: cert(JSON.parse(serviceAccount)),
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
