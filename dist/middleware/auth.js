"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.optionalAuthMiddleware = optionalAuthMiddleware;
exports.authMiddleware = authMiddleware;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
const redis_1 = require("../config/redis");
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
// Sets req.userId and req.user if a valid token is present; always calls next()
async function optionalAuthMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        try {
            const payload = jsonwebtoken_1.default.verify(token, env_1.env.JWT_SECRET);
            const user = await database_1.prisma.user.findUnique({
                where: { id: payload.userId },
                select: { id: true, name: true, email: true, phone: true, coinBalance: true, ticketBalance: true, referralCode: true, status: true, avatar: true, city: true, state: true, country: true, favouriteTeam: true, isPhoneVerified: true, isEmailVerified: true, isProfileComplete: true, dateOfBirth: true, createdAt: true, lastLoginAt: true, lastActiveAt: true },
            });
            if (user && user.status === 'ACTIVE') {
                req.userId = user.id;
                req.user = user;
            }
        }
        catch {
            // Invalid token — proceed as unauthenticated
        }
    }
    next();
}
async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        (0, response_1.error)(res, 'Unauthorized', 401);
        return;
    }
    const token = authHeader.substring(7);
    try {
        const payload = jsonwebtoken_1.default.verify(token, env_1.env.JWT_SECRET);
        // Check Redis blacklist
        const redis = (0, redis_1.getRedisClient)();
        const blacklisted = await redis.get(`blacklist:${token}`);
        if (blacklisted) {
            (0, response_1.error)(res, 'Token revoked', 401);
            return;
        }
        const user = await database_1.prisma.user.findUnique({
            where: { id: payload.userId },
            select: {
                id: true, name: true, email: true, phone: true,
                coinBalance: true, ticketBalance: true, referralCode: true, status: true,
                avatar: true, city: true, state: true, country: true,
                favouriteTeam: true, isPhoneVerified: true, isEmailVerified: true,
                isProfileComplete: true, dateOfBirth: true, createdAt: true,
                lastLoginAt: true, lastActiveAt: true,
            },
        });
        if (!user) {
            (0, response_1.error)(res, 'User not found', 401);
            return;
        }
        if (user.status !== 'ACTIVE') {
            (0, response_1.error)(res, 'Account suspended or banned', 403);
            return;
        }
        req.userId = user.id;
        req.user = user;
        next();
    }
    catch {
        (0, response_1.error)(res, 'Invalid or expired token', 401);
    }
}
