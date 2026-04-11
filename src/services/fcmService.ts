import { admin } from '../config/firebase';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

/**
 * Send FCM push notification to specific users by their DB user IDs.
 * Looks up fcmToken from DB, batches 500 per request (FCM limit).
 */
export async function sendFCMToUsers(
  userIds: string[],
  title: string,
  body: string,
  data: Record<string, string> = {}
): Promise<void> {
  if (userIds.length === 0) return;

  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, fcmToken: { not: null } },
    select: { fcmToken: true },
  });

  const tokens = users.map(u => u.fcmToken!);
  if (tokens.length === 0) {
    logger.info(`[FCM] No tokens for ${userIds.length} user(s) — skipping`);
    return;
  }

  await sendFCMBatched(tokens, title, body, data);
}

/**
 * Send FCM push notification to ALL active users with an FCM token.
 */
export async function sendFCMToAll(
  title: string,
  body: string,
  data: Record<string, string> = {}
): Promise<void> {
  const users = await prisma.user.findMany({
    where: { status: 'ACTIVE', fcmToken: { not: null } },
    select: { fcmToken: true },
    take: 10000,
  });

  const tokens = users.map(u => u.fcmToken!);
  if (tokens.length === 0) return;

  await sendFCMBatched(tokens, title, body, data);
  logger.info(`[FCM] sendToAll complete — ${users.length} users`);
}

/**
 * Internal: send to a list of raw FCM tokens in batches of 500.
 * Cleans up invalid tokens from DB automatically.
 */
async function sendFCMBatched(
  tokens: string[],
  title: string,
  body: string,
  data: Record<string, string>
): Promise<void> {
  const messaging = admin.messaging();

  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    try {
      const response = await messaging.sendEachForMulticast({
        tokens: batch,
        notification: { title, body },
        data,
        android: {
          priority: 'high',
          notification: { channelId: 'default', sound: 'default' },
        },
      });

      const batchNum = Math.floor(i / 500) + 1;
      logger.info(`[FCM] Batch ${batchNum}: ${response.successCount}/${batch.length} sent`);

      // Remove invalid/expired tokens from DB
      const badTokens = response.responses
        .map((r, idx) => (!r.success ? batch[idx] : null))
        .filter(Boolean) as string[];

      if (badTokens.length > 0) {
        await prisma.user.updateMany({
          where: { fcmToken: { in: badTokens } },
          data: { fcmToken: null },
        });
        logger.info(`[FCM] Cleaned ${badTokens.length} invalid token(s)`);
      }
    } catch (err) {
      logger.error('[FCM] Batch send error:', err);
    }
  }
}

/**
 * Send daily bonus reminders to users who haven't claimed today.
 */
export async function sendDailyBonusReminders(isReset = false): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const users = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      fcmToken: { not: null },
      OR: [
        { userStreak: { is: null } },
        { userStreak: { lastClaimDate: null } },
        { userStreak: { lastClaimDate: { lt: today } } },
      ],
    },
    select: { fcmToken: true },
    take: 1000,
  });

  const tokens = users.map(u => u.fcmToken!);
  if (tokens.length === 0) {
    logger.info('[FCM] No eligible users for daily bonus reminder');
    return;
  }

  const title = isReset ? '🎁 Daily Bonus Reset!' : 'Daily Bonus Available! 🎁';
  const body  = isReset
    ? "A new day, a new bonus! Claim your daily reward and keep your streak alive! 🔥"
    : "Your daily bonus is ready to claim! Don't break your streak!";

  await sendFCMBatched(tokens, title, body, { type: 'daily_bonus', screen: 'DailyBonus' });

  logger.info(`[FCM] Daily bonus ${isReset ? 'reset' : 'reminder'} sent to ${tokens.length} users`);
}
