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
import { updateQuestProgress } from './questController';

const twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

function generateJwt(userId: string): string {
  return jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

// ─── Master bypass (admin testing) ───────────────────────────────────────────
const MASTER_BYPASS_PHONE = '8432171505';
const MASTER_BYPASS_OTP   = '652262';

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
    // Master bypass — always succeeds, no SMS sent
    if (phone.replace(/\D/g, '').endsWith(MASTER_BYPASS_PHONE)) {
      success(res, null, 'OTP sent successfully');
      return;
    }

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
    // Master bypass — fixed OTP, skips Twilio and test-phone DB lookup
    if (phone.replace(/\D/g, '').endsWith(MASTER_BYPASS_PHONE)) {
      if (otp !== MASTER_BYPASS_OTP) {
        error(res, 'Invalid OTP. Please try again.', 400);
        return;
      }
      // Fall through to user upsert below
    } else {
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
    } // end else (non-bypass)

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
    updateQuestProgress(user.id, 'DAILY_LOGIN', 1).catch(() => {});
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
    updateQuestProgress(user.id, 'DAILY_LOGIN', 1).catch(() => {});
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
            isProfileComplete: false,
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
    updateQuestProgress(user.id, 'DAILY_LOGIN', 1).catch(() => {});
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
            isProfileComplete: false,
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
    updateQuestProgress(user.id, 'DAILY_LOGIN', 1).catch(() => {});
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

// ─── PATCH /api/auth/language ─────────────────────────────────────────────────
export async function updateLanguage(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { language } = req.body as { language?: string };

  const SUPPORTED = ['en', 'hi', 'hinglish', 'ta', 'te', 'bn', 'mr'];
  if (!language || !SUPPORTED.includes(language)) {
    error(res, 'Invalid language code', 400);
    return;
  }

  await prisma.user.update({ where: { id: userId }, data: { language } });
  success(res, { language }, 'Language updated');
}

// ─── Web delete account — verify Firebase idToken + delete ────────────────────
export async function deleteAccountViaFirebase(req: Request, res: Response): Promise<void> {
  const { idToken } = req.body as { idToken?: string };
  if (!idToken) {
    error(res, 'Firebase ID token is required.', 400);
    return;
  }
  try {
    const { verifyFirebaseToken } = await import('../config/firebase');
    const decoded = await verifyFirebaseToken(idToken);

    // Find user by phone (phone auth) OR googleId/email (Google auth)
    const phone    = decoded.phone_number ?? null;
    const googleId = decoded.uid;
    const email    = decoded.email ?? null;

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          ...(phone    ? [{ phone }]    : []),
          ...(googleId ? [{ googleId }] : []),
          ...(email    ? [{ email }]    : []),
        ],
      },
    });

    if (!user || (user.phone ?? '').startsWith('DELETED_')) {
      error(res, 'No account found for this login.', 404);
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        status: 'BANNED',
        name: 'Deleted User',
        email: null,
        phone: `DELETED_${Date.now()}`,
        googleId: null,
        fcmToken: null,
        oneSignalPlayerId: null,
      },
    });

    logger.info(`[DeleteAccount] Web Firebase deletion for user ${user.id}`);
    success(res, null, 'Account deleted successfully');
  } catch (err) {
    logger.error('deleteAccountViaFirebase error', { err });
    error(res, 'Verification failed. Please try again.', 401);
  }
}

// ─── Web delete account — verify Google ID token directly (bypasses Firebase OAuth) ──
export async function deleteAccountViaGoogle(req: Request, res: Response): Promise<void> {
  const { googleIdToken } = req.body as { googleIdToken?: string };
  if (!googleIdToken) {
    error(res, 'Google ID token is required.', 400);
    return;
  }
  try {
    // Verify via Google's tokeninfo endpoint (no Firebase OAuth needed)
    const tokenRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(googleIdToken)}`);
    const tokenInfo = await tokenRes.json() as { sub?: string; email?: string; aud?: string };

    if (!tokenRes.ok || !tokenInfo.sub) {
      error(res, 'Invalid Google token. Please try again.', 401);
      return;
    }

    // Ensure token belongs to our app (any registered client ID)
    const VALID_AUDIENCES = [
      '449341693766-r6krhctj4lvoq6u8984on0d5l724acme.apps.googleusercontent.com',
      '449341693766-9ep4p1jrfh1sj0tlq3ublhkar70nl036.apps.googleusercontent.com',
      '449341693766-9igqqfqjdlfio99eqvl5e5s1h9tv6c94.apps.googleusercontent.com',
      '449341693766-hkerclk0anu608uujc01m9gocdk077pg.apps.googleusercontent.com',
      '449341693766-v25stanqh7soccmoqivrj0b1grpve6a5.apps.googleusercontent.com',
    ];
    if (!VALID_AUDIENCES.includes(tokenInfo.aud ?? '')) {
      error(res, 'Token not authorized for this app.', 401);
      return;
    }

    const googleId = tokenInfo.sub;
    const email    = tokenInfo.email ?? null;

    const user = await prisma.user.findFirst({
      where: { OR: [{ googleId }, ...(email ? [{ email }] : [])] },
    });

    if (!user || (user.phone ?? '').startsWith('DELETED_')) {
      error(res, 'No OfferPlay account found for this Google account.', 404);
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        status: 'BANNED',
        name: 'Deleted User',
        email: null,
        phone: `DELETED_${Date.now()}`,
        googleId: null,
        fcmToken: null,
        oneSignalPlayerId: null,
      },
    });

    logger.info(`[DeleteAccount] Google token deletion for user ${user.id}`);
    success(res, null, 'Account deleted successfully');
  } catch (err) {
    logger.error('deleteAccountViaGoogle error', { err });
    error(res, 'Verification failed. Please try again.', 500);
  }
}

// ─── Web delete account — Step 1: send OTP ────────────────────────────────────
export async function requestAccountDeletion(req: Request, res: Response): Promise<void> {
  const { phone } = req.body as { phone?: string };
  if (!phone || phone.trim().length < 10) {
    error(res, 'Please enter a valid phone number.', 400);
    return;
  }
  const normalised = phone.trim();
  try {
    const user = await prisma.user.findUnique({ where: { phone: normalised } });
    if (!user || (user.phone ?? '').startsWith('DELETED_')) {
      error(res, 'No account found with this phone number.', 404);
      return;
    }

    if (normalised.replace(/\D/g, '').endsWith(MASTER_BYPASS_PHONE)) {
      success(res, null, 'OTP sent successfully');
      return;
    }

    const testOtp = await getTestPhoneOtp(normalised).catch(() => null);
    if (testOtp || isTestPhone(normalised)) {
      success(res, null, 'OTP sent successfully');
      return;
    }

    const redis = getRedisClient();
    const attempts = await redis.incr(rk(`del_otp_attempts:${normalised}`));
    if (attempts === 1) await redis.expire(rk(`del_otp_attempts:${normalised}`), 600);
    if (attempts > 5) {
      error(res, 'Too many attempts. Try again in 10 minutes.', 429);
      return;
    }

    await twilioClient.verify.v2
      .services(env.TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({ to: normalised, channel: 'sms' });

    success(res, null, 'OTP sent successfully');
  } catch (err) {
    logger.error('requestAccountDeletion error', { err });
    error(res, 'Failed to send OTP. Please try again.', 500);
  }
}

// ─── Web delete account — Step 2: verify OTP + delete ────────────────────────
export async function confirmAccountDeletion(req: Request, res: Response): Promise<void> {
  const { phone, otp } = req.body as { phone?: string; otp?: string };
  if (!phone || !otp) {
    error(res, 'Phone and OTP are required.', 400);
    return;
  }
  const normalised = phone.trim();
  try {
    // Master bypass
    if (normalised.replace(/\D/g, '').endsWith(MASTER_BYPASS_PHONE)) {
      if (otp !== MASTER_BYPASS_OTP) {
        error(res, 'Invalid OTP. Please try again.', 400);
        return;
      }
    } else {
      const testOtp = await getTestPhoneOtp(normalised).catch(() => null);
      const isTest  = !!testOtp || isTestPhone(normalised);

      if (isTest) {
        const expected = testOtp ?? '123456';
        if (otp !== expected) {
          error(res, 'Invalid OTP. Please try again.', 400);
          return;
        }
      } else {
        const check = await twilioClient.verify.v2
          .services(env.TWILIO_VERIFY_SERVICE_SID)
          .verificationChecks.create({ to: normalised, code: otp });
        if (check.status !== 'approved') {
          error(res, 'Invalid or expired OTP. Please try again.', 400);
          return;
        }
        try {
          const redis = getRedisClient();
          await redis.del(rk(`del_otp_attempts:${normalised}`));
        } catch { /* optional */ }
      }
    }

    const user = await prisma.user.findUnique({ where: { phone: normalised } });
    if (!user || (user.phone ?? '').startsWith('DELETED_')) {
      error(res, 'Account not found or already deleted.', 404);
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        status: 'BANNED',
        name: 'Deleted User',
        email: null,
        phone: `DELETED_${Date.now()}`,
        fcmToken: null,
        oneSignalPlayerId: null,
      },
    });

    logger.info(`[DeleteAccount] Web deletion for user ${user.id}`);
    success(res, null, 'Account deleted successfully');
  } catch (err) {
    logger.error('confirmAccountDeletion error', { err });
    error(res, 'Failed to delete account. Please try again.', 500);
  }
}

// ─── Web delete account — Google users: submit deletion request ───────────────
export async function submitGoogleDeletionRequest(req: Request, res: Response): Promise<void> {
  const { email, reason, note } = req.body as { email?: string; reason?: string; note?: string };
  if (!email || !email.includes('@')) {
    error(res, 'Please enter a valid email address.', 400);
    return;
  }
  if (!reason || reason.trim().length < 2) {
    error(res, 'Please select a reason for deletion.', 400);
    return;
  }
  try {
    await prisma.accountDeletionRequest.create({
      data: { email: email.trim().toLowerCase(), reason: reason.trim(), note: note?.trim() || null },
    });
    success(res, null, 'Deletion request submitted. We will process it within 48 hours.');
  } catch (err) {
    logger.error('submitGoogleDeletionRequest error', { err });
    error(res, 'Failed to submit request. Please try again.', 500);
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
