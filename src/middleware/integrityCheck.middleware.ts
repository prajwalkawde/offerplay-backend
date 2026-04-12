import { Request, Response, NextFunction } from 'express';
import { verifyIntegrityToken } from '../services/playIntegrity.service';
import { loadSecuritySettings } from '../services/securitySettings.service';
import { logger } from '../utils/logger';
import { error } from '../utils/response';

export async function integrityCheck(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const settings = await loadSecuritySettings();
    if (!settings.enablePlayIntegrity) {
      next();
      return;
    }

    const token = req.headers['x-integrity-token'] as string | undefined;
    const uid = req.userId ?? '';

    if (!token) {
      // No token — could be old app version during rollout — don't block, just log
      logger.warn('[IntegrityCheck] No token for uid:', uid);
      next();
      return;
    }

    const result = await verifyIntegrityToken(token, uid);

    if (!result.passed) {
      logger.warn('[IntegrityCheck] Failed for uid:', uid, 'verdict:', result.verdict);
      error(res, 'Device verification failed. Contact support.', 403);
      return;
    }

    next();
  } catch (err) {
    // FAIL OPEN — never block legitimate users due to security bugs
    logger.error('[IntegrityCheck] Middleware error:', err);
    next();
  }
}
