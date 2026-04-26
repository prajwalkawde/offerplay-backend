import { Request, Response } from 'express';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import { checkSecurity } from '../services/securityCheck.service';

export async function getSecurityCheck(req: Request, res: Response): Promise<void> {
  try {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      req.ip ??
      'unknown';
    const fingerprint = req.headers['x-device-fingerprint'] as string | undefined;

    const result = await checkSecurity({
      uid: req.userId!,
      ip,
      fingerprint,
    });

    success(res, result);
  } catch (err) {
    logger.error('[Security] check error', { err, uid: req.userId });
    error(res, 'Security check failed', 500);
  }
}
