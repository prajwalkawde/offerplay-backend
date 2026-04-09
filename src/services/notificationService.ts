import { prisma } from '../config/database';
import { logger } from '../utils/logger';

// ─── OneSignal REST API push ──────────────────────────────────────────────────
async function pushViaOneSignal(
  playerIds: string[],
  title: string,
  body: string,
  type: string,
): Promise<void> {
  const appId = process.env.ONESIGNAL_APP_ID;
  const apiKey = process.env.ONESIGNAL_REST_API_KEY;
  if (!appId || !apiKey) {
    logger.warn('[OneSignal] ONESIGNAL_APP_ID or ONESIGNAL_REST_API_KEY not set — skipping push');
    return;
  }
  if (playerIds.length === 0) return;

  const axios = (await import('axios')).default;

  // OneSignal allows max 2000 player IDs per request
  for (let i = 0; i < playerIds.length; i += 2000) {
    const batch = playerIds.slice(i, i + 2000);
    try {
      await axios.post(
        'https://onesignal.com/api/v1/notifications',
        {
          app_id: appId,
          include_player_ids: batch,
          headings: { en: title },
          contents: { en: body },
          data: { type },
          priority: 10,
        },
        {
          headers: {
            Authorization: `Key ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        },
      );
      logger.info(`[OneSignal] Pushed to ${batch.length} devices (batch ${Math.floor(i / 2000) + 1})`);
    } catch (err: any) {
      logger.error(`[OneSignal] Push batch failed: ${err.response?.data?.errors ?? err.message}`);
    }
  }
}

export async function createNotification(
  userId: string,
  title: string,
  body: string,
  type: string
): Promise<void> {
  await prisma.notification.create({ data: { userId, title, body, type } });
}

export async function getUserNotifications(
  userId: string,
  limit = 20,
  page = 1
): Promise<{ notifications: unknown[]; unreadCount: number }> {
  const skip = (page - 1) * limit;
  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.notification.count({ where: { userId, isRead: false } }),
  ]);
  return { notifications, unreadCount };
}

export async function markAllRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
}

export async function markNotificationRead(notificationId: string, userId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { isRead: true },
  });
}

export async function sendBulkNotification(
  userIds: string[],
  title: string,
  body: string,
  type = 'GENERAL'
): Promise<void> {
  if (userIds.length === 0) return;

  // 1. Save in-app notifications
  await prisma.notification.createMany({
    data: userIds.map(userId => ({ userId, title, body, type })),
    skipDuplicates: true,
  }).catch(() => {});

  // 2. Fetch OneSignal player IDs for these users
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, oneSignalPlayerId: { not: null } },
    select: { oneSignalPlayerId: true },
  });

  const playerIds = users.map(u => u.oneSignalPlayerId).filter(Boolean) as string[];
  if (playerIds.length === 0) {
    logger.warn(`sendBulkNotification: no OneSignal IDs found for ${userIds.length} users`);
    return;
  }

  await pushViaOneSignal(playerIds, title, body, type);
}

export async function sendToAll(
  title: string,
  body: string,
  type: string
): Promise<void> {
  const users = await prisma.user.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, oneSignalPlayerId: true },
    take: 10000,
  });

  // 1. Write DB notifications in bulk
  await prisma.notification.createMany({
    data: users.map(u => ({ userId: u.id, title, body, type })),
    skipDuplicates: true,
  });

  // 2. Push to all users with a OneSignal player ID
  const playerIds = users.map(u => u.oneSignalPlayerId).filter(Boolean) as string[];
  if (playerIds.length > 0) {
    await pushViaOneSignal(playerIds, title, body, type);
  }

  logger.info(`sendToAll: notified ${users.length} users — type=${type}`);
}

// Legacy single-token FCM — kept for any callers that still use it
export async function sendPushNotification(
  fcmToken: string,
  title: string,
  body: string,
  _data?: Record<string, string>
): Promise<void> {
  logger.warn('sendPushNotification (FCM) called but app uses OneSignal — token ignored');
}
