import { Request, Response, NextFunction } from 'express';
import { getRedisClient, rk } from '../config/redis';
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
    const key = rk(`${keyPrefix}:${identifier}`);

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

// Test phone numbers — bypass all rate limits
const TEST_PHONES = ['8381071568'];

function isTestPhone(req: Request): boolean {
  const phone: string = req.body?.phone || req.query?.phone || '';
  return TEST_PHONES.some(p => String(phone).includes(p));
}

export const otpRateLimit = (req: Request, res: Response, next: NextFunction): void => {
  // Skip rate limit entirely for test phones
  if (isTestPhone(req)) { next(); return; }
  rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 min
    max: 100,                    // generous for dev
    keyPrefix: 'otp',
    message: 'Too many OTP requests. Please wait a moment.',
  })(req, res, next);
};

export const apiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  keyPrefix: 'api',
  message: 'Too many requests. Try again after 15 minutes.',
});
