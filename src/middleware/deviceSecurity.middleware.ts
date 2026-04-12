import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export function logDeviceSecurity(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const isRooted = req.headers['x-is-rooted'] as string | undefined;
  const isEmulator = req.headers['x-is-emulator'] as string | undefined;
  const uid = req.userId;

  if (!uid) {
    next();
    return;
  }

  if (isRooted === 'true') {
    logger.warn('[DeviceSecurity] Rooted device detected, uid:', uid);
  }

  if (isEmulator === 'true') {
    logger.warn('[DeviceSecurity] Emulator detected, uid:', uid);
  }

  next();
}
