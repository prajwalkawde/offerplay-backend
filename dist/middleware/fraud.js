"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fraudCheck = fraudCheck;
const redis_1 = require("../config/redis");
const logger_1 = require("../utils/logger");
async function fraudCheck(req, res, next) {
    const userId = req.userId;
    if (!userId) {
        next();
        return;
    }
    try {
        const redis = (0, redis_1.getRedisClient)();
        const key = `fraud:${userId}`;
        const count = await redis.incr(key);
        if (count === 1) {
            await redis.expire(key, 60);
        }
        // Flag suspicious burst activity (>10 sensitive requests/minute)
        if (count > 10) {
            logger_1.logger.warn('Potential fraud detected', { userId, requestCount: count, path: req.path });
        }
        next();
    }
    catch {
        next();
    }
}
