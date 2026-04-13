import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';

// ─── GET all settings, grouped by category ───────────────────────────────────
export async function getSettings(req: Request, res: Response): Promise<void> {
  try {
    const settings = await prisma.appSettings.findMany({
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
    });

    // Mask secret values and add hasValue flag
    const masked = settings.map(s => ({
      ...s,
      value: s.isSecret && s.value
        ? '••••••••••••' + s.value.slice(-4)
        : s.value,
      _rawValue: s.isSecret ? null : s.value,
      hasValue: s.value.length > 0,
    }));

    // Group by category
    const grouped: Record<string, typeof masked> = {};
    masked.forEach(s => {
      const cat = (s.category || 'GENERAL').toUpperCase();
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(s);
    });

    success(res, grouped);
  } catch (err) {
    logger.error('getSettings error:', err);
    error(res, 'Failed to get settings', 500);
  }
}

// ─── UPDATE single setting ────────────────────────────────────────────────────
export async function updateSetting(req: Request, res: Response): Promise<void> {
  try {
    const { key } = req.params as { key: string };
    const { value } = req.body as { value?: unknown };

    if (value === undefined) {
      error(res, 'Value required', 400);
      return;
    }

    const adminId = req.adminId;

    const setting = await prisma.appSettings.upsert({
      where: { key },
      update: { value: String(value), updatedBy: adminId },
      create: {
        key,
        value: String(value),
        label: key,
        category: 'GENERAL',
        isSecret: false,
        updatedBy: adminId,
      },
    });

    process.env[key] = String(value);

    success(res, { key: setting.key, hasValue: setting.value.length > 0 }, 'Setting saved!');
  } catch (err) {
    logger.error('updateSetting error:', err);
    error(res, 'Failed to save setting', 500);
  }
}

// ─── UPDATE multiple settings (POST /bulk — legacy) ──────────────────────────
export async function updateMultipleSettings(req: Request, res: Response): Promise<void> {
  try {
    const { settings } = req.body as { settings?: Array<{ key: string; value: unknown }> };
    if (!Array.isArray(settings)) { error(res, 'Settings array required', 400); return; }
    await _bulkSave(settings, req.adminId);
    success(res, null, 'Settings saved successfully!');
  } catch (err) {
    logger.error('updateMultipleSettings error:', err);
    error(res, 'Failed to save settings', 500);
  }
}

// ─── UPDATE multiple settings (PUT /bulk/update — new) ───────────────────────
export async function updateBulkPut(req: Request, res: Response): Promise<void> {
  try {
    const { settings } = req.body as { settings?: Array<{ key: string; value: unknown }> };
    if (!Array.isArray(settings)) { error(res, 'Settings array required', 400); return; }
    await _bulkSave(settings, req.adminId);
    success(res, null, 'All settings saved!');
  } catch (err) {
    logger.error('updateBulkPut error:', err);
    error(res, 'Failed to save settings', 500);
  }
}

async function _bulkSave(
  settings: Array<{ key: string; value: unknown }>,
  adminId?: string
): Promise<void> {
  for (const s of settings) {
    if (!s.key || s.value === undefined || s.value === '') continue;
    await prisma.appSettings.upsert({
      where: { key: s.key },
      update: { value: String(s.value), updatedBy: adminId },
      create: {
        key: s.key,
        value: String(s.value),
        label: s.key,
        category: 'LEGAL',
        isSecret: false,
        updatedBy: adminId,
      },
    });
    process.env[s.key] = String(s.value);
  }
}
