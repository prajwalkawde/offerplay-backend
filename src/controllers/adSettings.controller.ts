import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import { loadAdSettings, clearAdSettingsCache, toMobileShape } from '../services/adSettings.service';

// ─── Mobile: GET /api/app/ad-settings ────────────────────────────────────────
// Public read. Mobile fetches on app launch + every focus to decide which ads
// to show. Returns only the subset the client needs (not admin-only fields).

export async function getMobileAdSettings(_req: Request, res: Response): Promise<void> {
  try {
    const settings = await loadAdSettings();
    success(res, toMobileShape(settings));
  } catch (err) {
    logger.error('[AdSettings] mobile read failed', err);
    error(res, 'Failed to load ad settings', 500);
  }
}

// ─── Admin: GET /api/admin/ad-settings ───────────────────────────────────────

export async function getAdminAdSettings(_req: Request, res: Response): Promise<void> {
  try {
    const settings = await loadAdSettings();
    success(res, settings);
  } catch (err) {
    logger.error('[AdSettings] admin read failed', err);
    error(res, 'Failed to load ad settings', 500);
  }
}

// ─── Admin: PUT /api/admin/ad-settings ───────────────────────────────────────

export async function updateAdminAdSettings(req: Request, res: Response): Promise<void> {
  try {
    const updated = await prisma.adSettings.upsert({
      where: { id: 1 },
      update: req.body,
      create: { id: 1, ...req.body },
    });
    await clearAdSettingsCache();
    success(res, updated, 'Ad settings updated');
  } catch (err) {
    logger.error('[AdSettings] admin update failed', err);
    error(res, 'Failed to update ad settings', 500);
  }
}
