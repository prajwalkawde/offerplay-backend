"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.creditCoins = creditCoins;
exports.debitCoins = debitCoins;
exports.escrowCoins = escrowCoins;
exports.refundEscrow = refundEscrow;
exports.awardPrizes = awardPrizes;
exports.getBalance = getBalance;
exports.getLedger = getLedger;
const client_1 = require("@prisma/client");
const database_1 = require("../config/database");
const logger_1 = require("../utils/logger");
async function creditCoins(userId, amount, type, refId, description) {
    if (amount <= 0)
        throw new Error('Amount must be positive');
    await database_1.prisma.$transaction([
        database_1.prisma.user.update({
            where: { id: userId },
            data: { coinBalance: { increment: amount } },
        }),
        database_1.prisma.transaction.create({
            data: { userId, type, amount, refId, description, status: 'completed' },
        }),
    ]);
    logger_1.logger.debug('Coins credited', { userId, amount, type });
}
async function debitCoins(userId, amount, type, refId, description) {
    if (amount <= 0)
        throw new Error('Amount must be positive');
    const user = await database_1.prisma.user.findUnique({ where: { id: userId }, select: { coinBalance: true } });
    if (!user)
        throw new Error('User not found');
    if (user.coinBalance < amount)
        throw new Error('Insufficient coin balance');
    await database_1.prisma.$transaction([
        database_1.prisma.user.update({
            where: { id: userId },
            data: { coinBalance: { decrement: amount } },
        }),
        database_1.prisma.transaction.create({
            data: { userId, type, amount: -amount, refId, description, status: 'completed' },
        }),
    ]);
    logger_1.logger.debug('Coins debited', { userId, amount, type });
}
async function escrowCoins(userId, amount, contestId) {
    if (amount <= 0)
        throw new Error('Amount must be positive');
    const user = await database_1.prisma.user.findUnique({ where: { id: userId }, select: { coinBalance: true } });
    if (!user)
        throw new Error('User not found');
    if (user.coinBalance < amount)
        throw new Error('Insufficient coin balance');
    await database_1.prisma.$transaction([
        database_1.prisma.user.update({
            where: { id: userId },
            data: { coinBalance: { decrement: amount } },
        }),
        database_1.prisma.participant.update({
            where: { contestId_userId: { contestId, userId } },
            data: { coinsEscrowed: { increment: amount } },
        }),
        database_1.prisma.transaction.create({
            data: {
                userId,
                type: client_1.TransactionType.SPEND_CONTEST_ENTRY,
                amount: -amount,
                refId: contestId,
                description: 'Contest entry fee',
                status: 'completed',
            },
        }),
    ]);
}
async function refundEscrow(contestId) {
    const participants = await database_1.prisma.participant.findMany({
        where: { contestId, coinsEscrowed: { gt: 0 } },
    });
    await database_1.prisma.$transaction(participants.flatMap((p) => [
        database_1.prisma.user.update({
            where: { id: p.userId },
            data: { coinBalance: { increment: p.coinsEscrowed } },
        }),
        database_1.prisma.transaction.create({
            data: {
                userId: p.userId,
                type: client_1.TransactionType.REFUND,
                amount: p.coinsEscrowed,
                refId: contestId,
                description: 'Contest cancelled — refund',
                status: 'completed',
            },
        }),
        database_1.prisma.participant.update({
            where: { id: p.id },
            data: { coinsEscrowed: 0 },
        }),
    ]));
    logger_1.logger.info('Escrow refunded', { contestId, count: participants.length });
}
async function awardPrizes(contestId) {
    const contest = await database_1.prisma.contest.findUnique({
        where: { id: contestId },
        include: { participants: { orderBy: { score: 'desc' } } },
    });
    if (!contest)
        throw new Error('Contest not found');
    const distribution = contest.prizeDistribution;
    const txns = [];
    const updates = [];
    contest.participants.forEach((p, idx) => {
        const rank = idx + 1;
        const prizeCoins = distribution[String(rank)] ?? 0;
        updates.push(database_1.prisma.participant.update({
            where: { id: p.id },
            data: { rank },
        }));
        if (prizeCoins > 0) {
            txns.push(database_1.prisma.transaction.create({
                data: {
                    userId: p.userId,
                    type: client_1.TransactionType.EARN_CONTEST_WIN,
                    amount: prizeCoins,
                    refId: contestId,
                    description: `Contest win — rank ${rank}`,
                    status: 'completed',
                },
            }));
        }
    });
    // Credit prize coins to winners
    const winnerUpdates = contest.participants
        .map((p, idx) => {
        const rank = idx + 1;
        const prizeCoins = distribution[String(rank)] ?? 0;
        if (prizeCoins <= 0)
            return null;
        return database_1.prisma.user.update({
            where: { id: p.userId },
            data: { coinBalance: { increment: prizeCoins } },
        });
    })
        .filter(Boolean);
    await database_1.prisma.$transaction([...updates, ...txns, ...winnerUpdates]);
    logger_1.logger.info('Prizes awarded', { contestId });
}
async function getBalance(userId) {
    const user = await database_1.prisma.user.findUnique({
        where: { id: userId },
        select: { coinBalance: true },
    });
    return user?.coinBalance ?? 0;
}
async function getLedger(userId, type, limit = 20, page = 1) {
    const skip = (page - 1) * limit;
    const where = { userId, ...(type && { type }) };
    const [transactions, total] = await Promise.all([
        database_1.prisma.transaction.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        database_1.prisma.transaction.count({ where }),
    ]);
    return { transactions, total };
}
