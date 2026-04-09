import { Queue, Worker, Job } from 'bullmq';
import axios from 'axios';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ─── Redis connection (same pattern as coinQueue / notifQueue) ────────────────

function getRedisConnection() {
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

const connection = getRedisConnection();
const QUEUE_PREFIX = 'xyvmkurmut';
const QUEUE_NAME = 'super-offer-notifications';

// ─── Queue ────────────────────────────────────────────────────────────────────

export const superOfferNotifQueue = new Queue(QUEUE_NAME, {
  connection,
  prefix: QUEUE_PREFIX,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 10,
    removeOnFail: 50,
  },
});

// ─── OneSignal helper ─────────────────────────────────────────────────────────

const ONESIGNAL_API = 'https://onesignal.com/api/v1/notifications';

async function sendOneSignalNotification(uid: string, title: string, body: string): Promise<void> {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_API_KEY) {
    logger.warn('OneSignal credentials not configured — skipping notification');
    return;
  }

  try {
    await axios.post(
      ONESIGNAL_API,
      {
        app_id: env.ONESIGNAL_APP_ID,
        include_external_user_ids: [uid],
        headings: { en: title },
        contents: { en: body },
        data: { type: 'super_offer_ready' },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Key ${env.ONESIGNAL_REST_API_KEY}`,
        },
        timeout: 10000,
      }
    );

    logger.debug('OneSignal notification sent', { uid, title });
  } catch (err) {
    logger.error('OneSignal notification failed', { err, uid });
  }
}

// ─── Job handler ──────────────────────────────────────────────────────────────

async function runSuperOfferNotificationJob(): Promise<void> {
  const now = new Date();

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
    await sendOneSignalNotification(
      attempt.uid,
      'Super Offer Ready!',
      'Your Super Offer is back! Complete it to earn coins.'
    );
    await prisma.superOfferAttempt.update({
      where: { id: attempt.id },
      data: { notifCooldownSent: true },
    });
  }

  // ── 2. 6 HOURS REMAINING ──────────────────────────────────────────────────
  const sixHoursFromNow = new Date(now.getTime() + 6 * 60 * 60 * 1000);

  const notif6h = await prisma.superOfferAttempt.findMany({
    where: {
      status: 'completed',
      notif6hSent: false,
      notifCooldownSent: false,
      cooldownEndsAt: { gt: now, lte: sixHoursFromNow },
    },
    select: { id: true, uid: true },
  });

  for (const attempt of notif6h) {
    await sendOneSignalNotification(
      attempt.uid,
      'Super Offer in 6 Hours',
      'Your Super Offer unlocks soon. Get ready!'
    );
    await prisma.superOfferAttempt.update({
      where: { id: attempt.id },
      data: { notif6hSent: true },
    });
  }

  // ── 3. 12 HOURS REMAINING ─────────────────────────────────────────────────
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
    await sendOneSignalNotification(
      attempt.uid,
      'Super Offer Unlocking Soon',
      '12 hours until your next Super Offer. Stay tuned!'
    );
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
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export function startSuperOfferNotificationJob(): void {
  // Register repeatable job — BullMQ deduplicates by jobId so this is idempotent
  superOfferNotifQueue.add(
    'check-cooldowns',
    {},
    {
      repeat: { pattern: '*/5 * * * *' },
      jobId: 'super-offer-notif-recurring',
    }
  );

  const worker = new Worker<Record<string, never>>(
    QUEUE_NAME,
    async (_job: Job) => {
      await runSuperOfferNotificationJob();
    },
    { connection, prefix: QUEUE_PREFIX }
  );

  worker.on('failed', (job, err) => {
    logger.error('SuperOffer notification job failed', { jobId: job?.id, err });
  });

  logger.info('SuperOffer notification job scheduled (every 5 min)');
}
