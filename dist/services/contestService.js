"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.joinContest = joinContest;
exports.submitScore = submitScore;
exports.finalizeContest = finalizeContest;
exports.getLeaderboard = getLeaderboard;
const database_1 = require("../config/database");
const coinService_1 = require("./coinService");
const client_1 = require("@prisma/client");
const uuid_1 = require("uuid");
const logger_1 = require("../utils/logger");
async function joinContest(contestId, userId) {
    const contest = await database_1.prisma.contest.findUnique({ where: { id: contestId } });
    if (!contest)
        throw new Error('Contest not found');
    if (contest.status !== client_1.ContestStatus.REGISTRATION_OPEN)
        throw new Error('Registration not open');
    if (contest.currentPlayers >= contest.maxPlayers)
        throw new Error('Contest is full');
    const existing = await database_1.prisma.participant.findUnique({
        where: { contestId_userId: { contestId, userId } },
    });
    if (existing)
        throw new Error('Already joined this contest');
    const playToken = (0, uuid_1.v4)();
    await database_1.prisma.$transaction([
        database_1.prisma.participant.create({
            data: { contestId, userId, playToken, coinsEscrowed: 0 },
        }),
        database_1.prisma.contest.update({
            where: { id: contestId },
            data: { currentPlayers: { increment: 1 } },
        }),
    ]);
    if (contest.entryFee > 0) {
        await (0, coinService_1.escrowCoins)(userId, contest.entryFee, contestId);
    }
    // Auto-start ONE_V_ONE when full
    if (contest.type === client_1.ContestType.ONE_V_ONE && contest.currentPlayers + 1 >= contest.maxPlayers) {
        await database_1.prisma.contest.update({
            where: { id: contestId },
            data: { status: client_1.ContestStatus.GAMEPLAY_ACTIVE },
        });
    }
    return { playToken };
}
async function submitScore(contestId, userId, score) {
    const participant = await database_1.prisma.participant.findUnique({
        where: { contestId_userId: { contestId, userId } },
    });
    if (!participant)
        throw new Error('Not a participant');
    const contest = await database_1.prisma.contest.findUnique({ where: { id: contestId } });
    if (!contest || contest.status !== client_1.ContestStatus.GAMEPLAY_ACTIVE) {
        throw new Error('Contest not active');
    }
    // Only update if score is higher
    if (score > participant.score) {
        await database_1.prisma.participant.update({
            where: { id: participant.id },
            data: { score, lastScoreAt: new Date() },
        });
    }
    // For ONE_V_ONE check if both have submitted
    if (contest.type === client_1.ContestType.ONE_V_ONE) {
        const now = new Date();
        if (now >= contest.gameEndTime) {
            await finalizeContest(contestId);
        }
    }
    const allParticipants = await database_1.prisma.participant.findMany({
        where: { contestId },
        orderBy: { score: 'desc' },
    });
    const rank = allParticipants.findIndex((p) => p.userId === userId) + 1;
    return { rank };
}
async function finalizeContest(contestId) {
    const contest = await database_1.prisma.contest.findUnique({ where: { id: contestId } });
    if (!contest || contest.status === client_1.ContestStatus.COMPLETED)
        return;
    await database_1.prisma.contest.update({
        where: { id: contestId },
        data: { status: client_1.ContestStatus.SCORING },
    });
    if (contest.currentPlayers < contest.minPlayers) {
        await (0, coinService_1.refundEscrow)(contestId);
        await database_1.prisma.contest.update({
            where: { id: contestId },
            data: { status: client_1.ContestStatus.CANCELLED },
        });
        logger_1.logger.info('Contest cancelled — insufficient players', { contestId });
        return;
    }
    await (0, coinService_1.awardPrizes)(contestId);
    await database_1.prisma.contest.update({
        where: { id: contestId },
        data: { status: client_1.ContestStatus.COMPLETED },
    });
    logger_1.logger.info('Contest finalized', { contestId });
}
async function getLeaderboard(contestId) {
    const participants = await database_1.prisma.participant.findMany({
        where: { contestId },
        include: { user: { select: { name: true } } },
        orderBy: { score: 'desc' },
    });
    return participants.map((p, idx) => ({
        rank: idx + 1,
        userId: p.userId,
        name: p.user.name,
        score: p.score,
    }));
}
