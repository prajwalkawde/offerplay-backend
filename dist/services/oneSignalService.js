"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendDailyBonusReminders = exports.sendOneSignalNotification = void 0;
const axios_1 = __importDefault(require("axios"));
const database_1 = require("../config/database");
const logger_1 = require("../utils/logger");
const env_1 = require("../config/env");
const sendOneSignalNotification = async (playerIds, title, body, data) => {
    if (!env_1.env.ONESIGNAL_APP_ID || !env_1.env.ONESIGNAL_REST_API_KEY) {
        logger_1.logger.warn('[OneSignal] Not configured — skipping push');
        return;
    }
    if (!playerIds.length)
        return;
    try {
        await axios_1.default.post('https://onesignal.com/api/v1/notifications', {
            app_id: env_1.env.ONESIGNAL_APP_ID,
            include_player_ids: playerIds,
            headings: { en: title },
            contents: { en: body },
            data: data ?? {},
            android_channel_id: 'offerplay_main',
            android_accent_color: 'FF7B2FBE',
            small_icon: 'ic_notification',
        }, {
            headers: {
                Authorization: `Basic ${env_1.env.ONESIGNAL_REST_API_KEY}`,
                'Content-Type': 'application/json',
            },
        });
        logger_1.logger.info(`[OneSignal] Sent to ${playerIds.length} player(s)`);
    }
    catch (err) {
        logger_1.logger.error('[OneSignal] Send failed:', err.response?.data ?? err.message);
    }
};
exports.sendOneSignalNotification = sendOneSignalNotification;
const sendDailyBonusReminders = async () => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        // Find active users with a OneSignal player ID who haven't claimed today
        const users = await database_1.prisma.user.findMany({
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
            .filter(Boolean);
        if (!playerIds.length) {
            logger_1.logger.info('[OneSignal] No eligible users for daily bonus reminder');
            return;
        }
        await (0, exports.sendOneSignalNotification)(playerIds, 'Daily Bonus Available!', "Your daily bonus is ready to claim! Don't break your streak!", { type: 'daily_bonus', screen: 'DailyBonus' });
        logger_1.logger.info(`[OneSignal] Daily bonus reminder sent to ${playerIds.length} users`);
    }
    catch (err) {
        logger_1.logger.error('[OneSignal] Reminder job failed:', err);
    }
};
exports.sendDailyBonusReminders = sendDailyBonusReminders;
