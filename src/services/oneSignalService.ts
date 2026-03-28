import axios from 'axios';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export const sendOneSignalNotification = async (
  playerIds: string[],
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<void> => {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY) {
    logger.warn('[OneSignal] Not configured — skipping push');
    return;
  }
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
        android_channel_id: 'offerplay_main',
        android_accent_color: 'FF7B2FBE',
        small_icon: 'ic_notification',
      },
      {
        headers: {
          Authorization: `Basic ${env.ONESIGNAL_REST_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    logger.info(`[OneSignal] Sent to ${playerIds.length} player(s)`);
  } catch (err: any) {
    logger.error('[OneSignal] Send failed:', err.response?.data ?? err.message);
  }
};

export const sendDailyBonusReminders = async (): Promise<void> => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Find active users with a OneSignal player ID who haven't claimed today
    const users = await prisma.user.findMany({
      where: {
        oneSignalPlayerId: { not: null },
        status: 'ACTIVE',
        OR: [
          { userStreak: { is: null } },
          { userStreak: { lastClaimDate: null } },
          { userStreak: { lastClaimDate: { lt: today } } },
        ],
      },
      select: { oneSignalPlayerId: true },
      take: 1000,
    });

    const playerIds = users
      .map((u) => u.oneSignalPlayerId)
      .filter(Boolean) as string[];

    if (!playerIds.length) {
      logger.info('[OneSignal] No eligible users for daily bonus reminder');
      return;
    }

    await sendOneSignalNotification(
      playerIds,
      'Daily Bonus Available!',
      "Your daily bonus is ready to claim! Don't break your streak!",
      { type: 'daily_bonus', screen: 'DailyBonus' }
    );

    logger.info(`[OneSignal] Daily bonus reminder sent to ${playerIds.length} users`);
  } catch (err) {
    logger.error('[OneSignal] Reminder job failed:', err);
  }
};
