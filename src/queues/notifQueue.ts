import { Queue, Worker, Job } from 'bullmq';
import { prisma } from '../config/database';
import { sendPushNotification, createNotification } from '../services/notificationService';
import { logger } from '../utils/logger';
import { env } from '../config/env';

function buildConnection() {
  const isTls = env.REDIS_URL.startsWith('rediss://');
  if (isTls) {
    const url = new URL(env.REDIS_URL);
    return {
      host: url.hostname,
      port: parseInt(url.port || '6379', 10),
      password: url.password || undefined,
      username: url.username || undefined,
      tls: { rejectUnauthorized: false },
    };
  }
  const url = new URL(env.REDIS_URL);
  return {
    host: url.hostname,
    port: parseInt(url.port || '6379', 10),
    password: url.password || undefined,
  };
}

const connection = buildConnection();

export const notifQueue = new Queue('notifications', {
  connection,
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
    { connection }
  );

  worker.on('failed', (job, err) => {
    logger.error('Notif job failed', { jobId: job?.id, err });
  });

  return worker;
}

export async function enqueueNotification(data: NotifJobData): Promise<void> {
  await notifQueue.add('notify', data);
}
