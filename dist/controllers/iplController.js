"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listMatches = listMatches;
exports.getMatch = getMatch;
exports.predict = predict;
exports.iplLeaderboard = iplLeaderboard;
exports.joinIPLContest = joinIPLContest;
exports.getMatchContestsForUser = getMatchContestsForUser;
exports.joinContestById = joinContestById;
exports.saveContestPredictions = saveContestPredictions;
exports.myRank = myRank;
exports.myPredictions = myPredictions;
const database_1 = require("../config/database");
const iplService_1 = require("../services/iplService");
const coinService_1 = require("../services/coinService");
const response_1 = require("../utils/response");
const query_1 = require("../utils/query");
async function listMatches(req, res) {
    const status = (0, query_1.qs)(req.query.status);
    const page = parseInt((0, query_1.qs)(req.query.page) ?? '1', 10);
    const limit = Math.min(parseInt((0, query_1.qs)(req.query.limit) ?? '20', 10), 50);
    const skip = (page - 1) * limit;
    const where = { ...(status && { status }) };
    const [matches, total] = await Promise.all([
        database_1.prisma.iplMatch.findMany({ where, orderBy: { matchDate: 'asc' }, skip, take: limit }),
        database_1.prisma.iplMatch.count({ where }),
    ]);
    (0, response_1.paginated)(res, matches, total, page, limit);
}
async function getMatch(req, res) {
    const match = await database_1.prisma.iplMatch.findUnique({
        where: { id: req.params.id },
        include: {
            questions: {
                where: { status: 'active' },
                select: { id: true, question: true, options: true, points: true, status: true },
            },
        },
    });
    if (!match) {
        (0, response_1.error)(res, 'Match not found', 404);
        return;
    }
    (0, response_1.success)(res, match);
}
async function predict(req, res) {
    const { matchId, questionId, answer } = req.body;
    try {
        await (0, iplService_1.submitPrediction)(req.userId, matchId, questionId, answer);
        (0, response_1.success)(res, null, 'Prediction submitted', 201);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'Prediction failed';
        (0, response_1.error)(res, msg, 400);
    }
}
async function iplLeaderboard(req, res) {
    const limit = Math.min(parseInt((0, query_1.qs)(req.query.limit) ?? '50', 10), 100);
    const data = await (0, iplService_1.getLeaderboard)(limit);
    (0, response_1.success)(res, data);
}
async function joinIPLContest(req, res) {
    const { matchId, entryFee } = req.body;
    const userId = req.userId;
    try {
        const user = await database_1.prisma.user.findUnique({
            where: { id: userId },
            select: { coinBalance: true },
        });
        if (!user || user.coinBalance < entryFee) {
            (0, response_1.error)(res, 'Insufficient coins', 400);
            return;
        }
        await (0, coinService_1.debitCoins)(userId, entryFee, 'SPEND_IPL_ENTRY', matchId, 'IPL match prediction entry fee');
        (0, response_1.success)(res, {
            newBalance: user.coinBalance - entryFee,
            message: 'Entry fee deducted successfully',
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to join contest';
        (0, response_1.error)(res, msg, 500);
    }
}
async function getMatchContestsForUser(req, res) {
    const { id } = req.params;
    const contests = await database_1.prisma.iplContest.findMany({
        where: { matchId: id, status: { in: ['published', 'live'] } },
        include: { _count: { select: { entries: true } } },
        orderBy: { createdAt: 'asc' },
    });
    const result = contests.map(c => ({
        id: c.id,
        matchId: c.matchId,
        name: c.name,
        contestType: c.contestType,
        battleType: c.battleType,
        maxPlayers: c.maxPlayers,
        minPlayers: c.minPlayers,
        currentPlayers: c._count.entries,
        entryFee: c.entryFee,
        prizeType: c.prizeType,
        prizeCoins: c.prizeCoins,
        prizeGiftName: c.prizeGiftName,
        prizeGiftValue: c.prizeGiftValue,
        prizeDistribution: c.prizeDistribution,
        regCloseTime: c.regCloseTime,
        status: c.status,
    }));
    (0, response_1.success)(res, result);
}
async function joinContestById(req, res) {
    const { contestId } = req.params;
    const userId = req.userId;
    try {
        const contest = await database_1.prisma.iplContest.findUnique({ where: { id: contestId } });
        if (!contest) {
            (0, response_1.error)(res, 'Contest not found', 404);
            return;
        }
        if (contest.status !== 'published' && contest.status !== 'live') {
            (0, response_1.error)(res, 'Contest is not available', 400);
            return;
        }
        const existing = await database_1.prisma.iplContestEntry.findFirst({ where: { userId, contestId } });
        if (existing) {
            (0, response_1.error)(res, 'Already joined this contest', 400);
            return;
        }
        const user = await database_1.prisma.user.findUnique({ where: { id: userId }, select: { coinBalance: true } });
        if (!user || user.coinBalance < contest.entryFee) {
            (0, response_1.error)(res, 'Insufficient coins', 400);
            return;
        }
        const currentCount = await database_1.prisma.iplContestEntry.count({ where: { contestId } });
        if (currentCount >= contest.maxPlayers) {
            (0, response_1.error)(res, 'Contest is full', 400);
            return;
        }
        await database_1.prisma.$transaction([
            database_1.prisma.user.update({ where: { id: userId }, data: { coinBalance: { decrement: contest.entryFee } } }),
            database_1.prisma.iplContestEntry.create({ data: { userId, contestId, coinsDeducted: contest.entryFee } }),
            database_1.prisma.transaction.create({
                data: {
                    userId, type: 'SPEND_IPL_ENTRY', amount: contest.entryFee,
                    refId: contestId, description: `IPL Contest entry: ${contest.name}`,
                },
            }),
        ]);
        (0, response_1.success)(res, { newBalance: user.coinBalance - contest.entryFee }, 'Successfully joined contest!');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to join contest';
        (0, response_1.error)(res, msg, 500);
    }
}
async function saveContestPredictions(req, res) {
    const { contestId } = req.params;
    const userId = req.userId;
    const { predictions } = req.body;
    if (!Array.isArray(predictions) || predictions.length === 0) {
        (0, response_1.error)(res, 'predictions array is required', 400);
        return;
    }
    try {
        const entry = await database_1.prisma.iplContestEntry.findFirst({ where: { userId, contestId } });
        if (!entry) {
            (0, response_1.error)(res, 'Not joined this contest', 400);
            return;
        }
        const contest = await database_1.prisma.iplContest.findUnique({ where: { id: contestId } });
        if (!contest) {
            (0, response_1.error)(res, 'Contest not found', 404);
            return;
        }
        for (const pred of predictions) {
            await database_1.prisma.iplPrediction.upsert({
                where: { userId_questionId: { userId, questionId: pred.questionId } },
                update: { answer: pred.answer },
                create: {
                    userId, matchId: contest.matchId,
                    questionId: pred.questionId, answer: pred.answer,
                },
            });
        }
        (0, response_1.success)(res, null, 'Predictions saved!');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to save predictions';
        (0, response_1.error)(res, msg, 500);
    }
}
async function myRank(req, res) {
    const userId = req.userId;
    const [userPoints, allPoints] = await Promise.all([
        database_1.prisma.iplPrediction.aggregate({
            where: { userId },
            _sum: { pointsEarned: true },
        }),
        database_1.prisma.iplPrediction.groupBy({
            by: ['userId'],
            _sum: { pointsEarned: true },
            orderBy: { _sum: { pointsEarned: 'desc' } },
        }),
    ]);
    const myTotal = userPoints._sum.pointsEarned ?? 0;
    const rank = allPoints.findIndex((r) => r.userId === userId) + 1;
    const totalPlayers = allPoints.length;
    (0, response_1.success)(res, {
        rank: rank > 0 ? rank : null,
        totalPoints: myTotal,
        totalPlayers,
    });
}
async function myPredictions(req, res) {
    const page = parseInt((0, query_1.qs)(req.query.page) ?? '1', 10);
    const limit = Math.min(parseInt((0, query_1.qs)(req.query.limit) ?? '20', 10), 50);
    const skip = (page - 1) * limit;
    const where = { userId: req.userId };
    const [predictions, total] = await Promise.all([
        database_1.prisma.iplPrediction.findMany({
            where,
            include: {
                match: { select: { team1: true, team2: true, matchDate: true } },
                question: { select: { question: true, options: true, correctAnswer: true } },
            },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        database_1.prisma.iplPrediction.count({ where }),
    ]);
    (0, response_1.paginated)(res, predictions, total, page, limit);
}
