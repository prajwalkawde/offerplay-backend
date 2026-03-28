"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redis = void 0;
exports.getRedisClient = getRedisClient;
const ioredis_1 = __importDefault(require("ioredis"));
const env_1 = require("./env");
const logger_1 = require("../utils/logger");
let redisClient;
function getRedisClient() {
    if (!redisClient) {
        const isTls = env_1.env.REDIS_URL.startsWith('rediss://');
        redisClient = new ioredis_1.default(env_1.env.REDIS_URL, {
            retryStrategy(times) {
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            // Required for Upstash (rediss://) and other TLS Redis providers
            ...(isTls && {
                tls: {
                    rejectUnauthorized: false,
                },
            }),
        });
        redisClient.on('connect', () => logger_1.logger.info('Redis connected'));
        redisClient.on('ready', () => logger_1.logger.info('Redis ready'));
        redisClient.on('error', (err) => logger_1.logger.error('Redis error:', err));
        redisClient.on('reconnecting', () => logger_1.logger.warn('Redis reconnecting...'));
    }
    return redisClient;
}
exports.redis = new Proxy({}, {
    get(_target, prop) {
        return getRedisClient()[prop];
    },
});
