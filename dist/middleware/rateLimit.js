"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiRateLimit = exports.otpRateLimit = void 0;
exports.rateLimit = rateLimit;
const redis_1 = require("../config/redis");
const response_1 = require("../utils/response");
function rateLimit(options) {
    const { windowMs, max, keyPrefix = 'rl', message = 'Too many requests' } = options;
    const windowSec = Math.ceil(windowMs / 1000);
    return async (req, res, next) => {
        const identifier = req.ip || req.socket.remoteAddress || 'unknown';
        const key = `${keyPrefix}:${identifier}`;
        try {
            const redis = (0, redis_1.getRedisClient)();
            const current = await redis.incr(key);
            if (current === 1) {
                await redis.expire(key, windowSec);
            }
            res.setHeader('X-RateLimit-Limit', max);
            res.setHeader('X-RateLimit-Remaining', Math.max(0, max - current));
            if (current > max) {
                (0, response_1.error)(res, message, 429);
                return;
            }
            next();
        }
        catch {
            // Redis unavailable - allow request
            next();
        }
    };
}
exports.otpRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    keyPrefix: 'otp',
    message: 'Too many OTP requests. Try again after 1 hour.',
});
exports.apiRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    keyPrefix: 'api',
    message: 'Too many requests. Try again after 15 minutes.',
});
