import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/database';
import { verifyFirebaseToken } from '../config/firebase';
import { getRedisClient } from '../config/redis';
import { creditCoins } from '../services/coinService';
import { processReferral } from '../services/referralService';
import { generateReferralCode } from '../utils/crypto';
import { success, error } from '../utils/response';
import { env } from '../config/env';
import { TransactionType } from '@prisma/client';
import { logger } from '../utils/logger';

function generateJwt(userId: string): string {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

export async function sendOtp(req: Request, res: Response): Promise<void> {
  // Firebase phone auth handles OTP sending client-side.
  // This endpoint is a no-op server-side — kept for API completeness.
  success(res, null, 'OTP sent via Firebase. Verify on client.');
}

export async function verifyPhone(req: Request, res: Response): Promise<void> {
  const { idToken, referralCode, fcmToken, deviceId } = req.body as {
    idToken: string;
    referralCode?: string;
    fcmToken?: string;
    deviceId?: string;
  };

  try {
    const decoded = await verifyFirebaseToken(idToken);
    const phone = decoded.phone_number;
    if (!phone) {
      error(res, 'Phone number not found in token', 400);
      return;
    }

    const isNew = !(await prisma.user.findUnique({ where: { phone } }));

    const user = await prisma.user.upsert({
      where: { phone },
      create: {
        phone,
        referralCode: generateReferralCode(),
        fcmToken: fcmToken ?? null,
        deviceId: deviceId ?? null,
      },
      update: {
        fcmToken: fcmToken ?? undefined,
        deviceId: deviceId ?? undefined,
      },
    });

    if (isNew) {
      await creditCoins(user.id, 100, TransactionType.EARN_BONUS, undefined, 'Welcome bonus');
      if (referralCode) await processReferral(user.id, referralCode);
    }

    const token = generateJwt(user.id);
    success(res, { user, token, isNew }, isNew ? 'Account created' : 'Login successful', isNew ? 201 : 200);
  } catch (err) {
    logger.error('Phone verify failed', { err });
    error(res, 'Firebase token verification failed', 401);
  }
}

export async function googleAuth(req: Request, res: Response): Promise<void> {
  const { idToken, fcmToken, deviceId } = req.body as {
    idToken: string;
    fcmToken?: string;
    deviceId?: string;
  };

  try {
    const decoded = await verifyFirebaseToken(idToken);
    const googleId = decoded.uid;
    const email = decoded.email ?? null;
    const name = decoded.name ?? null;

    const isNew = !(await prisma.user.findUnique({ where: { googleId } }));

    const user = await prisma.user.upsert({
      where: { googleId },
      create: {
        googleId,
        email,
        name,
        referralCode: generateReferralCode(),
        fcmToken: fcmToken ?? null,
        deviceId: deviceId ?? null,
      },
      update: {
        email: email ?? undefined,
        name: name ?? undefined,
        fcmToken: fcmToken ?? undefined,
        deviceId: deviceId ?? undefined,
      },
    });

    if (isNew) {
      await creditCoins(user.id, 100, TransactionType.EARN_BONUS, undefined, 'Welcome bonus');
    }

    const token = generateJwt(user.id);
    success(res, { user, token, isNew }, isNew ? 'Account created' : 'Login successful', isNew ? 201 : 200);
  } catch (err) {
    logger.error('Google auth failed', { err });
    error(res, 'Firebase token verification failed', 401);
  }
}

export async function logout(req: Request, res: Response): Promise<void> {
  const token = req.headers.authorization?.substring(7);
  if (token) {
    const redis = getRedisClient();
    // Blacklist for 30 days
    await redis.setex(`blacklist:${token}`, 30 * 24 * 60 * 60, '1');
  }
  success(res, null, 'Logged out successfully');
}

export async function getMe(req: Request, res: Response): Promise<void> {
  success(res, req.user);
}

// ─── Dev-only: generate real JWT for test phone (development only) ────────────
export async function devLogin(req: Request, res: Response): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    error(res, 'Not available in production', 403);
    return;
  }
  const phone = (req.body.phone as string) || '+910000000000';
  try {
    const user = await prisma.user.upsert({
      where: { phone },
      create: { phone, referralCode: generateReferralCode(), name: 'Dev User' },
      update: {},
    });
    const token = generateJwt(user.id);
    success(res, { user, token, isNew: false }, 'Dev login successful');
  } catch (err) {
    logger.error('Dev login failed', { err });
    error(res, 'Dev login failed', 500);
  }
}
