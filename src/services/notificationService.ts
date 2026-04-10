import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { sendFCMToUsers, sendFCMToAll } from './fcmService';

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
  await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true },
  });
}

export async function markNotificationRead(notificationId: string, userId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { isRead: true },
  });
}

/**
 * Send push + save in-app notification for a list of user IDs.
 */
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

  // 2. Push via FCM
  await sendFCMToUsers(userIds, title, body, { type });
}

/**
 * Send push + in-app notification to ALL active users.
 */
export async function sendToAll(
  title: string,
  body: string,
  type: string
): Promise<void> {
  const users = await prisma.user.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
    take: 10000,
  });

  // 1. Write DB notifications
  await prisma.notification.createMany({
    data: users.map(u => ({ userId: u.id, title, body, type })),
    skipDuplicates: true,
  });

  // 2. Push via FCM
  await sendFCMToAll(title, body, { type });

  logger.info(`[Notification] sendToAll: notified ${users.length} users — type=${type}`);
}

// Kept for queue compatibility — now uses FCM under the hood
export async function sendPushNotification(
  fcmToken: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> {
  if (!fcmToken) return;
  const { sendFCMToUsers: _ } = await import('./fcmService');
  // Find user by token and send
  const user = await prisma.user.findFirst({
    where: { fcmToken },
    select: { id: true },
  });
  if (user) await sendFCMToUsers([user.id], title, body, data);
}
