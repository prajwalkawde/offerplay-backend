import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

let redisClient: Redis;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      retryStrategy(times) {
        if (times > 20) return null; // stop retrying after 20 attempts
        const delay = Math.min(Math.pow(2, times) * 100, 30000); // exponential backoff, max 30s
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });

    redisClient.on('connect', () => logger.info('Redis connected'));
    redisClient.on('ready', () => logger.info('Redis ready'));
    redisClient.on('error', (err) => logger.error('Redis error:', err));
    redisClient.on('reconnecting', () => logger.warn('Redis reconnecting...'));
  }
  return redisClient;
}

export const redis = new Proxy({} as Redis, {
  get(_target, prop) {
    return (getRedisClient() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
