"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listContests = listContests;
exports.getContest = getContest;
exports.joinContestHandler = joinContestHandler;
exports.submitScoreHandler = submitScoreHandler;
exports.getContestLeaderboard = getContestLeaderboard;
const database_1 = require("../config/database");
const contestService_1 = require("../services/contestService");
const response_1 = require("../utils/response");
const query_1 = require("../utils/query");
async function listContests(req, res) {
    const status = (0, query_1.qs)(req.query.status);
    const type = (0, query_1.qs)(req.query.type);
    const page = parseInt((0, query_1.qs)(req.query.page) ?? '1', 10);
    const limit = Math.min(parseInt((0, query_1.qs)(req.query.limit) ?? '20', 10), 100);
    const skip = (page - 1) * limit;
    const where = {
        ...(status && { status }),
        ...(type && { type }),
    };
    const [contests, total] = await Promise.all([
        database_1.prisma.contest.findMany({
            where,
            include: { game: { select: { id: true, name: true, icon: true } } },
            orderBy: { regStartTime: 'desc' },
            skip,
            take: limit,
        }),
        database_1.prisma.contest.count({ where }),
    ]);
    (0, response_1.paginated)(res, contests, total, page, limit);
}
async function getContest(req, res) {
    const contest = await database_1.prisma.contest.findUnique({
        where: { id: req.params.id },
        include: {
            game: true,
            participants: {
                include: { user: { select: { id: true, name: true } } },
                orderBy: { score: 'desc' },
                take: 10,
            },
        },
    });
    if (!contest) {
        (0, response_1.error)(res, 'Contest not found', 404);
        return;
    }
    (0, response_1.success)(res, contest);
}
async function joinContestHandler(req, res) {
    try {
        const result = await (0, contestService_1.joinContest)(req.params.id, req.userId);
        (0, response_1.success)(res, result, 'Joined contest successfully', 201);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to join contest';
        (0, response_1.error)(res, msg, 400);
    }
}
async function submitScoreHandler(req, res) {
    const { score } = req.body;
    try {
        const result = await (0, contestService_1.submitScore)(req.params.id, req.userId, score);
        (0, response_1.success)(res, result, 'Score submitted');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to submit score';
        (0, response_1.error)(res, msg, 400);
    }
}
async function getContestLeaderboard(req, res) {
    const leaderboard = await (0, contestService_1.getLeaderboard)(req.params.id);
    (0, response_1.success)(res, leaderboard);
}
