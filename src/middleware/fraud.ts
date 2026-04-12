import { Request, Response, NextFunction, RequestHandler } from 'express';
import { getRedisClient, rk } from '../config/redis';
import { logger } from '../utils/logger';
import { checkRequest } from '../services/fraudDetection.service';

/**
 * Factory that returns a per-action fraud middleware.
 *
 * On every call it runs two checks in sequence:
 *   1. Rate counter  — Redis burst detection (>10 req/min per user per action)
 *   2. Full security — IP multi-account, VPN/proxy, device fingerprint, ban status
 *      via fraudDetection.service.ts → checkRequest()
 *
 * Both checks fail open so legitimate users are never blocked by infra errors.
 *
 * Usage: router.post('/enter', fraudCheck('offer_enter'), controller)
 */
export function fraudCheck(action: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.userId;
    if (!userId) {
      next();
      return;
    }

    // ── 1. Burst rate counter ─────────────────────────────────────────────────
    try {
      const redis = getRedisClient();
      const key = rk(`fraud:${userId}:${action}`);
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, 60);
      if (count > 10) {
        logger.warn('[FraudCheck] Burst detected', {
          userId,
          action,
          requestCount: count,
          path: req.path,
        });
      }
    } catch {
      // Fail open — Redis unavailable
    }

    // ── 2. Full security check (IP, VPN, device fingerprint, ban status) ──────
    try {
      const ip =
        (req.headers['x-forwarded-for'] as string | undefined)
          ?.split(',')[0]
          ?.trim() ??
        req.ip ??
        'unknown';
      const fingerprint = req.headers['x-device-fingerprint'] as string | undefined;

      const result = await checkRequest({ uid: userId, ip, fingerprint });

      if (!result.allowed) {
        logger.warn('[FraudCheck] Blocked', {
          userId,
          action,
          reason: result.reason,
          ip,
        });
        res.status(403).json({
          error: 'true',
          message: result.isBanned
            ? 'Your account has been suspended.'
            : 'Access denied.',
        });
        return;
      }
    } catch {
      // Fail open — never block legitimate users due to security bugs
    }

    next();
  };
}
