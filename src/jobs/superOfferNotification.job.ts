import cron from 'node-cron';
import axios from 'axios';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const ONESIGNAL_API = 'https://onesignal.com/api/v1/notifications';

interface NotifPayload {
  uid: string;
  title: string;
  body: string;
}

async function sendOneSignalNotification(payload: NotifPayload): Promise<void> {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY) {
    logger.warn('OneSignal credentials not configured — skipping notification');
    return;
  }

  try {
    await axios.post(
      ONESIGNAL_API,
      {
        app_id: env.ONESIGNAL_APP_ID,
        filters: [{ field: 'tag', key: 'uid', relation: '=', value: payload.uid }],
        headings: { en: payload.title },
        contents: { en: payload.body },
        data: { type: 'super_offer_ready' },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${env.ONESIGNAL_REST_API_KEY}`,
        },
        timeout: 10000,
      }
    );

    logger.debug('OneSignal notification sent', { uid: payload.uid, title: payload.title });
  } catch (err) {
    logger.error('OneSignal notification failed', { err, uid: payload.uid });
  }
}

async function runSuperOfferNotificationJob(): Promise<void> {
  const now = new Date();

  try {
    // ── 1. COOLDOWN ENDED — notify user Super Offer is ready ──────────────────
    const cooldownEnded = await prisma.superOfferAttempt.findMany({
      where: {
        status: 'completed',
        notifCooldownSent: false,
        cooldownEndsAt: { lte: now },
      },
      select: { id: true, uid: true },
    });

    for (const attempt of cooldownEnded) {
      await sendOneSignalNotification({
        uid: attempt.uid,
        title: 'Super Offer Ready!',
        body: 'Your Super Offer is back! Complete it to earn coins.',
      });

      await prisma.superOfferAttempt.update({
        where: { id: attempt.id },
        data: { notifCooldownSent: true },
      });
    }

    // ── 2. 6 HOURS REMAINING ─────────────────────────────────────────────────
    const sixHoursFromNow = new Date(now.getTime() + 6 * 60 * 60 * 1000);

    const notif6h = await prisma.superOfferAttempt.findMany({
      where: {
        status: 'completed',
        notif6hSent: false,
        notifCooldownSent: false, // cooldown hasn't ended yet
        cooldownEndsAt: { gt: now, lte: sixHoursFromNow },
      },
      select: { id: true, uid: true },
    });

    for (const attempt of notif6h) {
      await sendOneSignalNotification({
        uid: attempt.uid,
        title: 'Super Offer in 6 Hours',
        body: 'Your Super Offer unlocks soon. Get ready!',
      });

      await prisma.superOfferAttempt.update({
        where: { id: attempt.id },
        data: { notif6hSent: true },
      });
    }

    // ── 3. 12 HOURS REMAINING ────────────────────────────────────────────────
    const twelveHoursFromNow = new Date(now.getTime() + 12 * 60 * 60 * 1000);

    const notif12h = await prisma.superOfferAttempt.findMany({
      where: {
        status: 'completed',
        notif12hSent: false,
        notif6hSent: false,
        cooldownEndsAt: { gt: sixHoursFromNow, lte: twelveHoursFromNow },
      },
      select: { id: true, uid: true },
    });

    for (const attempt of notif12h) {
      await sendOneSignalNotification({
        uid: attempt.uid,
        title: 'Super Offer Unlocking Soon',
        body: '12 hours until your next Super Offer. Stay tuned!',
      });

      await prisma.superOfferAttempt.update({
        where: { id: attempt.id },
        data: { notif12hSent: true },
      });
    }

    const totalProcessed = cooldownEnded.length + notif6h.length + notif12h.length;
    if (totalProcessed > 0) {
      logger.info('SuperOffer notification job done', {
        cooldownEnded: cooldownEnded.length,
        notif6h: notif6h.length,
        notif12h: notif12h.length,
      });
    }
  } catch (err) {
    logger.error('SuperOffer notification job error', { err });
  }
}

export function startSuperOfferNotificationJob(): void {
  // Runs every 5 minutes
  cron.schedule('*/5 * * * *', runSuperOfferNotificationJob, { timezone: 'Asia/Kolkata' });
  logger.info('SuperOffer notification job scheduled (every 5 min)');
}
