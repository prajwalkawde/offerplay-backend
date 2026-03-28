"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserStats = getUserStats;
const database_1 = require("../config/database");
async function getUserStats(userId) {
    const [user, earnAgg, spendAgg, contestsPlayed, contestsWon, iplTotal, iplCorrect] = await Promise.all([
        database_1.prisma.user.findUnique({ where: { id: userId }, select: { coinBalance: true } }),
        database_1.prisma.transaction.aggregate({
            where: { userId, amount: { gt: 0 } },
            _sum: { amount: true },
        }),
        database_1.prisma.transaction.aggregate({
            where: { userId, amount: { lt: 0 } },
            _sum: { amount: true },
        }),
        database_1.prisma.participant.count({ where: { userId } }),
        database_1.prisma.participant.count({ where: { userId, rank: 1 } }),
        database_1.prisma.iplPrediction.count({ where: { userId } }),
        database_1.prisma.iplPrediction.count({ where: { userId, isCorrect: true } }),
    ]);
    return {
        coinBalance: user?.coinBalance ?? 0,
        totalEarned: earnAgg._sum.amount ?? 0,
        totalSpent: Math.abs(spendAgg._sum.amount ?? 0),
        contestsPlayed,
        contestsWon,
        iplPredictions: iplTotal,
        iplCorrect,
    };
}
