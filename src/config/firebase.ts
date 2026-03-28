import admin from 'firebase-admin';
import { env } from './env';
import { logger } from '../utils/logger';

let firebaseApp: admin.app.App | null = null;

export function initFirebase(): admin.app.App {
  if (firebaseApp) return firebaseApp;

  if (!env.FIREBASE_PROJECT_ID || env.FIREBASE_PROJECT_ID === 'your-firebase-project-id') {
    logger.warn('Firebase not configured — phone/Google auth will be unavailable');
    return {} as admin.app.App;
  }

  const privateKey = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: env.FIREBASE_PROJECT_ID,
      privateKey,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
    }),
  });

  logger.info('Firebase Admin initialized');
  return firebaseApp;
}

export async function verifyFirebaseToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
  if (!firebaseApp) {
    throw new Error('Firebase not initialized');
  }
  return admin.auth().verifyIdToken(idToken);
}

export { admin };
