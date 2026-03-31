import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import twilio from 'twilio';
import { prisma } from '../config/database';
import { getRedisClient, rk } from '../config/redis';
import { creditCoins } from '../services/coinService';
import { processReferral } from '../services/referralService';
import { generateReferralCode } from '../utils/crypto';
import { success, error } from '../utils/response';
import { env } from '../config/env';
import { TransactionType } from '@prisma/client';
import { logger } from '../utils/logger';

const twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

function generateJwt(userId: string): string {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

// ─── Test phone helpers (DB-driven) ──────────────────────────────────────────
const FALLBACK_TEST_PHONES: string[] = [];

async function getTestPhoneOtp(phone: string): Promise<string | null> {
  const cleanPhone = phone.replace(/\D/g, '');
  try {
    const testMode = await prisma.appSettings.findUnique({ where: { key: 'TEST_MODE_ENABLED' } });
    if (testMode?.value !== 'true') {
      // Fallback to hardcoded list in dev
      if (process.env.NODE_ENV !== 'production') {
        const isHardcoded = FALLBACK_TEST_PHONES.some(p => cleanPhone.includes(p));
        return isHardcoded ? '123456' : null;
      }
      return null;
    }
    for (let i = 1; i <= 3; i++) {
      const [tp, to] = await Promise.all([
        prisma.appSettings.findUnique({ where: { key: `TEST_PHONE_${i}` } }),
        prisma.appSettings.findUnique({ where: { key: `TEST_OTP_${i}` } }),
      ]);
      const testPhoneClean = (tp?.value ?? '').replace(/\D/g, '');
      if (testPhoneClean && cleanPhone.endsWith(testPhoneClean)) {
        return to?.value || null;
      }
    }
  } catch {
    // DB unavailable — fall back to hardcoded
    if (process.env.NODE_ENV !== 'production') {
      const isHardcoded = FALLBACK_TEST_PHONES.some(p => cleanPhone.includes(p));
      return isHardcoded ? '123456' : null;
    }
  }
  return null;
}

function isTestPhone(phone: string): boolean {
  return FALLBACK_TEST_PHONES.some(p => phone.replace(/\D/g, '').includes(p));
}

// ─── Send OTP ────────────────────────────────────────────────────────────────
export async function sendOtp(req: Request, res: Response): Promise<void> {
  const { phone } = req.body as { phone: string };

  try {
    // Check if test phone first (DB lookup, no Redis needed)
    const testOtp = await getTestPhoneOtp(phone).catch(() => null);
    const isTest = !!testOtp || isTestPhone(phone);

    // For test phones: respond immediately — no Redis required
    if (isTest) {
      const otp = testOtp ?? '123456';
      logger.info(`[OTP-TEST] ${phone} → ${otp}`);
      // Try to cache in Redis but don't fail if Redis is down
      try {
        const redis = getRedisClient();
        await redis.setex(rk(`otp:${phone}`), 300, otp);
      } catch {
        logger.warn(`[OTP-TEST] Redis unavailable — test OTP will verify via DB`);
      }
      success(res, { otp }, 'OTP sent successfully');
      return;
    }

    // Real phone — rate limit via Redis, send OTP via Twilio Verify
    const redis = getRedisClient();
    const attempts = await redis.incr(rk(`otp_attempts:${phone}`));
    if (attempts === 1) await redis.expire(rk(`otp_attempts:${phone}`), 600);
    if (attempts > 5) {
      error(res, 'Too many OTP requests. Please try again in 10 minutes.', 429);
      return;
    }

    await twilioClient.verify.v2
      .services(env.TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({ to: phone, channel: 'sms' });

    logger.info(`[OTP] Twilio Verify sent to ${phone}`);
    success(res, null, 'OTP sent successfully');
  } catch (err) {
    logger.error('Send OTP failed', { err });
    error(res, 'Failed to send OTP. Please try again.', 500);
  }
}

// ─── Verify Phone OTP ────────────────────────────────────────────────────────
export async function verifyPhone(req: Request, res: Response): Promise<void> {
  const { phone, otp, referralCode, fcmToken, deviceId, appVersion } = req.body as {
    phone: string;
    otp: string;
    referralCode?: string;
    fcmToken?: string;
    deviceId?: string;
    appVersion?: string;
  };

  try {
    // For test phones: verify against DB test OTP (Redis optional)
    const testOtp = await getTestPhoneOtp(phone).catch(() => null);
    const isTest = !!testOtp || isTestPhone(phone);

    if (isTest) {
      const expectedOtp = testOtp ?? '123456';
      if (otp !== expectedOtp) {
        error(res, 'Invalid OTP. Please try again.', 400);
        return;
      }
    } else {
      // Real phone — verify via Twilio Verify
      const check = await twilioClient.verify.v2
        .services(env.TWILIO_VERIFY_SERVICE_SID)
        .verificationChecks.create({ to: phone, code: otp });

      if (check.status !== 'approved') {
        error(res, 'Invalid or expired OTP. Please try again.', 400);
        return;
      }

      // Clear rate limit on success
      try {
        const redis = getRedisClient();
        await redis.del(rk(`otp_attempts:${phone}`));
      } catch { /* Redis optional here */ }
    }

    const existing = await prisma.user.findUnique({ where: { phone } });
    const isNew = !existing;

    const user = await prisma.user.upsert({
      where: { phone },
      create: {
        phone,
        referralCode: generateReferralCode(),
        fcmToken:    fcmToken  ?? null,
        deviceId:    deviceId  ?? null,
        appVersion:  appVersion ?? null,
        deviceType:  'mobile',
        isPhoneVerified: true,
        lastLoginAt:  new Date(),
        lastActiveAt: new Date(),
      },
      update: {
        fcmToken:     fcmToken    ?? undefined,
        deviceId:     deviceId    ?? undefined,
        appVersion:   appVersion  ?? undefined,
        deviceType:   'mobile',
        isPhoneVerified: true,
        lastLoginAt:  new Date(),
        lastActiveAt: new Date(),
      },
    });

    if (isNew) {
      await creditCoins(user.id, 100, TransactionType.EARN_BONUS, undefined, 'Welcome bonus');
      if (referralCode) await processReferral(user.id, referralCode);
    }

    const token = generateJwt(user.id);
    success(
      res,
      { user, token, isNew, isProfileComplete: user.isProfileComplete },
      isNew ? 'Account created! Welcome to OfferPlay 🎉' : 'Welcome back!',
      isNew ? 201 : 200
    );
  } catch (err) {
    logger.error('Phone verify failed', { err });
    error(res, 'Verification failed. Please try again.', 500);
  }
}

// ─── Firebase Phone Auth Verify ──────────────────────────────────────────────
export async function phoneFirebaseVerify(req: Request, res: Response): Promise<void> {
  const { idToken, fcmToken, deviceId, referralCode, appVersion } = req.body as {
    idToken: string;
    fcmToken?: string;
    deviceId?: string;
    referralCode?: string;
    appVersion?: string;
  };

  try {
    const { verifyFirebaseToken } = await import('../config/firebase');
    const decoded = await verifyFirebaseToken(idToken);

    const phone = decoded.phone_number;
    if (!phone) {
      error(res, 'Invalid Firebase token: no phone number', 400);
      return;
    }

    const existing = await prisma.user.findUnique({ where: { phone } });
    const isNew = !existing;

    const user = await prisma.user.upsert({
      where: { phone },
      create: {
        phone,
        referralCode: generateReferralCode(),
        fcmToken:    fcmToken  ?? null,
        deviceId:    deviceId  ?? null,
        appVersion:  appVersion ?? null,
        deviceType:  'mobile',
        isPhoneVerified: true,
        lastLoginAt:  new Date(),
        lastActiveAt: new Date(),
      },
      update: {
        fcmToken:     fcmToken    ?? undefined,
        deviceId:     deviceId    ?? undefined,
        appVersion:   appVersion  ?? undefined,
        deviceType:   'mobile',
        isPhoneVerified: true,
        lastLoginAt:  new Date(),
        lastActiveAt: new Date(),
      },
    });

    if (isNew) {
      await creditCoins(user.id, 100, TransactionType.EARN_BONUS, undefined, 'Welcome bonus');
      if (referralCode) await processReferral(user.id, referralCode);
    }

    const token = generateJwt(user.id);
    success(
      res,
      { user, token, isNew, isProfileComplete: user.isProfileComplete },
      isNew ? 'Account created! Welcome to OfferPlay 🎉' : 'Welcome back!',
      isNew ? 201 : 200
    );
  } catch (err) {
    logger.error('Firebase phone verify failed', { err });
    error(res, 'Phone verification failed. Please try again.', 401);
  }
}

// ─── Complete Profile ────────────────────────────────────────────────────────
export async function completeProfile(req: Request, res: Response): Promise<void> {
  const userId = req.userId;
  if (!userId) { error(res, 'Unauthorized', 401); return; }

  const { name, email, dateOfBirth, city, state, country, favouriteTeam, referralCode } = req.body as {
    name: string;
    email?: string;
    dateOfBirth?: string;
    city?: string;
    state?: string;
    country?: string;
    favouriteTeam?: string;
    referralCode?: string;
  };

  try {
    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) { error(res, 'User not found', 404); return; }

    // Check referral code if provided and not already referred
    if (referralCode && !existing.referredBy) {
      await processReferral(userId, referralCode).catch(() => {});
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        name: name.trim(),
        email:        email?.trim()       || undefined,
        dateOfBirth:  dateOfBirth ? new Date(dateOfBirth) : undefined,
        city:         city?.trim()        || undefined,
        state:        state?.trim()       || undefined,
        country:      country             || undefined,
        favouriteTeam: favouriteTeam      || undefined,
        isProfileComplete: true,
        isEmailVerified:   email ? false  : undefined, // Reset until verified
      },
    });

    success(res, { user }, 'Profile updated successfully');
  } catch (err: any) {
    logger.error('Complete profile failed', {
      userId,
      errCode: err?.code,
      errMsg: err?.message,
      errMeta: err?.meta,
    });
    if (err.code === 'P2002') {
      error(res, 'This email is already in use.', 409);
    } else {
      error(res, 'Failed to update profile. Please try again.', 500);
    }
  }
}

// ─── Update FCM Token ────────────────────────────────────────────────────────
export async function updateFCMToken(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { fcmToken } = req.body as { fcmToken: string };

  try {
    await prisma.user.update({ where: { id: userId }, data: { fcmToken } });
    success(res, null, 'FCM token updated');
  } catch (err) {
    logger.error('FCM token update failed', { err });
    error(res, 'Failed to update FCM token', 500);
  }
}

// ─── Google Auth ─────────────────────────────────────────────────────────────
export async function googleAuth(req: Request, res: Response): Promise<void> {
  const { idToken, fcmToken, deviceId, referralCode } = req.body as {
    idToken: string;
    fcmToken?: string;
    deviceId?: string;
    referralCode?: string;
  };

  try {
    const { verifyFirebaseToken } = await import('../config/firebase');
    const decoded = await verifyFirebaseToken(idToken);

    const googleId = decoded.uid;
    const email    = decoded.email || null;
    const name     = decoded.name  || null;

    // Find by googleId OR email (account linking)
    const existing = await prisma.user.findFirst({
      where: { OR: [{ googleId }, ...(email ? [{ email }] : [])] },
    });
    const isNew = !existing;

    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            googleId:    existing.googleId ?? googleId,
            email:       email    ?? undefined,
            name:        existing.name || name || undefined,
            isEmailVerified: email ? true : undefined,
            fcmToken:    fcmToken  ?? undefined,
            deviceId:    deviceId  ?? undefined,
            lastLoginAt:  new Date(),
            lastActiveAt: new Date(),
          },
        })
      : await prisma.user.create({
          data: {
            googleId,
            email,
            name,
            referralCode:      generateReferralCode(),
            isEmailVerified:   !!email,
            isProfileComplete: !!(name && email),
            fcmToken:   fcmToken  ?? null,
            deviceId:   deviceId  ?? null,
            lastLoginAt:  new Date(),
            lastActiveAt: new Date(),
          },
        });

    if (isNew) {
      await creditCoins(user.id, 100, TransactionType.EARN_BONUS, undefined, 'Welcome bonus');
      if (referralCode) await processReferral(user.id, referralCode).catch(() => {});
    }

    const token = generateJwt(user.id);
    success(
      res,
      { user, token, isNew, isProfileComplete: user.isProfileComplete },
      isNew ? 'Account created! Welcome to OfferPlay 🎉' : 'Welcome back!',
      isNew ? 201 : 200
    );
  } catch (err) {
    logger.error('Google auth failed', { err });
    error(res, 'Google authentication failed. Please try again.', 401);
  }
}

// ─── Google Login (native sign-in, 50-coin bonus) ────────────────────────────
export async function googleLogin(req: Request, res: Response): Promise<void> {
  const { idToken, fcmToken, deviceId, referralCode } = req.body as {
    idToken: string;
    fcmToken?: string;
    deviceId?: string;
    referralCode?: string;
  };

  try {
    const { verifyFirebaseToken } = await import('../config/firebase');
    const decoded = await verifyFirebaseToken(idToken);

    const googleId = decoded.uid;
    const email    = decoded.email || null;
    const name     = decoded.name  || null;

    // Find by googleId OR email (account linking)
    const existing = await prisma.user.findFirst({
      where: { OR: [{ googleId }, ...(email ? [{ email }] : [])] },
    });
    const isNew = !existing;

    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            googleId:        existing.googleId ?? googleId,
            email:           email    ?? undefined,
            name:            existing.name || name || undefined,
            isEmailVerified: email ? true : undefined,
            fcmToken:        fcmToken ?? undefined,
            deviceId:        deviceId ?? undefined,
            lastLoginAt:     new Date(),
            lastActiveAt:    new Date(),
          },
        })
      : await prisma.user.create({
          data: {
            googleId,
            email,
            name,
            referralCode:      generateReferralCode(),
            isEmailVerified:   !!email,
            isProfileComplete: !!(name && email),
            fcmToken:          fcmToken ?? null,
            deviceId:          deviceId ?? null,
            lastLoginAt:       new Date(),
            lastActiveAt:      new Date(),
          },
        });

    if (isNew) {
      await creditCoins(user.id, 50, TransactionType.EARN_BONUS, undefined, 'Google signup bonus');
      if (referralCode) await processReferral(user.id, referralCode).catch(() => {});
    }

    const token = generateJwt(user.id);
    success(
      res,
      { user, token, isNew, isProfileComplete: user.isProfileComplete },
      isNew ? 'Account created! Welcome to OfferPlay 🎉' : 'Welcome back!',
      isNew ? 201 : 200
    );
  } catch (err) {
    logger.error('Google login failed', { err });
    error(res, 'Google authentication failed. Please try again.', 401);
  }
}

// ─── Logout ──────────────────────────────────────────────────────────────────
export async function logout(req: Request, res: Response): Promise<void> {
  const token = req.headers.authorization?.substring(7);
  if (token) {
    const redis = getRedisClient();
    await redis.setex(rk(`blacklist:${token}`), 30 * 24 * 60 * 60, '1');
  }
  success(res, null, 'Logged out successfully');
}

// ─── Get Me ──────────────────────────────────────────────────────────────────
export async function getMe(req: Request, res: Response): Promise<void> {
  success(res, req.user);
}

// ─── Update Profile ──────────────────────────────────────────────────────────
export async function updateProfile(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { name, email, city, state, favouriteTeam } = req.body as {
    name?: string;
    email?: string | null;
    city?: string | null;
    state?: string | null;
    favouriteTeam?: string | null;
  };

  if (!name || name.trim().length < 2) {
    error(res, 'Valid name required', 400);
    return;
  }

  try {
    if (email) {
      const emailExists = await prisma.user.findFirst({
        where: { email: email.toLowerCase().trim(), id: { not: userId } },
      });
      if (emailExists) {
        error(res, 'Email already in use by another account', 409);
        return;
      }
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        name:          name.trim(),
        email:         email ? email.toLowerCase().trim() : null,
        city:          city?.trim()  || null,
        state:         state?.trim() || null,
        favouriteTeam: favouriteTeam || null,
      },
    });

    success(res, {
      user: {
        id: user.id, name: user.name, email: user.email,
        city: user.city, state: user.state, favouriteTeam: user.favouriteTeam,
      },
    }, 'Profile updated!');
  } catch (err) {
    logger.error('updateProfile:', err);
    error(res, 'Failed to update profile', 500);
  }
}

// ─── Dev-only login (generates real JWT for test phone) ──────────────────────
export async function devLogin(req: Request, res: Response): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    error(res, 'Not available in production', 403);
    return;
  }
  const phone = (req.body.phone as string) || '+910000000000';
  try {
    const user = await prisma.user.upsert({
      where: { phone },
      create: { phone, referralCode: generateReferralCode(), name: 'Dev User', isPhoneVerified: true },
      update: {},
    });
    const token = generateJwt(user.id);
    success(res, { user, token, isNew: false, isProfileComplete: user.isProfileComplete }, 'Dev login successful');
  } catch (err) {
    logger.error('Dev login failed', { err });
    error(res, 'Dev login failed', 500);
  }
}
