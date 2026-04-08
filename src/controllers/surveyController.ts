import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import { getCPXSurveys, getCPXSurveyWallUrl } from '../services/surveyService';

export async function getSurveys(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true },
    });
    const rawIp = (req.headers['x-forwarded-for'] as string) || req.socket?.remoteAddress || req.ip || '';
    const realIp = rawIp.split(',')[0].trim();
    const surveys = await getCPXSurveys(userId, user?.email ?? undefined, realIp, user?.name ?? undefined);
    success(res, { total: surveys.length, surveys });
  } catch (err) {
    logger.error('getSurveys error:', err);
    error(res, 'Failed to fetch surveys', 500);
  }
}

export async function getSurveyWallUrl(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true },
    });
    const url = getCPXSurveyWallUrl(userId, user?.email ?? undefined, user?.name ?? undefined);
    success(res, { url });
  } catch (err) {
    error(res, 'Failed to get survey wall URL', 500);
  }
}
