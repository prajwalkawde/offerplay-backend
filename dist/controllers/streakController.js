"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStreakStats = exports.updateStreakConfig = exports.getStreakConfig = exports.claimDailyStreak = exports.getStreakData = void 0;
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const logger_1 = require("../utils/logger");
const client_1 = require("@prisma/client");
const ticketService_1 = require("../services/ticketService");
// ─── GET /api/earn/daily-streak ───────────────────────────────────────────────
const getStreakData = async (req, res) => {
    try {
        const userId = req.userId;
        let streak = await database_1.prisma.userStreak.findUnique({ where: { userId } });
        if (!streak) {
            streak = await database_1.prisma.userStreak.create({ data: { userId } });
        }
        const config = await database_1.prisma.dailyStreakConfig.findMany({ orderBy: { day: 'asc' } });
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        let canClaimToday = true;
        let isStreakBroken = false;
        if (streak.lastClaimDate) {
            const lastClaimDay = new Date(streak.lastClaimDate);
            lastClaimDay.setHours(0, 0, 0, 0);
            const daysDiff = Math.floor((today.getTime() - lastClaimDay.getTime()) / 86400000);
            if (daysDiff === 0) {
                canClaimToday = false;
            }
            else if (daysDiff > 1) {
                isStreakBroken = true;
            }
        }
        const currentStreak = isStreakBroken ? 0 : streak.currentStreak;
        const currentDay = ((currentStreak % 7) || (currentStreak === 0 ? 1 : 7));
        const todayConfig = config.find((c) => c.day === currentDay) ?? config[0];
        let nextClaimAt = null;
        if (!canClaimToday && streak.lastClaimDate) {
            nextClaimAt = new Date(streak.lastClaimDate);
            nextClaimAt.setDate(nextClaimAt.getDate() + 1);
            nextClaimAt.setHours(0, 0, 0, 0);
        }
        (0, response_1.success)(res, {
            currentStreak,
            longestStreak: streak.longestStreak,
            lastClaimDate: streak.lastClaimDate,
            totalDaysClaimed: streak.totalDaysClaimed,
            totalCoinsEarned: streak.totalCoinsFromStreak,
            canClaimToday,
            isStreakBroken,
            currentDay,
            nextClaimAt,
            todayReward: todayConfig?.coins ?? 10,
            todayIcon: todayConfig?.icon ?? '🪙',
            isSpecialDay: todayConfig?.isSpecial ?? false,
            config,
        });
    }
    catch (err) {
        logger_1.logger.error('getStreakData error:', err);
        (0, response_1.error)(res, 'Failed to get streak data', 500);
    }
};
exports.getStreakData = getStreakData;
// ─── POST /api/earn/daily-streak/claim ───────────────────────────────────────
const claimDailyStreak = async (req, res) => {
    try {
        const userId = req.userId;
        let streak = await database_1.prisma.userStreak.findUnique({ where: { userId } });
        if (!streak) {
            streak = await database_1.prisma.userStreak.create({ data: { userId } });
        }
        const now = new Date();
        const today = new Date(now);
        today.setHours(0, 0, 0, 0);
        if (streak.lastClaimDate) {
            const lastClaimDay = new Date(streak.lastClaimDate);
            lastClaimDay.setHours(0, 0, 0, 0);
            const daysDiff = Math.floor((today.getTime() - lastClaimDay.getTime()) / 86400000);
            if (daysDiff === 0) {
                (0, response_1.error)(res, 'Already claimed today! Come back tomorrow 🌅', 400);
                return;
            }
            if (daysDiff > 1) {
                // Streak broken — reset before incrementing
                streak = await database_1.prisma.userStreak.update({
                    where: { userId },
                    data: { currentStreak: 0 },
                });
            }
        }
        const newStreak = streak.currentStreak + 1;
        const dayInCycle = ((newStreak - 1) % 7) + 1;
        const config = await database_1.prisma.dailyStreakConfig.findUnique({ where: { day: dayInCycle } });
        const coinsToAward = config?.coins ?? 10;
        const isSpecial = config?.isSpecial ?? false;
        await database_1.prisma.$transaction([
            database_1.prisma.userStreak.update({
                where: { userId },
                data: {
                    currentStreak: newStreak,
                    longestStreak: Math.max(streak.longestStreak, newStreak),
                    lastClaimDate: now,
                    totalDaysClaimed: { increment: 1 },
                    totalCoinsFromStreak: { increment: coinsToAward },
                },
            }),
            database_1.prisma.user.update({
                where: { id: userId },
                data: { coinBalance: { increment: coinsToAward } },
            }),
            database_1.prisma.transaction.create({
                data: {
                    userId,
                    type: client_1.TransactionType.EARN_STREAK,
                    amount: coinsToAward,
                    description: `Day ${dayInCycle} streak bonus${isSpecial ? ' 👑 SPECIAL!' : ''}`,
                    status: 'completed',
                },
            }),
        ]);
        const ticketsToAward = Math.ceil(coinsToAward / 50);
        let newTicketBalance = 0;
        try {
            newTicketBalance = await (0, ticketService_1.creditTickets)(userId, ticketsToAward, `Daily bonus day ${dayInCycle} tickets`, `daily_bonus_${userId}_${today.toISOString().slice(0, 10)}`);
        }
        catch { /* non-critical */ }
        try {
            await database_1.prisma.notification.create({
                data: {
                    userId,
                    title: isSpecial ? '👑 SPECIAL Day 7 Bonus!' : `🔥 Day ${newStreak} Streak!`,
                    body: `+${coinsToAward} coins added to your wallet!`,
                    type: 'DAILY_STREAK',
                },
            });
        }
        catch { /* non-critical */ }
        (0, response_1.success)(res, {
            coinsAwarded: coinsToAward,
            ticketsEarned: ticketsToAward,
            ticketBalance: newTicketBalance,
            newStreak,
            dayInCycle,
            isSpecial,
            message: isSpecial
                ? `🎉 Special Day 7 Bonus! +${coinsToAward} coins!`
                : `+${coinsToAward} coins added! Day ${newStreak} streak! 🔥`,
        }, isSpecial ? '👑 SPECIAL bonus claimed!' : '🎉 Daily bonus claimed!');
    }
    catch (err) {
        logger_1.logger.error('claimDailyStreak error:', err);
        (0, response_1.error)(res, 'Failed to claim', 500);
    }
};
exports.claimDailyStreak = claimDailyStreak;
// ─── Admin: GET /api/admin/streak-config ─────────────────────────────────────
const getStreakConfig = async (_req, res) => {
    try {
        let config = await database_1.prisma.dailyStreakConfig.findMany({ orderBy: { day: 'asc' } });
        if (config.length === 0) {
            const defaults = [
                { day: 1, coins: 10, label: 'Day 1', icon: '🪙', isSpecial: false },
                { day: 2, coins: 15, label: 'Day 2', icon: '🪙', isSpecial: false },
                { day: 3, coins: 20, label: 'Day 3', icon: '💫', isSpecial: false },
                { day: 4, coins: 25, label: 'Day 4', icon: '⭐', isSpecial: false },
                { day: 5, coins: 30, label: 'Day 5', icon: '🌟', isSpecial: false },
                { day: 6, coins: 35, label: 'Day 6', icon: '✨', isSpecial: false },
                { day: 7, coins: 100, label: 'Day 7 🎉', icon: '👑', isSpecial: true },
            ];
            for (const d of defaults) {
                await database_1.prisma.dailyStreakConfig.upsert({
                    where: { day: d.day },
                    update: {},
                    create: d,
                });
            }
            config = await database_1.prisma.dailyStreakConfig.findMany({ orderBy: { day: 'asc' } });
        }
        (0, response_1.success)(res, config);
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to get streak config', 500);
    }
};
exports.getStreakConfig = getStreakConfig;
// ─── Admin: PUT /api/admin/streak-config/:day ─────────────────────────────────
const updateStreakConfig = async (req, res) => {
    try {
        const day = parseInt(req.params.day, 10);
        const { coins, label, icon, isSpecial } = req.body;
        const updated = await database_1.prisma.dailyStreakConfig.update({
            where: { day },
            data: { coins: Number(coins), label, icon, isSpecial: isSpecial === true },
        });
        (0, response_1.success)(res, updated, 'Day updated!');
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to update streak config', 500);
    }
};
exports.updateStreakConfig = updateStreakConfig;
// ─── Admin: GET /api/admin/streak-stats ──────────────────────────────────────
const getStreakStats = async (_req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const [totalClaimsToday, coinsToday, usersOnStreak, avgStreak] = await Promise.all([
            database_1.prisma.transaction.count({
                where: { type: client_1.TransactionType.EARN_STREAK, createdAt: { gte: today } },
            }),
            database_1.prisma.transaction.aggregate({
                where: { type: client_1.TransactionType.EARN_STREAK, createdAt: { gte: today } },
                _sum: { amount: true },
            }),
            database_1.prisma.userStreak.count({ where: { currentStreak: { gt: 0 } } }),
            database_1.prisma.userStreak.aggregate({ _avg: { currentStreak: true } }),
        ]);
        (0, response_1.success)(res, {
            totalClaimsToday,
            totalCoinsToday: coinsToday._sum.amount ?? 0,
            usersOnStreak,
            avgStreak: Math.round(avgStreak._avg.currentStreak ?? 0),
        });
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to get streak stats', 500);
    }
};
exports.getStreakStats = getStreakStats;
