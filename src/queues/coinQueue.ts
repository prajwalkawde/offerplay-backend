import { Queue, Worker, Job } from 'bullmq';
import cron from 'node-cron';
import { creditCoins } from '../services/coinService';
import { TransactionType } from '@prisma/client';
import { logger } from '../utils/logger';

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

export const coinQueue = new Queue('coin-operations', {
  connection,
  prefix: 'xyvmkurmut',
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

export interface CoinJobData {
  userId: string;
  amount: number;
  type: TransactionType;
  refId?: string;
  description?: string;
}

export function startCoinWorker(): Worker {
  const worker = new Worker<CoinJobData>(
    'coin-operations',
    async (job: Job<CoinJobData>) => {
      const { userId, amount, type, refId, description } = job.data;
      await creditCoins(userId, amount, type, refId, description);
      logger.debug('Coin job processed', { jobId: job.id, userId, amount });
    },
    { connection, prefix: 'xyvmkurmut' }
  );

  worker.on('failed', (job, err) => {
    logger.error('Coin job failed', { jobId: job?.id, err });
  });

  return worker;
}

export async function enqueueCoinCredit(data: CoinJobData): Promise<void> {
  await coinQueue.add('credit', data);
}

// ─── Postback Retry Scheduler (every 5 minutes) ───────────────────────────────
export function schedulePostbackRetry(): void {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { processRetryQueue } = await import('../services/postbackService');
      await processRetryQueue();
    } catch (err) {
      logger.error('Postback retry job failed:', { message: (err as Error).message });
    }
  });
  logger.info('Postback retry queue scheduler started (every 5 min)');
}
