import { prisma } from '../config/database';
import { logger } from '../utils/logger';

// ─── OneSignal REST API ───────────────────────────────────────────────────────

async function getOneSignalHeaders() {
  const appId = process.env.ONESIGNAL_APP_ID;
  const apiKey = process.env.ONESIGNAL_REST_API_KEY;
  return { appId, apiKey, ok: !!(appId && apiKey) };
}

/**
 * Push by external user IDs (set via OneSignal.login(userId) in the app).
 * This is the primary push method — no player ID storage needed.
 */
async function pushByExternalIds(
  userIds: string[],
  title: string,
  body: string,
  type: string,
): Promise<void> {
  const { appId, apiKey, ok } = await getOneSignalHeaders();
  if (!ok || userIds.length === 0) return;

  const axios = (await import('axios')).default;

  // OneSignal allows max 2000 external IDs per request
  for (let i = 0; i < userIds.length; i += 2000) {
    const batch = userIds.slice(i, i + 2000);
    try {
      const res = await axios.post(
        'https://onesignal.com/api/v1/notifications',
        {
          app_id: appId,
          include_external_user_ids: batch,
          channel_for_external_user_ids: 'push',
          headings: { en: title },
          contents: { en: body },
          data: { type },
          priority: 10,
        },
        {
          headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 15000,
        },
      );
      const sent = res.data?.recipients ?? batch.length;
      logger.info(`[OneSignal] Pushed to ${sent} recipients (batch ${Math.floor(i / 2000) + 1}) via external IDs`);
    } catch (err: any) {
      logger.error(`[OneSignal] Push batch failed: ${err.response?.data?.errors ?? err.message}`);
    }
  }
}

/**
 * Push by player IDs (legacy — used when we have stored player IDs).
 */
async function pushByPlayerIds(
  playerIds: string[],
  title: string,
  body: string,
  type: string,
): Promise<void> {
  const { appId, apiKey, ok } = await getOneSignalHeaders();
  if (!ok || playerIds.length === 0) return;

  const axios = (await import('axios')).default;

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
          headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 15000,
        },
      );
      logger.info(`[OneSignal] Pushed to ${batch.length} devices (batch ${Math.floor(i / 2000) + 1}) via player IDs`);
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

  // 2. Push via external user IDs (set by OneSignal.login(userId) in the app)
  //    Falls back to stored player IDs for users who haven't used the new app yet
  await pushByExternalIds(userIds, title, body, type);

  // 3. Fallback: also push by stored player IDs (covers users with old-style registration)
  const usersWithPlayerIds = await prisma.user.findMany({
    where: { id: { in: userIds }, oneSignalPlayerId: { not: null } },
    select: { oneSignalPlayerId: true },
  });
  const playerIds = usersWithPlayerIds.map(u => u.oneSignalPlayerId).filter(Boolean) as string[];
  if (playerIds.length > 0) {
    await pushByPlayerIds(playerIds, title, body, type);
  }
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

  // 1. Write DB notifications
  await prisma.notification.createMany({
    data: users.map(u => ({ userId: u.id, title, body, type })),
    skipDuplicates: true,
  });

  // 2. Push via external user IDs
  const allIds = users.map(u => u.id);
  await pushByExternalIds(allIds, title, body, type);

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
