import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getRedisClient, rk } from '../config/redis';
import { loadSecuritySettings } from '../services/securitySettings.service';
import { logger } from '../utils/logger';

export async function verifyRequestSignature(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const settings = await loadSecuritySettings();
    if (!settings.enableRequestSigning) {
      next();
      return;
    }

    const timestamp = req.headers['x-timestamp'] as string | undefined;
    const signature = req.headers['x-signature'] as string | undefined;
    const requestId = req.headers['x-request-id'] as string | undefined;
    const uid = req.userId ?? '';

    if (!timestamp || !signature) {
      // Old app version — don't block, just log
      logger.warn('[RequestSign] Missing headers, uid:', uid);
      next();
      return;
    }

    // Reject requests older than 5 minutes (replay attack prevention)
    const requestTime = parseInt(timestamp, 10);
    if (isNaN(requestTime) || Date.now() - requestTime > 5 * 60 * 1000) {
      res.status(400).json({ error: 'true', message: 'Request expired. Please try again.' });
      return;
    }

    // Check request ID not already used (replay prevention) — stored in Redis with 10 min TTL
    if (requestId) {
      try {
        const redis = getRedisClient();
        const alreadyUsed = await redis.get(rk(`req:${requestId}`));
        if (alreadyUsed) {
          logger.warn('[RequestSign] Replay attack detected, uid:', uid);
          res.status(400).json({ error: 'true', message: 'Duplicate request detected.' });
          return;
        }
        await redis.setex(rk(`req:${requestId}`), 600, '1');
      } catch {
        // Redis unavailable — skip replay check, don't block
        logger.warn('[RequestSign] Redis unavailable — skipping replay check');
      }
    }

    // Verify signature
    const body = req.body ?? {};
    const payload = [
      req.method.toUpperCase(),
      req.path,
      JSON.stringify(body),
      timestamp,
      uid,
    ].join('|');

    const secret = process.env.REQUEST_SECRET;
    if (!secret) {
      // Secret not configured — fail open
      logger.warn('[RequestSign] REQUEST_SECRET not set — skipping signature verification');
      next();
      return;
    }

    const expected = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    let valid = false;
    try {
      valid = crypto.timingSafeEqual(
        Buffer.from(signature.padEnd(expected.length, '0').slice(0, expected.length), 'hex'),
        Buffer.from(expected, 'hex'),
      );
    } catch {
      valid = false;
    }

    if (!valid) {
      logger.warn('[RequestSign] Invalid signature, uid:', uid);
      res.status(403).json({ error: 'true', message: 'Invalid request signature.' });
      return;
    }

    next();
  } catch (error) {
    // FAIL OPEN — never block legitimate users due to security bugs
    logger.error('[RequestSign] Middleware error:', error);
    next();
  }
}
