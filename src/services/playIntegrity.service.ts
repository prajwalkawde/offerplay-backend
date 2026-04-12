import axios from 'axios';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity';

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

async function getGoogleAccessToken(): Promise<string> {
  // Return cached token if still valid (with 60 s buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    throw new Error('Firebase service account credentials not configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const serviceAccountJwt = jwt.sign(
    {
      iss: clientEmail,
      scope: PLAY_INTEGRITY_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    },
    privateKey,
    { algorithm: 'RS256' },
  );

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: serviceAccountJwt,
  });

  const response = await axios.post<{ access_token: string; expires_in: number }>(
    GOOGLE_TOKEN_URL,
    params.toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 5000 },
  );

  const { access_token, expires_in } = response.data;
  cachedToken = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
  return access_token;
}

export interface IntegrityVerifyResult {
  passed: boolean;
  verdict: string;
  deviceIntegrity: string;
}

export async function verifyIntegrityToken(
  token: string,
  uid: string,
): Promise<IntegrityVerifyResult> {
  try {
    const projectNumber = process.env.GOOGLE_CLOUD_PROJECT_NUMBER;
    if (!projectNumber) {
      logger.warn('[PlayIntegrity] GOOGLE_CLOUD_PROJECT_NUMBER not set — skipping verification');
      return { passed: true, verdict: 'NOT_CONFIGURED', deviceIntegrity: '' };
    }

    const accessToken = await getGoogleAccessToken();

    const response = await axios.post<{ tokenPayloadExternal: unknown }>(
      `https://playintegrity.googleapis.com/v1/${projectNumber}:decodeIntegrityToken`,
      { integrity_token: token },
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 5000,
      },
    );

    const payload = response.data.tokenPayloadExternal as {
      deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
    };
    const deviceVerdict = payload.deviceIntegrity?.deviceRecognitionVerdict ?? [];

    const meetsBasicIntegrity = deviceVerdict.includes('MEETS_BASIC_INTEGRITY');

    logger.info('[PlayIntegrity] uid:', uid, 'verdict:', deviceVerdict);

    return {
      passed: meetsBasicIntegrity,
      verdict: deviceVerdict[0] ?? 'UNKNOWN',
      deviceIntegrity: JSON.stringify(deviceVerdict),
    };
  } catch (error) {
    // FAIL OPEN — don't block users if Google API is down
    logger.error('[PlayIntegrity] verification error:', error);
    return { passed: true, verdict: 'VERIFICATION_ERROR', deviceIntegrity: '' };
  }
}
