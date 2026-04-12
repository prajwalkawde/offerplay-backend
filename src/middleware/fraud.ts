import { Request, Response, NextFunction, RequestHandler } from 'express';
import { getRedisClient, rk } from '../config/redis';
import { logger } from '../utils/logger';

/**
 * Factory that returns a per-action fraud-rate middleware.
 *
 * Each action gets its own Redis counter (60-second window).
 * Burst threshold: >10 requests/minute per user → warning logged.
 *
 * Fails open — never blocks legitimate traffic on Redis errors.
 *
 * Usage: router.post('/enter', fraudCheck('offer_enter'), controller)
 */
export function fraudCheck(action: string): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const userId = req.userId;
    if (!userId) {
      next();
      return;
    }

    try {
      const redis = getRedisClient();
      const key = rk(`fraud:${userId}:${action}`);
      const count = await redis.incr(key);

      if (count === 1) {
        await redis.expire(key, 60);
      }

      // Flag suspicious burst activity (>10 sensitive requests/minute per action)
      if (count > 10) {
        logger.warn('Potential fraud detected', {
          userId,
          action,
          requestCount: count,
          path: req.path,
        });
      }

      next();
    } catch {
      // Fail open — never block a user due to Redis unavailability
      next();
    }
  };
}
