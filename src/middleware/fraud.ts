import { Request, Response, NextFunction } from 'express';
import { getRedisClient } from '../config/redis';
import { logger } from '../utils/logger';

export async function fraudCheck(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    next();
    return;
  }

  try {
    const redis = getRedisClient();
    const key = `fraud:${userId}`;
    const count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, 60);
    }

    // Flag suspicious burst activity (>10 sensitive requests/minute)
    if (count > 10) {
      logger.warn('Potential fraud detected', { userId, requestCount: count, path: req.path });
    }

    next();
  } catch {
    next();
  }
}
