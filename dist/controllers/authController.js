"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendOtp = sendOtp;
exports.verifyPhone = verifyPhone;
exports.phoneFirebaseVerify = phoneFirebaseVerify;
exports.completeProfile = completeProfile;
exports.updateFCMToken = updateFCMToken;
exports.googleAuth = googleAuth;
exports.googleLogin = googleLogin;
exports.logout = logout;
exports.getMe = getMe;
exports.updateProfile = updateProfile;
exports.devLogin = devLogin;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const twilio_1 = __importDefault(require("twilio"));
const database_1 = require("../config/database");
const redis_1 = require("../config/redis");
const coinService_1 = require("../services/coinService");
const referralService_1 = require("../services/referralService");
const crypto_1 = require("../utils/crypto");
const response_1 = require("../utils/response");
const env_1 = require("../config/env");
const client_1 = require("@prisma/client");
const logger_1 = require("../utils/logger");
const twilioClient = (0, twilio_1.default)(env_1.env.TWILIO_ACCOUNT_SID, env_1.env.TWILIO_AUTH_TOKEN);
function generateJwt(userId) {
    return jsonwebtoken_1.default.sign({ userId }, env_1.env.JWT_SECRET, { expiresIn: env_1.env.JWT_EXPIRES_IN });
}
// ─── Test phone helpers (DB-driven) ──────────────────────────────────────────
const FALLBACK_TEST_PHONES = [];
async function getTestPhoneOtp(phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    try {
        const testMode = await database_1.prisma.appSettings.findUnique({ where: { key: 'TEST_MODE_ENABLED' } });
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
                database_1.prisma.appSettings.findUnique({ where: { key: `TEST_PHONE_${i}` } }),
                database_1.prisma.appSettings.findUnique({ where: { key: `TEST_OTP_${i}` } }),
            ]);
            const testPhoneClean = (tp?.value ?? '').replace(/\D/g, '');
            if (testPhoneClean && cleanPhone.endsWith(testPhoneClean)) {
                return to?.value || null;
            }
        }
    }
    catch {
        // DB unavailable — fall back to hardcoded
        if (process.env.NODE_ENV !== 'production') {
            const isHardcoded = FALLBACK_TEST_PHONES.some(p => cleanPhone.includes(p));
            return isHardcoded ? '123456' : null;
        }
    }
    return null;
}
function isTestPhone(phone) {
    return FALLBACK_TEST_PHONES.some(p => phone.replace(/\D/g, '').includes(p));
}
// ─── Send OTP ────────────────────────────────────────────────────────────────
async function sendOtp(req, res) {
    const { phone } = req.body;
    try {
        // Check if test phone first (DB lookup, no Redis needed)
        const testOtp = await getTestPhoneOtp(phone).catch(() => null);
        const isTest = !!testOtp || isTestPhone(phone);
        // For test phones: respond immediately — no Redis required
        if (isTest) {
            const otp = testOtp ?? '123456';
            logger_1.logger.info(`[OTP-TEST] ${phone} → ${otp}`);
            // Try to cache in Redis but don't fail if Redis is down
            try {
                const redis = (0, redis_1.getRedisClient)();
                await redis.setex((0, redis_1.rk)(`otp:${phone}`), 300, otp);
            }
            catch {
                logger_1.logger.warn(`[OTP-TEST] Redis unavailable — test OTP will verify via DB`);
            }
            (0, response_1.success)(res, { otp }, 'OTP sent successfully');
            return;
        }
        // Real phone — rate limit via Redis, send OTP via Twilio Verify
        const redis = (0, redis_1.getRedisClient)();
        const attempts = await redis.incr((0, redis_1.rk)(`otp_attempts:${phone}`));
        if (attempts === 1)
            await redis.expire((0, redis_1.rk)(`otp_attempts:${phone}`), 600);
        if (attempts > 5) {
            (0, response_1.error)(res, 'Too many OTP requests. Please try again in 10 minutes.', 429);
            return;
        }
        await twilioClient.verify.v2
            .services(env_1.env.TWILIO_VERIFY_SERVICE_SID)
            .verifications.create({ to: phone, channel: 'sms' });
        logger_1.logger.info(`[OTP] Twilio Verify sent to ${phone}`);
        (0, response_1.success)(res, null, 'OTP sent successfully');
    }
    catch (err) {
        logger_1.logger.error('Send OTP failed', { err });
        (0, response_1.error)(res, 'Failed to send OTP. Please try again.', 500);
    }
}
// ─── Verify Phone OTP ────────────────────────────────────────────────────────
async function verifyPhone(req, res) {
    const { phone, otp, referralCode, fcmToken, deviceId, appVersion } = req.body;
    try {
        // For test phones: verify against DB test OTP (Redis optional)
        const testOtp = await getTestPhoneOtp(phone).catch(() => null);
        const isTest = !!testOtp || isTestPhone(phone);
        if (isTest) {
            const expectedOtp = testOtp ?? '123456';
            if (otp !== expectedOtp) {
                (0, response_1.error)(res, 'Invalid OTP. Please try again.', 400);
                return;
            }
        }
        else {
            // Real phone — verify via Twilio Verify
            const check = await twilioClient.verify.v2
                .services(env_1.env.TWILIO_VERIFY_SERVICE_SID)
                .verificationChecks.create({ to: phone, code: otp });
            if (check.status !== 'approved') {
                (0, response_1.error)(res, 'Invalid or expired OTP. Please try again.', 400);
                return;
            }
            // Clear rate limit on success
            try {
                const redis = (0, redis_1.getRedisClient)();
                await redis.del((0, redis_1.rk)(`otp_attempts:${phone}`));
            }
            catch { /* Redis optional here */ }
        }
        const existing = await database_1.prisma.user.findUnique({ where: { phone } });
        const isNew = !existing;
        const user = await database_1.prisma.user.upsert({
            where: { phone },
            create: {
                phone,
                referralCode: (0, crypto_1.generateReferralCode)(),
                fcmToken: fcmToken ?? null,
                deviceId: deviceId ?? null,
                appVersion: appVersion ?? null,
                deviceType: 'mobile',
                isPhoneVerified: true,
                lastLoginAt: new Date(),
                lastActiveAt: new Date(),
            },
            update: {
                fcmToken: fcmToken ?? undefined,
                deviceId: deviceId ?? undefined,
                appVersion: appVersion ?? undefined,
                deviceType: 'mobile',
                isPhoneVerified: true,
                lastLoginAt: new Date(),
                lastActiveAt: new Date(),
            },
        });
        if (isNew) {
            await (0, coinService_1.creditCoins)(user.id, 100, client_1.TransactionType.EARN_BONUS, undefined, 'Welcome bonus');
            if (referralCode)
                await (0, referralService_1.processReferral)(user.id, referralCode);
        }
        const token = generateJwt(user.id);
        (0, response_1.success)(res, { user, token, isNew, isProfileComplete: user.isProfileComplete }, isNew ? 'Account created! Welcome to OfferPlay 🎉' : 'Welcome back!', isNew ? 201 : 200);
    }
    catch (err) {
        logger_1.logger.error('Phone verify failed', { err });
        (0, response_1.error)(res, 'Verification failed. Please try again.', 500);
    }
}
// ─── Firebase Phone Auth Verify ──────────────────────────────────────────────
async function phoneFirebaseVerify(req, res) {
    const { idToken, fcmToken, deviceId, referralCode, appVersion } = req.body;
    try {
        const { verifyFirebaseToken } = await Promise.resolve().then(() => __importStar(require('../config/firebase')));
        const decoded = await verifyFirebaseToken(idToken);
        const phone = decoded.phone_number;
        if (!phone) {
            (0, response_1.error)(res, 'Invalid Firebase token: no phone number', 400);
            return;
        }
        const existing = await database_1.prisma.user.findUnique({ where: { phone } });
        const isNew = !existing;
        const user = await database_1.prisma.user.upsert({
            where: { phone },
            create: {
                phone,
                referralCode: (0, crypto_1.generateReferralCode)(),
                fcmToken: fcmToken ?? null,
                deviceId: deviceId ?? null,
                appVersion: appVersion ?? null,
                deviceType: 'mobile',
                isPhoneVerified: true,
                lastLoginAt: new Date(),
                lastActiveAt: new Date(),
            },
            update: {
                fcmToken: fcmToken ?? undefined,
                deviceId: deviceId ?? undefined,
                appVersion: appVersion ?? undefined,
                deviceType: 'mobile',
                isPhoneVerified: true,
                lastLoginAt: new Date(),
                lastActiveAt: new Date(),
            },
        });
        if (isNew) {
            await (0, coinService_1.creditCoins)(user.id, 100, client_1.TransactionType.EARN_BONUS, undefined, 'Welcome bonus');
            if (referralCode)
                await (0, referralService_1.processReferral)(user.id, referralCode);
        }
        const token = generateJwt(user.id);
        (0, response_1.success)(res, { user, token, isNew, isProfileComplete: user.isProfileComplete }, isNew ? 'Account created! Welcome to OfferPlay 🎉' : 'Welcome back!', isNew ? 201 : 200);
    }
    catch (err) {
        logger_1.logger.error('Firebase phone verify failed', { err });
        (0, response_1.error)(res, 'Phone verification failed. Please try again.', 401);
    }
}
// ─── Complete Profile ────────────────────────────────────────────────────────
async function completeProfile(req, res) {
    const userId = req.userId;
    if (!userId) {
        (0, response_1.error)(res, 'Unauthorized', 401);
        return;
    }
    const { name, email, dateOfBirth, city, state, country, favouriteTeam, referralCode } = req.body;
    try {
        const existing = await database_1.prisma.user.findUnique({ where: { id: userId } });
        if (!existing) {
            (0, response_1.error)(res, 'User not found', 404);
            return;
        }
        // Check referral code if provided and not already referred
        if (referralCode && !existing.referredBy) {
            await (0, referralService_1.processReferral)(userId, referralCode).catch(() => { });
        }
        const user = await database_1.prisma.user.update({
            where: { id: userId },
            data: {
                name: name.trim(),
                email: email?.trim() || undefined,
                dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
                city: city?.trim() || undefined,
                state: state?.trim() || undefined,
                country: country || undefined,
                favouriteTeam: favouriteTeam || undefined,
                isProfileComplete: true,
                isEmailVerified: email ? false : undefined, // Reset until verified
            },
        });
        (0, response_1.success)(res, { user }, 'Profile updated successfully');
    }
    catch (err) {
        logger_1.logger.error('Complete profile failed', {
            userId,
            errCode: err?.code,
            errMsg: err?.message,
            errMeta: err?.meta,
        });
        if (err.code === 'P2002') {
            (0, response_1.error)(res, 'This email is already in use.', 409);
        }
        else {
            (0, response_1.error)(res, 'Failed to update profile. Please try again.', 500);
        }
    }
}
// ─── Update FCM Token ────────────────────────────────────────────────────────
async function updateFCMToken(req, res) {
    const userId = req.userId;
    const { fcmToken } = req.body;
    try {
        await database_1.prisma.user.update({ where: { id: userId }, data: { fcmToken } });
        (0, response_1.success)(res, null, 'FCM token updated');
    }
    catch (err) {
        logger_1.logger.error('FCM token update failed', { err });
        (0, response_1.error)(res, 'Failed to update FCM token', 500);
    }
}
// ─── Google Auth ─────────────────────────────────────────────────────────────
async function googleAuth(req, res) {
    const { idToken, fcmToken, deviceId, referralCode } = req.body;
    try {
        const { verifyFirebaseToken } = await Promise.resolve().then(() => __importStar(require('../config/firebase')));
        const decoded = await verifyFirebaseToken(idToken);
        const googleId = decoded.uid;
        const email = decoded.email || null;
        const name = decoded.name || null;
        // Find by googleId OR email (account linking)
        const existing = await database_1.prisma.user.findFirst({
            where: { OR: [{ googleId }, ...(email ? [{ email }] : [])] },
        });
        const isNew = !existing;
        const user = existing
            ? await database_1.prisma.user.update({
                where: { id: existing.id },
                data: {
                    googleId: existing.googleId ?? googleId,
                    email: email ?? undefined,
                    name: existing.name || name || undefined,
                    isEmailVerified: email ? true : undefined,
                    fcmToken: fcmToken ?? undefined,
                    deviceId: deviceId ?? undefined,
                    lastLoginAt: new Date(),
                    lastActiveAt: new Date(),
                },
            })
            : await database_1.prisma.user.create({
                data: {
                    googleId,
                    email,
                    name,
                    referralCode: (0, crypto_1.generateReferralCode)(),
                    isEmailVerified: !!email,
                    isProfileComplete: false,
                    fcmToken: fcmToken ?? null,
                    deviceId: deviceId ?? null,
                    lastLoginAt: new Date(),
                    lastActiveAt: new Date(),
                },
            });
        if (isNew) {
            await (0, coinService_1.creditCoins)(user.id, 100, client_1.TransactionType.EARN_BONUS, undefined, 'Welcome bonus');
            if (referralCode)
                await (0, referralService_1.processReferral)(user.id, referralCode).catch(() => { });
        }
        const token = generateJwt(user.id);
        (0, response_1.success)(res, { user, token, isNew, isProfileComplete: user.isProfileComplete }, isNew ? 'Account created! Welcome to OfferPlay 🎉' : 'Welcome back!', isNew ? 201 : 200);
    }
    catch (err) {
        logger_1.logger.error('Google auth failed', { err });
        (0, response_1.error)(res, 'Google authentication failed. Please try again.', 401);
    }
}
// ─── Google Login (native sign-in, 50-coin bonus) ────────────────────────────
async function googleLogin(req, res) {
    const { idToken, fcmToken, deviceId, referralCode } = req.body;
    try {
        const { verifyFirebaseToken } = await Promise.resolve().then(() => __importStar(require('../config/firebase')));
        const decoded = await verifyFirebaseToken(idToken);
        const googleId = decoded.uid;
        const email = decoded.email || null;
        const name = decoded.name || null;
        // Find by googleId OR email (account linking)
        const existing = await database_1.prisma.user.findFirst({
            where: { OR: [{ googleId }, ...(email ? [{ email }] : [])] },
        });
        const isNew = !existing;
        const user = existing
            ? await database_1.prisma.user.update({
                where: { id: existing.id },
                data: {
                    googleId: existing.googleId ?? googleId,
                    email: email ?? undefined,
                    name: existing.name || name || undefined,
                    isEmailVerified: email ? true : undefined,
                    fcmToken: fcmToken ?? undefined,
                    deviceId: deviceId ?? undefined,
                    lastLoginAt: new Date(),
                    lastActiveAt: new Date(),
                },
            })
            : await database_1.prisma.user.create({
                data: {
                    googleId,
                    email,
                    name,
                    referralCode: (0, crypto_1.generateReferralCode)(),
                    isEmailVerified: !!email,
                    isProfileComplete: false,
                    fcmToken: fcmToken ?? null,
                    deviceId: deviceId ?? null,
                    lastLoginAt: new Date(),
                    lastActiveAt: new Date(),
                },
            });
        if (isNew) {
            await (0, coinService_1.creditCoins)(user.id, 50, client_1.TransactionType.EARN_BONUS, undefined, 'Google signup bonus');
            if (referralCode)
                await (0, referralService_1.processReferral)(user.id, referralCode).catch(() => { });
        }
        const token = generateJwt(user.id);
        (0, response_1.success)(res, { user, token, isNew, isProfileComplete: user.isProfileComplete }, isNew ? 'Account created! Welcome to OfferPlay 🎉' : 'Welcome back!', isNew ? 201 : 200);
    }
    catch (err) {
        logger_1.logger.error('Google login failed', { err });
        (0, response_1.error)(res, 'Google authentication failed. Please try again.', 401);
    }
}
// ─── Logout ──────────────────────────────────────────────────────────────────
async function logout(req, res) {
    const token = req.headers.authorization?.substring(7);
    if (token) {
        const redis = (0, redis_1.getRedisClient)();
        await redis.setex((0, redis_1.rk)(`blacklist:${token}`), 30 * 24 * 60 * 60, '1');
    }
    (0, response_1.success)(res, null, 'Logged out successfully');
}
// ─── Get Me ──────────────────────────────────────────────────────────────────
async function getMe(req, res) {
    (0, response_1.success)(res, req.user);
}
// ─── Update Profile ──────────────────────────────────────────────────────────
async function updateProfile(req, res) {
    const userId = req.userId;
    const { name, email, city, state, favouriteTeam } = req.body;
    if (!name || name.trim().length < 2) {
        (0, response_1.error)(res, 'Valid name required', 400);
        return;
    }
    try {
        if (email) {
            const emailExists = await database_1.prisma.user.findFirst({
                where: { email: email.toLowerCase().trim(), id: { not: userId } },
            });
            if (emailExists) {
                (0, response_1.error)(res, 'Email already in use by another account', 409);
                return;
            }
        }
        const user = await database_1.prisma.user.update({
            where: { id: userId },
            data: {
                name: name.trim(),
                email: email ? email.toLowerCase().trim() : null,
                city: city?.trim() || null,
                state: state?.trim() || null,
                favouriteTeam: favouriteTeam || null,
            },
        });
        (0, response_1.success)(res, {
            user: {
                id: user.id, name: user.name, email: user.email,
                city: user.city, state: user.state, favouriteTeam: user.favouriteTeam,
            },
        }, 'Profile updated!');
    }
    catch (err) {
        logger_1.logger.error('updateProfile:', err);
        (0, response_1.error)(res, 'Failed to update profile', 500);
    }
}
// ─── Dev-only login (generates real JWT for test phone) ──────────────────────
async function devLogin(req, res) {
    if (process.env.NODE_ENV === 'production') {
        (0, response_1.error)(res, 'Not available in production', 403);
        return;
    }
    const phone = req.body.phone || '+910000000000';
    try {
        const user = await database_1.prisma.user.upsert({
            where: { phone },
            create: { phone, referralCode: (0, crypto_1.generateReferralCode)(), name: 'Dev User', isPhoneVerified: true },
            update: {},
        });
        const token = generateJwt(user.id);
        (0, response_1.success)(res, { user, token, isNew: false, isProfileComplete: user.isProfileComplete }, 'Dev login successful');
    }
    catch (err) {
        logger_1.logger.error('Dev login failed', { err });
        (0, response_1.error)(res, 'Dev login failed', 500);
    }
}
