import Redis from 'ioredis';
import { logger } from '../utils/logger';

const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  username: process.env.REDIS_USERNAME || undefined,
  password: process.env.REDIS_PASSWORD || undefined,
  retryStrategy(times: number) {
    if (times > 20) return null;
    return Math.min(Math.pow(2, times) * 100, 30000);
  },
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  connectTimeout: 5000,
};

let redisClient: Redis;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(redisConfig);
    redisClient.on('connect', () =>
      logger.info('Redis connected'));
    redisClient.on('ready', () =>
      logger.info('Redis ready'));
    redisClient.on('error', (err) =>
      logger.error('Redis error:', err));
    redisClient.on('reconnecting', () =>
      logger.warn('Redis reconnecting...'));
  }
  return redisClient;
}

export const redis = new Proxy({} as Redis, {
  get(_target, prop) {
    return (getRedisClient() as any)[prop];
  },
});

export { redisConfig };

// Prefix all Redis keys with the ACL username to satisfy Cloudways ACL restrictions
const _prefix = process.env.REDIS_USERNAME || '';
export function rk(key: string): string {
  return _prefix ? `${_prefix}:${key}` : key;
}
