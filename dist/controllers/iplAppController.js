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
exports.getMatchesForApp = getMatchesForApp;
exports.joinContest = joinContest;
exports.getContestQuestions = getContestQuestions;
exports.savePredictions = savePredictions;
exports.getContestLeaderboard = getContestLeaderboard;
exports.getMyContests = getMyContests;
exports.getMyPredictions = getMyPredictions;
exports.getGlobalLeaderboard = getGlobalLeaderboard;
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const logger_1 = require("../utils/logger");
// ─── GET /api/ipl/matches ─────────────────────────────────────────────────────
// Returns upcoming matches (next 7 days) with published contests + user state
async function getMatchesForApp(req, res) {
    try {
        const userId = req.userId;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const nextWeek = new Date(today);
        nextWeek.setDate(nextWeek.getDate() + 7);
        const matches = await database_1.prisma.iplMatch.findMany({
            where: {
                matchDate: { gte: today, lte: nextWeek },
                status: { not: 'cancelled' },
            },
            include: {
                questions: { select: { id: true } },
                contests: {
                    where: { status: 'published' },
                    include: {
                        _count: { select: { entries: true } },
                        // Fetch the calling user's entry (or nothing if not logged in)
                        entries: {
                            where: userId ? { userId } : { userId: '' },
                            take: 1,
                        },
                    },
                    orderBy: [{ battleType: 'asc' }, { entryFee: 'desc' }],
                },
            },
            orderBy: { matchDate: 'asc' },
        });
        const result = matches.map(match => ({
            ...match,
            isToday: match.matchDate.toDateString() === new Date().toDateString(),
            questionCount: match.questions.length,
            questions: undefined,
            contests: match.contests
                .map(c => ({
                id: c.id,
                name: c.name,
                battleType: c.battleType,
                contestType: c.contestType,
                entryFee: c.entryFee,
                isFree: c.isFree,
                maxPlayers: c.maxPlayers,
                currentPlayers: c._count.entries,
                spotsLeft: Math.max(0, c.maxPlayers - c._count.entries),
                isFull: c._count.entries >= c.maxPlayers,
                prizeType: c.prizeType,
                prizeCoins: c.prizeCoins,
                prizeGiftName: c.prizeGiftName,
                rewardImageUrl: c.rewardImageUrl,
                youtubeUrl: c.youtubeUrl,
                questionCount: c.questionCount,
                sponsorName: c.sponsorName,
                sponsorLogo: c.sponsorLogo,
                maxEntriesPerUser: c.maxEntriesPerUser,
                hasJoined: c.entries.length > 0,
            }))
                // MEGA first, then by entry fee descending
                .sort((a, b) => {
                if (a.battleType === 'MEGA' && b.battleType !== 'MEGA')
                    return -1;
                if (b.battleType === 'MEGA' && a.battleType !== 'MEGA')
                    return 1;
                return 0;
            }),
        }));
        (0, response_1.success)(res, result);
    }
    catch (err) {
        logger_1.logger.error('getMatchesForApp error:', err);
        (0, response_1.error)(res, 'Failed to fetch matches', 500);
    }
}
// ─── POST /api/ipl/contests/:contestId/join ───────────────────────────────────
async function joinContest(req, res) {
    const userId = req.userId;
    const { contestId } = req.params;
    try {
        const contest = await database_1.prisma.iplContest.findUnique({
            where: { id: contestId },
            include: {
                _count: { select: { entries: true } },
                match: {
                    include: {
                        questions: { where: { status: 'active' }, select: { id: true } },
                    },
                },
            },
        });
        if (!contest) {
            (0, response_1.error)(res, 'Contest not found', 404);
            return;
        }
        if (contest.status !== 'published') {
            (0, response_1.error)(res, 'Contest not available', 400);
            return;
        }
        // Already joined?
        const existing = await database_1.prisma.iplContestEntry.findUnique({
            where: { contestId_userId: { contestId, userId } },
        });
        if (existing) {
            (0, response_1.error)(res, 'Already joined!', 400);
            return;
        }
        // Contest full?
        if (contest._count.entries >= contest.maxPlayers) {
            (0, response_1.error)(res, 'Contest is full!', 400);
            return;
        }
        // Max entries per user per match + battle-type
        const userMatchEntries = await database_1.prisma.iplContestEntry.count({
            where: { userId, contest: { matchId: contest.matchId, battleType: contest.battleType } },
        });
        if (userMatchEntries >= (contest.maxEntriesPerUser || 3)) {
            (0, response_1.error)(res, `Max ${contest.maxEntriesPerUser || 3} entries per match type`, 400);
            return;
        }
        // Ticket-based entry
        const ticketCost = contest.ticketCost ?? 1;
        const entryType = contest.entryType ?? 'TICKET';
        if (entryType === 'TICKET' && ticketCost > 0) {
            const { spendTickets } = await Promise.resolve().then(() => __importStar(require('../services/ticketService')));
            const result = await spendTickets(userId, ticketCost, `Contest entry: ${contest.name}`, contestId);
            if (!result.success) {
                (0, response_1.error)(res, result.error || 'Insufficient tickets!', 400);
                return;
            }
        }
        await database_1.prisma.$transaction([
            database_1.prisma.iplContestEntry.create({
                data: { userId, contestId, matchId: contest.matchId, coinsDeducted: 0 },
            }),
            database_1.prisma.iplContest.update({
                where: { id: contestId },
                data: { currentPlayers: { increment: 1 } },
            }),
        ]);
        const now = new Date();
        const questionsAvailable = !contest.questionsAvailableAt || contest.questionsAvailableAt <= now;
        const questionCount = contest.match?.questions?.length ?? 0;
        (0, response_1.success)(res, {
            contestId,
            ticketsSpent: ticketCost,
            questionsAvailable,
            questionsAvailableAt: contest.questionsAvailableAt,
            questionCount,
            matchId: contest.matchId,
            message: questionsAvailable
                ? 'Joined! Make your predictions now!'
                : `Joined! Questions open at ${contest.questionsAvailableAt?.toLocaleString()}`,
        }, 'Successfully joined contest!');
    }
    catch (err) {
        logger_1.logger.error('joinContest error:', err);
        (0, response_1.error)(res, 'Failed to join contest', 500);
    }
}
// ─── GET /api/ipl/contests/:contestId/questions ───────────────────────────────
async function getContestQuestions(req, res) {
    const userId = req.userId;
    const { contestId } = req.params;
    try {
        const entry = await database_1.prisma.iplContestEntry.findUnique({
            where: { contestId_userId: { contestId, userId } },
            include: {
                contest: {
                    include: {
                        match: {
                            include: {
                                questions: {
                                    where: { status: 'active' },
                                    orderBy: { id: 'asc' },
                                },
                            },
                        },
                    },
                },
            },
        });
        if (!entry) {
            (0, response_1.error)(res, 'Join the contest first!', 400);
            return;
        }
        const contest = entry.contest;
        const now = new Date();
        if (contest.questionsAvailableAt && contest.questionsAvailableAt > now) {
            (0, response_1.success)(res, {
                questionsAvailable: false,
                questionsAvailableAt: contest.questionsAvailableAt,
                message: 'Questions not available yet',
                questions: [],
            });
            return;
        }
        const predictionsLocked = !!contest.questionsLockAt && contest.questionsLockAt <= now;
        const questions = contest.match?.questions ?? [];
        if (questions.length === 0) {
            (0, response_1.success)(res, {
                questionsAvailable: true,
                questionsLocked: predictionsLocked,
                questions: [],
                message: 'No questions available for this match yet',
            });
            return;
        }
        const matchId = contest.match?.id;
        const predictions = matchId
            ? await database_1.prisma.iplPrediction.findMany({ where: { userId, matchId } })
            : [];
        const predMap = {};
        predictions.forEach((p) => {
            predMap[p.questionId] = p.answer;
        });
        (0, response_1.success)(res, {
            questionsAvailable: true,
            questionsLocked: predictionsLocked,
            questionsLockAt: contest.questionsLockAt,
            questions: questions.map((q) => ({
                id: q.id,
                question: q.question,
                options: q.options,
                points: q.points,
                difficulty: q.difficulty || 'medium',
                category: q.category || 'prediction',
                myAnswer: predMap[q.id] || null,
                correctAnswer: predictionsLocked ? q.correctAnswer : null,
            })),
            totalQuestions: questions.length,
            answeredCount: predictions.length,
        });
    }
    catch (err) {
        logger_1.logger.error('getContestQuestions error:', err);
        (0, response_1.error)(res, 'Failed to fetch questions', 500);
    }
}
// ─── POST /api/ipl/contests/:contestId/predict ────────────────────────────────
// predictions = [{ questionId, answer }]
async function savePredictions(req, res) {
    const userId = req.userId;
    const { contestId } = req.params;
    const { predictions } = req.body;
    if (!Array.isArray(predictions) || predictions.length === 0) {
        (0, response_1.error)(res, 'predictions array is required', 400);
        return;
    }
    try {
        // Verify user joined this contest
        const entry = await database_1.prisma.iplContestEntry.findFirst({
            where: { userId, contestId },
            include: { contest: { select: { matchId: true } } },
        });
        if (!entry) {
            (0, response_1.error)(res, 'Join the contest first', 400);
            return;
        }
        const matchId = entry.contest.matchId;
        // Upsert each prediction — key is userId_questionId (per existing schema)
        for (const pred of predictions) {
            await database_1.prisma.iplPrediction.upsert({
                where: { userId_questionId: { userId, questionId: pred.questionId } },
                update: { answer: pred.answer },
                create: { userId, matchId, questionId: pred.questionId, answer: pred.answer },
            });
        }
        (0, response_1.success)(res, { predictionsCount: predictions.length }, 'Predictions saved!');
    }
    catch (err) {
        logger_1.logger.error('savePredictions error:', err);
        (0, response_1.error)(res, 'Failed to save predictions', 500);
    }
}
// ─── GET /api/ipl/contests/:contestId/leaderboard ────────────────────────────
async function getContestLeaderboard(req, res) {
    const userId = req.userId;
    const { contestId } = req.params;
    try {
        const contest = await database_1.prisma.iplContest.findUnique({
            where: { id: contestId },
            include: { match: { select: { team1: true, team2: true } } },
        });
        if (!contest) {
            (0, response_1.error)(res, 'Contest not found', 404);
            return;
        }
        const entries = await database_1.prisma.iplContestEntry.findMany({
            where: { contestId },
            include: { user: { select: { id: true, name: true, phone: true } } },
            orderBy: [{ totalPoints: 'desc' }, { joinedAt: 'asc' }],
            take: 100,
        });
        const leaderboard = entries.map((entry, i) => ({
            rank: i + 1,
            userId: entry.userId,
            name: entry.user.name?.split(' ')[0] ?? `User${entry.userId.slice(0, 4)}`,
            fullName: entry.user.name ?? 'Unknown',
            avatar: (entry.user.name?.charAt(0) ?? 'U').toUpperCase(),
            totalPoints: entry.totalPoints,
            coinsWon: entry.coinsWon,
            isCurrentUser: entry.userId === userId,
        }));
        const userRank = leaderboard.find(e => e.isCurrentUser);
        (0, response_1.success)(res, {
            leaderboard,
            totalEntries: entries.length,
            contestName: contest.name,
            matchName: `${contest.match.team1} vs ${contest.match.team2}`,
            status: contest.status,
            userRank: userRank?.rank ?? null,
            userPoints: userRank?.totalPoints ?? 0,
        });
    }
    catch (err) {
        logger_1.logger.error('getContestLeaderboard error:', err);
        (0, response_1.error)(res, 'Failed to fetch leaderboard', 500);
    }
}
// ─── GET /api/ipl/my-contests ─────────────────────────────────────────────────
async function getMyContests(req, res) {
    const userId = req.userId;
    try {
        const entries = await database_1.prisma.iplContestEntry.findMany({
            where: { userId },
            include: {
                contest: {
                    include: {
                        match: {
                            select: {
                                id: true,
                                team1: true,
                                team2: true,
                                matchDate: true,
                                status: true,
                                result: true,
                                youtubeUrl: true,
                            },
                        },
                    },
                },
            },
            orderBy: { joinedAt: 'desc' },
            take: 50,
        });
        const now = new Date();
        const result = entries.map(entry => {
            const contest = entry.contest;
            const questionsAvailable = !contest.questionsAvailableAt || contest.questionsAvailableAt <= now;
            const predictionsLocked = !!contest.questionsLockAt && contest.questionsLockAt <= now;
            return {
                entryId: entry.id,
                contestId: contest.id,
                contestName: contest.name,
                battleType: contest.battleType,
                ticketsSpent: contest.ticketCost,
                rank: entry.rank,
                totalPoints: entry.totalPoints,
                coinsWon: entry.coinsWon,
                status: contest.status,
                matchId: contest.matchId,
                matchTeam1: contest.match.team1,
                matchTeam2: contest.match.team2,
                matchDate: contest.match.matchDate,
                matchStatus: contest.match.status,
                result: contest.match.result,
                youtubeUrl: contest.match.youtubeUrl,
                joinedAt: entry.joinedAt,
                questionsAvailable,
                questionsAvailableAt: contest.questionsAvailableAt,
                predictionsLocked,
                questionsLockAt: contest.questionsLockAt,
            };
        });
        const active = result.filter(e => e.status === 'published' && !e.predictionsLocked);
        const pending = result.filter(e => e.status === 'published' && !e.questionsAvailable);
        const completed = result.filter(e => e.status === 'completed');
        (0, response_1.success)(res, {
            all: result,
            active,
            pending,
            completed,
            totalJoined: result.length,
        });
    }
    catch (err) {
        logger_1.logger.error('getMyContests error:', err);
        (0, response_1.error)(res, 'Failed to fetch contests', 500);
    }
}
// ─── GET /api/ipl/contests/:contestId/my-predictions ─────────────────────────
async function getMyPredictions(req, res) {
    const userId = req.userId;
    const { contestId } = req.params;
    try {
        const entry = await database_1.prisma.iplContestEntry.findFirst({
            where: { userId, contestId },
            include: { contest: { select: { matchId: true } } },
        });
        if (!entry) {
            (0, response_1.error)(res, 'Not joined this contest', 400);
            return;
        }
        const predictions = await database_1.prisma.iplPrediction.findMany({
            where: { userId, matchId: entry.contest.matchId },
            include: {
                question: { select: { question: true, options: true, correctAnswer: true, points: true } },
            },
        });
        (0, response_1.success)(res, {
            predictions: predictions.map(p => ({
                questionId: p.questionId,
                question: p.question?.question,
                options: p.question?.options,
                myAnswer: p.answer,
                correctAnswer: p.question?.correctAnswer ?? null,
                isCorrect: p.isCorrect,
                pointsEarned: p.pointsEarned,
                maxPoints: p.question?.points ?? 100,
            })),
            totalPoints: entry.totalPoints,
            rank: entry.rank,
            coinsWon: entry.coinsWon,
        });
    }
    catch (err) {
        logger_1.logger.error('getMyPredictions error:', err);
        (0, response_1.error)(res, 'Failed to fetch predictions', 500);
    }
}
// ─── GET /api/ipl/global-leaderboard ─────────────────────────────────────────
async function getGlobalLeaderboard(req, res) {
    const userId = req.userId;
    try {
        const topEntries = await database_1.prisma.iplContestEntry.groupBy({
            by: ['userId'],
            _sum: { totalPoints: true, coinsWon: true },
            _count: { id: true },
            orderBy: { _sum: { totalPoints: 'desc' } },
            take: 50,
        });
        const userIds = topEntries.map(e => e.userId);
        const users = await database_1.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true },
        });
        const userMap = new Map(users.map(u => [u.id, u.name]));
        const leaderboard = topEntries.map((entry, i) => ({
            rank: i + 1,
            userId: entry.userId,
            name: userMap.get(entry.userId)?.split(' ')[0] ?? `User${entry.userId.slice(0, 4)}`,
            avatar: (userMap.get(entry.userId)?.charAt(0) ?? 'U').toUpperCase(),
            totalPoints: entry._sum.totalPoints ?? 0,
            coinsWon: entry._sum.coinsWon ?? 0,
            contestsPlayed: entry._count.id,
            isCurrentUser: entry.userId === userId,
        }));
        (0, response_1.success)(res, leaderboard);
    }
    catch (err) {
        logger_1.logger.error('getGlobalLeaderboard error:', err);
        (0, response_1.error)(res, 'Failed to fetch leaderboard', 500);
    }
}
