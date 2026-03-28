"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifQueue = void 0;
exports.startNotifWorker = startNotifWorker;
exports.enqueueNotification = enqueueNotification;
const bullmq_1 = require("bullmq");
const database_1 = require("../config/database");
const notificationService_1 = require("../services/notificationService");
const logger_1 = require("../utils/logger");
const env_1 = require("../config/env");
function buildConnection() {
    const isTls = env_1.env.REDIS_URL.startsWith('rediss://');
    if (isTls) {
        const url = new URL(env_1.env.REDIS_URL);
        return {
            host: url.hostname,
            port: parseInt(url.port || '6379', 10),
            password: url.password || undefined,
            username: url.username || undefined,
            tls: { rejectUnauthorized: false },
        };
    }
    const url = new URL(env_1.env.REDIS_URL);
    return {
        host: url.hostname,
        port: parseInt(url.port || '6379', 10),
        password: url.password || undefined,
    };
}
const connection = buildConnection();
exports.notifQueue = new bullmq_1.Queue('notifications', {
    connection,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 50,
        removeOnFail: 200,
    },
});
function startNotifWorker() {
    const worker = new bullmq_1.Worker('notifications', async (job) => {
        const { userId, title, body, type, data } = job.data;
        await (0, notificationService_1.createNotification)(userId, title, body, type);
        const user = await database_1.prisma.user.findUnique({
            where: { id: userId },
            select: { fcmToken: true },
        });
        if (user?.fcmToken) {
            await (0, notificationService_1.sendPushNotification)(user.fcmToken, title, body, data);
        }
        logger_1.logger.debug('Notification sent', { jobId: job.id, userId });
    }, { connection });
    worker.on('failed', (job, err) => {
        logger_1.logger.error('Notif job failed', { jobId: job?.id, err });
    });
    return worker;
}
async function enqueueNotification(data) {
    await exports.notifQueue.add('notify', data);
}
