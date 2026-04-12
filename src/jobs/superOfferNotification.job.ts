import { Queue, Worker, Job } from 'bullmq';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { sendFCMToUsers } from '../services/fcmService';

// ─── Redis connection ─────────────────────────────────────────────────────────

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

const TERMINAL_STATUSES = ['completed', 'failed'];

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rewardLabel(coinReward: number, rewardType: string): string {
  return rewardType === 'TICKETS' ? `${coinReward} 🎟️ tickets` : `${coinReward} 🪙 coins`;
}

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

// ─── Job handler ──────────────────────────────────────────────────────────────

async function runSuperOfferNotificationJob(): Promise<void> {
  let total = 0;

  // ── 6h — first nudge ──────────────────────────────────────────────────────
  const due6h = await prisma.superOfferAttempt.findMany({
    where: {
      status: { notIn: TERMINAL_STATUSES },
      notif6hSent: false,
      startedAt: { lte: hoursAgo(6) },
    },
    select: { id: true, uid: true, coinReward: true, rewardType: true },
  });

  for (const a of due6h) {
    await sendFCMToUsers(
      [a.uid],
      '⚡ Your Super Offer is Waiting!',
      `Complete your Super Offer and earn ${rewardLabel(a.coinReward, a.rewardType)} now!`,
      { type: 'super_offer_reminder' }
    );
    await prisma.superOfferAttempt.update({ where: { id: a.id }, data: { notif6hSent: true } });
  }
  total += due6h.length;

  // ── 12h — second nudge ────────────────────────────────────────────────────
  const due12h = await prisma.superOfferAttempt.findMany({
    where: {
      status: { notIn: TERMINAL_STATUSES },
      notif6hSent: true,
      notif12hSent: false,
      startedAt: { lte: hoursAgo(12) },
    },
    select: { id: true, uid: true, coinReward: true, rewardType: true },
  });

  for (const a of due12h) {
    await sendFCMToUsers(
      [a.uid],
      '🔔 Super Offer Still Waiting!',
      `You started a Super Offer 12 hours ago. Earn ${rewardLabel(a.coinReward, a.rewardType)} — don't leave it incomplete!`,
      { type: 'super_offer_reminder' }
    );
    await prisma.superOfferAttempt.update({ where: { id: a.id }, data: { notif12hSent: true } });
  }
  total += due12h.length;

  // ── 24h — third nudge ─────────────────────────────────────────────────────
  const due24h = await prisma.superOfferAttempt.findMany({
    where: {
      status: { notIn: TERMINAL_STATUSES },
      notif12hSent: true,
      notif24hSent: false,
      startedAt: { lte: hoursAgo(24) },
    },
    select: { id: true, uid: true, coinReward: true, rewardType: true },
  });

  for (const a of due24h) {
    await sendFCMToUsers(
      [a.uid],
      '⏰ 1 Day — Super Offer Unclaimed!',
      `Your Super Offer has been waiting 24 hours. Claim ${rewardLabel(a.coinReward, a.rewardType)} before it's too late!`,
      { type: 'super_offer_reminder' }
    );
    await prisma.superOfferAttempt.update({ where: { id: a.id }, data: { notif24hSent: true } });
  }
  total += due24h.length;

  // ── 48h — final nudge ─────────────────────────────────────────────────────
  const due48h = await prisma.superOfferAttempt.findMany({
    where: {
      status: { notIn: TERMINAL_STATUSES },
      notif24hSent: true,
      notif48hSent: false,
      startedAt: { lte: hoursAgo(48) },
    },
    select: { id: true, uid: true, coinReward: true, rewardType: true },
  });

  for (const a of due48h) {
    await sendFCMToUsers(
      [a.uid],
      '🚨 Last Reminder — Super Offer Waiting!',
      `You still have ${rewardLabel(a.coinReward, a.rewardType)} waiting in your Super Offer. Complete it now!`,
      { type: 'super_offer_reminder' }
    );
    await prisma.superOfferAttempt.update({ where: { id: a.id }, data: { notif48hSent: true } });
  }
  total += due48h.length;

  if (total > 0) {
    logger.info('SuperOffer reminder job done', {
      notif6h: due6h.length,
      notif12h: due12h.length,
      notif24h: due24h.length,
      notif48h: due48h.length,
    });
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────

export function startSuperOfferNotificationJob(): void {
  superOfferNotifQueue.add(
    'check-incomplete',
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
