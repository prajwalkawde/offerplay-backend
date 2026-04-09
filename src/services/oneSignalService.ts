import axios from 'axios';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { env } from '../config/env';

// Push to specific users by their app user ID (requires OneSignal.login(userId) called from app)
export const sendOneSignalToUsers = async (
  userIds: string[],
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> => {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY) {
    logger.warn('[OneSignal] Not configured — skipping push');
    return;
  }
  if (!userIds.length) return;

  for (let i = 0; i < userIds.length; i += 2000) {
    const batch = userIds.slice(i, i + 2000);
    try {
      const res = await axios.post(
        'https://onesignal.com/api/v1/notifications',
        {
          app_id: env.ONESIGNAL_APP_ID,
          include_external_user_ids: batch,
          channel_for_external_user_ids: 'push',
          headings: { en: title },
          contents: { en: body },
          data: data ?? {},
          priority: 10,
        },
        {
          headers: {
            Authorization: `Key ${env.ONESIGNAL_REST_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );
      logger.info(`[OneSignal] Sent to ${res.data?.recipients ?? batch.length} recipient(s) via external IDs`);
    } catch (err: any) {
      logger.error('[OneSignal] Send failed:', err.response?.data ?? err.message);
    }
  }
};

// Legacy: push by stored player IDs
export const sendOneSignalNotification = async (
  playerIds: string[],
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> => {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY) return;
  if (!playerIds.length) return;

  try {
    await axios.post(
      'https://onesignal.com/api/v1/notifications',
      {
        app_id: env.ONESIGNAL_APP_ID,
        include_player_ids: playerIds,
        headings: { en: title },
        contents: { en: body },
        data: data ?? {},
      },
      {
        headers: {
          Authorization: `Key ${env.ONESIGNAL_REST_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    logger.info(`[OneSignal] Sent to ${playerIds.length} player(s) via player IDs`);
  } catch (err: any) {
    logger.error('[OneSignal] Send failed:', err.response?.data ?? err.message);
  }
};

export const sendDailyBonusReminders = async (): Promise<void> => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Find active users who haven't claimed today
    const users = await prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { userStreak: { is: null } },
          { userStreak: { lastClaimDate: null } },
          { userStreak: { lastClaimDate: { lt: today } } },
        ],
      },
      select: { id: true },
      take: 1000,
    });

    if (!users.length) {
      logger.info('[OneSignal] No eligible users for daily bonus reminder');
      return;
    }

    const userIds = users.map(u => u.id);
    await sendOneSignalToUsers(
      userIds,
      'Daily Bonus Available!',
      "Your daily bonus is ready to claim! Don't break your streak!",
      { type: 'daily_bonus', screen: 'DailyBonus' }
    );

    logger.info(`[OneSignal] Daily bonus reminder sent to ${userIds.length} users`);
  } catch (err) {
    logger.error('[OneSignal] Reminder job failed:', err);
  }
};
