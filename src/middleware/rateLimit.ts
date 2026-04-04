import { Request, Response, NextFunction } from 'express';
import { getRedisClient } from '../config/redis';
import { error } from '../utils/response';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix?: string;
  message?: string;
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, keyPrefix = 'rl', message = 'Too many requests' } = options;
  const windowSec = Math.ceil(windowMs / 1000);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const identifier = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${keyPrefix}:${identifier}`;

    try {
      const redis = getRedisClient();
      const current = await redis.incr(key);

      if (current === 1) {
        await redis.expire(key, windowSec);
      }

      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - current));

      if (current > max) {
        error(res, message, 429);
        return;
      }

      next();
    } catch {
      // Redis unavailable - allow request
      next();
    }
  };
}

export const otpRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyPrefix: 'otp',
  message: 'Too many OTP requests. Try again after 1 hour.',
});

export const apiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  keyPrefix: 'api',
  message: 'Too many requests. Try again after 15 minutes.',
});
