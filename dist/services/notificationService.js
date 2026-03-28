"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createNotification = createNotification;
exports.sendPushNotification = sendPushNotification;
exports.getUserNotifications = getUserNotifications;
exports.markAllRead = markAllRead;
exports.markNotificationRead = markNotificationRead;
exports.sendBulkNotification = sendBulkNotification;
exports.sendToAll = sendToAll;
const database_1 = require("../config/database");
const logger_1 = require("../utils/logger");
async function createNotification(userId, title, body, type) {
    await database_1.prisma.notification.create({ data: { userId, title, body, type } });
}
async function sendPushNotification(fcmToken, title, body, data) {
    // FCM push via HTTP v1 API
    try {
        const { env } = await Promise.resolve().then(() => __importStar(require('../config/env')));
        if (!env.FCM_SERVER_KEY || env.FCM_SERVER_KEY === 'your-fcm-key')
            return;
        const axios = (await Promise.resolve().then(() => __importStar(require('axios')))).default;
        await axios.post('https://fcm.googleapis.com/fcm/send', {
            to: fcmToken,
            notification: { title, body },
            data: data ?? {},
        }, {
            headers: {
                Authorization: `key=${env.FCM_SERVER_KEY}`,
                'Content-Type': 'application/json',
            },
        });
    }
    catch (err) {
        logger_1.logger.error('FCM push failed', { err });
    }
}
async function getUserNotifications(userId, limit = 20, page = 1) {
    const skip = (page - 1) * limit;
    const [notifications, unreadCount] = await Promise.all([
        database_1.prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        database_1.prisma.notification.count({ where: { userId, isRead: false } }),
    ]);
    return { notifications, unreadCount };
}
async function markAllRead(userId) {
    await database_1.prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
}
async function markNotificationRead(notificationId, userId) {
    await database_1.prisma.notification.updateMany({
        where: { id: notificationId, userId },
        data: { isRead: true },
    });
}
async function sendBulkNotification(userIds, title, body, type = 'GENERAL') {
    if (userIds.length === 0)
        return;
    await database_1.prisma.notification.createMany({
        data: userIds.map(userId => ({ userId, title, body, type })),
        skipDuplicates: true,
    }).catch(() => { });
    const users = await database_1.prisma.user.findMany({
        where: { id: { in: userIds }, fcmToken: { not: null } },
        select: { fcmToken: true },
    });
    const tokens = users.map(u => u.fcmToken).filter(Boolean);
    if (tokens.length === 0)
        return;
    try {
        const admin = require('firebase-admin');
        for (let i = 0; i < tokens.length; i += 500) {
            await admin.messaging().sendEachForMulticast({
                tokens: tokens.slice(i, i + 500),
                notification: { title, body },
                data: { type },
                android: { priority: 'high', notification: { sound: 'default', channelId: 'offerplay_main' } },
            });
        }
        logger_1.logger.info(`sendBulkNotification: pushed to ${tokens.length} devices`);
    }
    catch (err) {
        logger_1.logger.error('Bulk push failed:', err);
    }
}
async function sendToAll(title, body, type) {
    const users = await database_1.prisma.user.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, fcmToken: true },
        take: 10000,
    });
    // Write DB notifications in bulk via createMany
    await database_1.prisma.notification.createMany({
        data: users.map(u => ({ userId: u.id, title, body, type })),
        skipDuplicates: true,
    });
    // Best-effort FCM push to users who have a token
    const tokenUsers = users.filter(u => u.fcmToken);
    await Promise.allSettled(tokenUsers.map(u => sendPushNotification(u.fcmToken, title, body, { type })));
    logger_1.logger.info(`sendToAll: notified ${users.length} users — type=${type}`);
}
