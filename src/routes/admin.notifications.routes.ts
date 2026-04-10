import { Router, Request, Response } from 'express';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { sendBulkNotification, sendToAll } from '../services/notificationService';
import { logger } from '../utils/logger';

const router = Router();

// ─── Stats ────────────────────────────────────────────────────────────────────

router.get('/stats', async (_req: Request, res: Response) => {
  const [totalUsers, usersWithFCM, totalSent, unreadCount] = await Promise.all([
    prisma.user.count({ where: { status: 'ACTIVE' } }),
    prisma.user.count({ where: { status: 'ACTIVE', fcmToken: { not: null } } }),
    prisma.notification.count(),
    prisma.notification.count({ where: { isRead: false } }),
  ]);

  return success(res, {
    totalUsers,
    usersWithFCM,
    fcmCoverage: totalUsers > 0 ? Math.round((usersWithFCM / totalUsers) * 100) : 0,
    totalSent,
    unreadCount,
  });
});

// ─── History ──────────────────────────────────────────────────────────────────

router.get('/history', async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const type = req.query.type as string | undefined;
  const skip = (page - 1) * limit;

  const where = type ? { type } : {};

  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        user: { select: { id: true, name: true, phone: true } },
      },
    }),
    prisma.notification.count({ where }),
  ]);

  return success(res, { notifications, total, page, limit });
});

// ─── Send to all users ────────────────────────────────────────────────────────

router.post('/send-all', async (req: Request, res: Response) => {
  const { title, body, type } = req.body as { title?: string; body?: string; type?: string };
  if (!title || !body) return error(res, 'title and body are required', 400);

  try {
    await sendToAll(title, body, type ?? 'ADMIN');
    logger.info(`[Admin] Broadcast notification sent: "${title}"`);
    return success(res, null, 'Notification sent to all users');
  } catch (err) {
    logger.error('[Admin] Broadcast failed:', err);
    return error(res, 'Failed to send notification', 500);
  }
});

// ─── Send to specific users ───────────────────────────────────────────────────

router.post('/send-users', async (req: Request, res: Response) => {
  const { title, body, type, userIds } = req.body as {
    title?: string; body?: string; type?: string; userIds?: string[];
  };
  if (!title || !body) return error(res, 'title and body are required', 400);
  if (!userIds || userIds.length === 0) return error(res, 'userIds array is required', 400);

  try {
    await sendBulkNotification(userIds, title, body, type ?? 'ADMIN');
    logger.info(`[Admin] Targeted notification sent to ${userIds.length} user(s): "${title}"`);
    return success(res, { sent: userIds.length }, `Notification sent to ${userIds.length} user(s)`);
  } catch (err) {
    logger.error('[Admin] Targeted send failed:', err);
    return error(res, 'Failed to send notification', 500);
  }
});

// ─── Search users (for targeting) ────────────────────────────────────────────

router.get('/users/search', async (req: Request, res: Response) => {
  const q = (req.query.q as string ?? '').trim();
  if (!q) return success(res, []);

  const users = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
      ],
    },
    select: { id: true, name: true, phone: true, fcmToken: true },
    take: 20,
  });

  return success(res, users.map(u => ({
    ...u,
    hasFCM: !!u.fcmToken,
    fcmToken: undefined,
  })));
});

// ─── Notification types summary ───────────────────────────────────────────────

router.get('/types', async (_req: Request, res: Response) => {
  const types = await prisma.notification.groupBy({
    by: ['type'],
    _count: { type: true },
    orderBy: { _count: { type: 'desc' } },
  });
  return success(res, types.map(t => ({ type: t.type, count: t._count.type })));
});

export default router;
