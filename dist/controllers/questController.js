"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminDeleteQuest = exports.adminUpdateQuest = exports.adminCreateQuest = exports.adminListQuests = exports.updateQuestProgress = exports.claimQuestReward = exports.getQuests = void 0;
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const logger_1 = require("../utils/logger");
const client_1 = require("@prisma/client");
// GET /api/quests
const getQuests = async (req, res) => {
    try {
        const userId = req.user.id;
        const now = new Date();
        const quests = await database_1.prisma.quest.findMany({
            where: { isActive: true },
            orderBy: [{ questType: 'asc' }, { sortOrder: 'asc' }],
        });
        const completions = await database_1.prisma.questCompletion.findMany({ where: { userId } });
        const completionMap = new Map(completions.map(c => [c.questId, c]));
        const streak = await database_1.prisma.dailyQuestStreak.findUnique({ where: { userId } });
        const enriched = quests.map(quest => {
            const completion = completionMap.get(quest.id);
            let isReset = false;
            if (completion && quest.resetType === 'DAILY') {
                const dayStart = new Date(now);
                dayStart.setHours(0, 0, 0, 0);
                isReset = new Date(completion.resetAt || completion.createdAt) < dayStart;
            }
            if (completion && quest.resetType === 'WEEKLY') {
                const weekAgo = new Date(now);
                weekAgo.setDate(weekAgo.getDate() - 7);
                isReset = new Date(completion.resetAt || completion.createdAt) < weekAgo;
            }
            const progress = isReset ? 0 : (completion?.progress || 0);
            const isCompleted = isReset ? false : (completion?.isCompleted || false);
            const isClaimed = isReset ? false : (completion?.isClaimed || false);
            return {
                id: quest.id,
                title: quest.title,
                description: quest.description,
                questType: quest.questType,
                category: quest.category,
                icon: quest.icon,
                requirementType: quest.requirementType,
                requirementCount: quest.requirementCount,
                rewardTickets: quest.rewardTickets,
                rewardCoins: quest.rewardCoins,
                difficulty: quest.difficulty,
                isPartOfDailySet: quest.isPartOfDailySet,
                isFeatured: quest.isFeatured,
                progress,
                isCompleted,
                isClaimed,
                progressPct: Math.min((progress / quest.requirementCount) * 100, 100),
                canClaim: isCompleted && !isClaimed,
            };
        });
        const dailyQuests = enriched.filter(q => q.questType === 'DAILY' && q.isPartOfDailySet);
        const dailyCompleted = dailyQuests.filter(q => q.isCompleted).length;
        const allDailyDone = dailyCompleted === dailyQuests.length && dailyQuests.length > 0;
        const totalTicketsAvailable = enriched
            .filter(q => !q.isClaimed && q.isCompleted)
            .reduce((s, q) => s + q.rewardTickets, 0);
        return (0, response_1.success)(res, {
            quests: enriched,
            streak: streak?.currentStreak || 0,
            dailyProgress: {
                completed: dailyCompleted,
                total: dailyQuests.length,
                allDone: allDailyDone,
                bonusTickets: allDailyDone ? 5 : 0,
            },
            totalClaimable: totalTicketsAvailable,
        });
    }
    catch (err) {
        logger_1.logger.error('getQuests error:', err);
        return (0, response_1.error)(res, 'Failed', 500);
    }
};
exports.getQuests = getQuests;
// POST /api/quests/:id/claim
const claimQuestReward = async (req, res) => {
    try {
        const userId = req.user.id;
        const questId = req.params.id;
        const quest = await database_1.prisma.quest.findUnique({ where: { id: questId } });
        if (!quest)
            return (0, response_1.error)(res, 'Quest not found', 404);
        const completion = await database_1.prisma.questCompletion.findUnique({
            where: { userId_questId: { userId, questId } },
        });
        if (!completion?.isCompleted)
            return (0, response_1.error)(res, 'Quest not completed yet!', 400);
        if (completion?.isClaimed)
            return (0, response_1.error)(res, 'Already claimed!', 400);
        await database_1.prisma.$transaction(async (tx) => {
            await tx.questCompletion.update({
                where: { userId_questId: { userId, questId } },
                data: { isClaimed: true, claimedAt: new Date() },
            });
            if (quest.rewardTickets > 0) {
                await tx.user.update({
                    where: { id: userId },
                    data: { ticketBalance: { increment: quest.rewardTickets } },
                });
                await tx.ticketTransaction.create({
                    data: {
                        userId,
                        amount: quest.rewardTickets,
                        type: 'EARN_TICKET',
                        refId: questId,
                        description: `Quest: ${quest.title}`,
                    },
                }).catch(() => { });
            }
            if (quest.rewardCoins > 0) {
                await tx.user.update({
                    where: { id: userId },
                    data: { coinBalance: { increment: quest.rewardCoins } },
                });
                await tx.transaction.create({
                    data: {
                        userId,
                        type: client_1.TransactionType.QUEST_REWARD,
                        amount: quest.rewardCoins,
                        description: `Quest reward: ${quest.title}`,
                        status: 'completed',
                        refId: questId,
                    },
                });
            }
        });
        if (quest.isPartOfDailySet) {
            await checkDailyQuestBonus(userId);
        }
        const updatedUser = await database_1.prisma.user.findUnique({
            where: { id: userId },
            select: { ticketBalance: true, coinBalance: true },
        });
        logger_1.logger.info(`Quest claimed: ${quest.title} by ${userId} ` +
            `+${quest.rewardTickets} tickets +${quest.rewardCoins} coins`);
        return (0, response_1.success)(res, {
            questTitle: quest.title,
            ticketsEarned: quest.rewardTickets,
            coinsEarned: quest.rewardCoins,
            newTicketBalance: updatedUser?.ticketBalance ?? 0,
            newCoinBalance: updatedUser?.coinBalance ?? 0,
        }, '🎉 Reward claimed!');
    }
    catch (err) {
        logger_1.logger.error('claimQuestReward error:', err);
        return (0, response_1.error)(res, 'Failed', 500);
    }
};
exports.claimQuestReward = claimQuestReward;
// Called internally to update quest progress from postbacks / adjoe
const updateQuestProgress = async (userId, requirementType, incrementBy = 1) => {
    try {
        const now = new Date();
        const startOfDay = new Date(now);
        startOfDay.setHours(0, 0, 0, 0);
        const startOfWeek = new Date(now);
        startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
        startOfWeek.setHours(0, 0, 0, 0);
        const quests = await database_1.prisma.quest.findMany({
            where: { requirementType, isActive: true },
        });
        for (const quest of quests) {
            const existing = await database_1.prisma.questCompletion.findUnique({
                where: { userId_questId: { userId, questId: quest.id } },
            });
            if (quest.resetType === 'ONCE' && existing?.isCompleted)
                continue;
            let needsReset = false;
            if (existing) {
                const lastReset = new Date(existing.resetAt || existing.createdAt);
                if (quest.resetType === 'DAILY')
                    needsReset = lastReset < startOfDay;
                if (quest.resetType === 'WEEKLY')
                    needsReset = lastReset < startOfWeek;
            }
            const currentProgress = needsReset ? 0 : (existing?.progress || 0);
            const newProgress = Math.min(currentProgress + incrementBy, quest.requirementCount);
            const isNowCompleted = newProgress >= quest.requirementCount;
            await database_1.prisma.questCompletion.upsert({
                where: { userId_questId: { userId, questId: quest.id } },
                update: {
                    progress: newProgress,
                    isCompleted: isNowCompleted,
                    completedAt: isNowCompleted && !existing?.isCompleted ? new Date() : existing?.completedAt,
                    isClaimed: needsReset ? false : existing?.isClaimed,
                    resetAt: needsReset ? new Date() : undefined,
                },
                create: {
                    userId,
                    questId: quest.id,
                    progress: newProgress,
                    isCompleted: isNowCompleted,
                    completedAt: isNowCompleted ? new Date() : null,
                    resetAt: new Date(),
                },
            });
            if (isNowCompleted && !existing?.isCompleted) {
                logger_1.logger.info(`Quest completed: ${quest.title} by ${userId}`);
            }
        }
    }
    catch (err) {
        logger_1.logger.error('updateQuestProgress error:', err);
    }
};
exports.updateQuestProgress = updateQuestProgress;
async function checkDailyQuestBonus(userId) {
    const dailyQuests = await database_1.prisma.quest.findMany({
        where: { isActive: true, isPartOfDailySet: true },
    });
    const completions = await database_1.prisma.questCompletion.findMany({
        where: {
            userId,
            questId: { in: dailyQuests.map(q => q.id) },
            isCompleted: true,
            isClaimed: true,
        },
    });
    if (completions.length < dailyQuests.length)
        return;
    // All daily quests done — give bonus 5 tickets
    await database_1.prisma.user.update({
        where: { id: userId },
        data: { ticketBalance: { increment: 5 } },
    });
    await database_1.prisma.transaction.create({
        data: {
            userId,
            type: client_1.TransactionType.DAILY_QUEST_BONUS,
            amount: 5,
            description: 'All daily quests completed bonus!',
            status: 'completed',
        },
    }).catch(() => { });
    // Update streak
    const streak = await database_1.prisma.dailyQuestStreak.findUnique({ where: { userId } });
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    const isConsecutive = streak?.lastCompletedDate
        ? new Date(streak.lastCompletedDate) >= yesterday
        : false;
    await database_1.prisma.dailyQuestStreak.upsert({
        where: { userId },
        update: {
            currentStreak: isConsecutive ? { increment: 1 } : 1,
            longestStreak: isConsecutive && streak
                ? Math.max(streak.longestStreak, (streak.currentStreak || 0) + 1)
                : 1,
            lastCompletedDate: new Date(),
            totalDaysCompleted: { increment: 1 },
        },
        create: {
            userId,
            currentStreak: 1,
            longestStreak: 1,
            lastCompletedDate: new Date(),
            totalDaysCompleted: 1,
        },
    });
    logger_1.logger.info(`Daily quest bonus awarded to ${userId}`);
}
// Admin: GET /api/quests/admin/list
const adminListQuests = async (req, res) => {
    try {
        const quests = await database_1.prisma.quest.findMany({
            include: { _count: { select: { completions: true } } },
            orderBy: { sortOrder: 'asc' },
        });
        return (0, response_1.success)(res, quests);
    }
    catch (err) {
        return (0, response_1.error)(res, 'Failed', 500);
    }
};
exports.adminListQuests = adminListQuests;
// Admin: POST /api/quests/admin/quests
const adminCreateQuest = async (req, res) => {
    try {
        const q = await database_1.prisma.quest.create({ data: req.body });
        return (0, response_1.success)(res, q, 'Quest created!');
    }
    catch (err) {
        return (0, response_1.error)(res, 'Failed', 500);
    }
};
exports.adminCreateQuest = adminCreateQuest;
// Admin: PUT /api/quests/admin/quests/:id
const adminUpdateQuest = async (req, res) => {
    try {
        const q = await database_1.prisma.quest.update({
            where: { id: req.params.id },
            data: req.body,
        });
        return (0, response_1.success)(res, q, 'Updated!');
    }
    catch (err) {
        return (0, response_1.error)(res, 'Failed', 500);
    }
};
exports.adminUpdateQuest = adminUpdateQuest;
// Admin: DELETE /api/quests/admin/quests/:id
const adminDeleteQuest = async (req, res) => {
    try {
        await database_1.prisma.quest.delete({ where: { id: req.params.id } });
        return (0, response_1.success)(res, null, 'Deleted!');
    }
    catch (err) {
        return (0, response_1.error)(res, 'Failed', 500);
    }
};
exports.adminDeleteQuest = adminDeleteQuest;
