"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendOtp = sendOtp;
exports.verifyPhone = verifyPhone;
exports.completeProfile = completeProfile;
exports.updateFCMToken = updateFCMToken;
exports.googleAuth = googleAuth;
exports.logout = logout;
exports.getMe = getMe;
exports.updateProfile = updateProfile;
exports.devLogin = devLogin;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = require("../config/database");
const redis_1 = require("../config/redis");
const coinService_1 = require("../services/coinService");
const referralService_1 = require("../services/referralService");
const crypto_1 = require("../utils/crypto");
const response_1 = require("../utils/response");
const env_1 = require("../config/env");
const client_1 = require("@prisma/client");
const logger_1 = require("../utils/logger");
function generateJwt(userId) {
    return jsonwebtoken_1.default.sign({ userId }, env_1.env.JWT_SECRET, { expiresIn: env_1.env.JWT_EXPIRES_IN });
}
// ─── Test phone helpers (DB-driven) ──────────────────────────────────────────
const FALLBACK_TEST_PHONES = ['8381071568'];
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
        const redis = (0, redis_1.getRedisClient)();
        // Rate limit: max 5 OTPs per phone per 10 minutes (skip for test phones)
        const isTest = !!(await getTestPhoneOtp(phone).catch(() => null)) || isTestPhone(phone);
        if (!isTest) {
            const attempts = await redis.incr(`otp_attempts:${phone}`);
            if (attempts === 1)
                await redis.expire(`otp_attempts:${phone}`, 600);
            if (attempts > 5) {
                (0, response_1.error)(res, 'Too many OTP requests. Please try again in 10 minutes.', 429);
                return;
            }
        }
        // Check DB for test OTP; fall back to random in prod
        const testOtp = await getTestPhoneOtp(phone);
        const otp = testOtp
            ?? (process.env.NODE_ENV !== 'production'
                ? '123456'
                : String(Math.floor(100000 + Math.random() * 900000)));
        // Store OTP in Redis with 5 min TTL
        await redis.setex(`otp:${phone}`, 300, otp);
        // TODO: Send OTP via SMS provider (MSG91 / Twilio) in production
        logger_1.logger.info(`[OTP] ${phone} → ${otp}`);
        (0, response_1.success)(res, process.env.NODE_ENV !== 'production' ? { otp } : null, 'OTP sent successfully');
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
        const redis = (0, redis_1.getRedisClient)();
        const storedOtp = await redis.get(`otp:${phone}`);
        if (!storedOtp || storedOtp !== otp) {
            (0, response_1.error)(res, 'Invalid or expired OTP. Please try again.', 400);
            return;
        }
        // Consume OTP
        await redis.del(`otp:${phone}`);
        await redis.del(`otp_attempts:${phone}`);
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
// ─── Complete Profile ────────────────────────────────────────────────────────
async function completeProfile(req, res) {
    const userId = req.user?.id;
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
        logger_1.logger.error('Complete profile failed', { err });
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
    const userId = req.user?.id;
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
    (0, response_1.error)(res, 'Google auth coming soon', 501);
}
// ─── Logout ──────────────────────────────────────────────────────────────────
async function logout(req, res) {
    const token = req.headers.authorization?.substring(7);
    if (token) {
        const redis = (0, redis_1.getRedisClient)();
        await redis.setex(`blacklist:${token}`, 30 * 24 * 60 * 60, '1');
    }
    (0, response_1.success)(res, null, 'Logged out successfully');
}
// ─── Get Me ──────────────────────────────────────────────────────────────────
async function getMe(req, res) {
    (0, response_1.success)(res, req.user);
}
// ─── Update Profile ──────────────────────────────────────────────────────────
async function updateProfile(req, res) {
    const userId = req.user?.id;
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
