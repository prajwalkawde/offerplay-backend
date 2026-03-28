"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendOtp = sendOtp;
exports.verifyPhone = verifyPhone;
exports.googleAuth = googleAuth;
exports.logout = logout;
exports.getMe = getMe;
exports.devLogin = devLogin;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = require("../config/database");
const firebase_1 = require("../config/firebase");
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
async function sendOtp(req, res) {
    // Firebase phone auth handles OTP sending client-side.
    // This endpoint is a no-op server-side — kept for API completeness.
    (0, response_1.success)(res, null, 'OTP sent via Firebase. Verify on client.');
}
async function verifyPhone(req, res) {
    const { idToken, referralCode, fcmToken, deviceId } = req.body;
    try {
        const decoded = await (0, firebase_1.verifyFirebaseToken)(idToken);
        const phone = decoded.phone_number;
        if (!phone) {
            (0, response_1.error)(res, 'Phone number not found in token', 400);
            return;
        }
        const isNew = !(await database_1.prisma.user.findUnique({ where: { phone } }));
        const user = await database_1.prisma.user.upsert({
            where: { phone },
            create: {
                phone,
                referralCode: (0, crypto_1.generateReferralCode)(),
                fcmToken: fcmToken ?? null,
                deviceId: deviceId ?? null,
            },
            update: {
                fcmToken: fcmToken ?? undefined,
                deviceId: deviceId ?? undefined,
            },
        });
        if (isNew) {
            await (0, coinService_1.creditCoins)(user.id, 100, client_1.TransactionType.EARN_BONUS, undefined, 'Welcome bonus');
            if (referralCode)
                await (0, referralService_1.processReferral)(user.id, referralCode);
        }
        const token = generateJwt(user.id);
        (0, response_1.success)(res, { user, token, isNew }, isNew ? 'Account created' : 'Login successful', isNew ? 201 : 200);
    }
    catch (err) {
        logger_1.logger.error('Phone verify failed', { err });
        (0, response_1.error)(res, 'Firebase token verification failed', 401);
    }
}
async function googleAuth(req, res) {
    const { idToken, fcmToken, deviceId } = req.body;
    try {
        const decoded = await (0, firebase_1.verifyFirebaseToken)(idToken);
        const googleId = decoded.uid;
        const email = decoded.email ?? null;
        const name = decoded.name ?? null;
        const isNew = !(await database_1.prisma.user.findUnique({ where: { googleId } }));
        const user = await database_1.prisma.user.upsert({
            where: { googleId },
            create: {
                googleId,
                email,
                name,
                referralCode: (0, crypto_1.generateReferralCode)(),
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
            await (0, coinService_1.creditCoins)(user.id, 100, client_1.TransactionType.EARN_BONUS, undefined, 'Welcome bonus');
        }
        const token = generateJwt(user.id);
        (0, response_1.success)(res, { user, token, isNew }, isNew ? 'Account created' : 'Login successful', isNew ? 201 : 200);
    }
    catch (err) {
        logger_1.logger.error('Google auth failed', { err });
        (0, response_1.error)(res, 'Firebase token verification failed', 401);
    }
}
async function logout(req, res) {
    const token = req.headers.authorization?.substring(7);
    if (token) {
        const redis = (0, redis_1.getRedisClient)();
        // Blacklist for 30 days
        await redis.setex(`blacklist:${token}`, 30 * 24 * 60 * 60, '1');
    }
    (0, response_1.success)(res, null, 'Logged out successfully');
}
async function getMe(req, res) {
    (0, response_1.success)(res, req.user);
}
// ─── Dev-only: generate real JWT for test phone (development only) ────────────
async function devLogin(req, res) {
    if (process.env.NODE_ENV === 'production') {
        (0, response_1.error)(res, 'Not available in production', 403);
        return;
    }
    const phone = req.body.phone || '+910000000000';
    try {
        const user = await database_1.prisma.user.upsert({
            where: { phone },
            create: { phone, referralCode: (0, crypto_1.generateReferralCode)(), name: 'Dev User' },
            update: {},
        });
        const token = generateJwt(user.id);
        (0, response_1.success)(res, { user, token, isNew: false }, 'Dev login successful');
    }
    catch (err) {
        logger_1.logger.error('Dev login failed', { err });
        (0, response_1.error)(res, 'Dev login failed', 500);
    }
}
