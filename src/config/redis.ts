import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

let redisClient: Redis;

export function getRedisClient(): Redis {
  if (!redisClient) {
    const isTls = env.REDIS_URL.startsWith('rediss://');

    redisClient = new Redis(env.REDIS_URL, {
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
