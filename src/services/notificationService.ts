import { prisma } from '../config/database';
import { logger } from '../utils/logger';

export async function createNotification(
  userId: string,
  title: string,
  body: string,
  type: string
): Promise<void> {
  await prisma.notification.create({ data: { userId, title, body, type } });
}

export async function sendPushNotification(
  fcmToken: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  // FCM push via HTTP v1 API
  try {
    const { env } = await import('../config/env');
    if (!env.FCM_SERVER_KEY || env.FCM_SERVER_KEY === 'your-fcm-key') return;

    const axios = (await import('axios')).default;
    await axios.post(
      'https://fcm.googleapis.com/fcm/send',
      {
        to: fcmToken,
        notification: { title, body },
        data: data ?? {},
      },
      {
        headers: {
          Authorization: `key=${env.FCM_SERVER_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    logger.error('FCM push failed', { err });
  }
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

  await prisma.notification.createMany({
    data: userIds.map(userId => ({ userId, title, body, type })),
    skipDuplicates: true,
  }).catch(() => {});

  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, fcmToken: { not: null } },
    select: { fcmToken: true },
  });

  const tokens = users.map(u => u.fcmToken).filter(Boolean) as string[];
  if (tokens.length === 0) return;

  try {
    const admin = require('firebase-admin') as typeof import('firebase-admin');
    for (let i = 0; i < tokens.length; i += 500) {
      await admin.messaging().sendEachForMulticast({
        tokens: tokens.slice(i, i + 500),
        notification: { title, body },
        data: { type },
        android: { priority: 'high', notification: { sound: 'default', channelId: 'offerplay_main' } },
      });
    }
    logger.info(`sendBulkNotification: pushed to ${tokens.length} devices`);
  } catch (err) {
    logger.error('Bulk push failed:', err);
  }
}

export async function sendToAll(
  title: string,
  body: string,
  type: string
): Promise<void> {
  const users = await prisma.user.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, fcmToken: true },
    take: 10000,
  });

  // Write DB notifications in bulk via createMany
  await prisma.notification.createMany({
    data: users.map(u => ({ userId: u.id, title, body, type })),
    skipDuplicates: true,
  });

  // Best-effort FCM push to users who have a token
  const tokenUsers = users.filter(u => u.fcmToken);
  await Promise.allSettled(
    tokenUsers.map(u => sendPushNotification(u.fcmToken!, title, body, { type }))
  );

  logger.info(`sendToAll: notified ${users.length} users — type=${type}`);
}
