import { Queue, Worker, Job } from 'bullmq';
import { prisma } from '../config/database';
import { sendPushNotification, createNotification } from '../services/notificationService';
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

export const notifQueue = new Queue('notifications', {
  connection,
  prefix: 'xyvmkurmut',
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 50,
    removeOnFail: 200,
  },
});

export interface NotifJobData {
  userId: string;
  title: string;
  body: string;
  type: string;
  data?: Record<string, string>;
}

export function startNotifWorker(): Worker {
  const worker = new Worker<NotifJobData>(
    'notifications',
    async (job: Job<NotifJobData>) => {
      const { userId, title, body, type, data } = job.data;

      await createNotification(userId, title, body, type);

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { fcmToken: true },
      });

      if (user?.fcmToken) {
        await sendPushNotification(user.fcmToken, title, body, data);
      }

      logger.debug('Notification sent', { jobId: job.id, userId });
    },
    { connection, prefix: 'xyvmkurmut' }
  );

  worker.on('failed', (job, err) => {
    logger.error('Notif job failed', { jobId: job?.id, err });
  });

  return worker;
}

export async function enqueueNotification(data: NotifJobData): Promise<void> {
  await notifQueue.add('notify', data);
}
