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
exports.enrichMatch = enrichMatch;
exports.getRank1Prize = getRank1Prize;
exports.calcTotalPrizePool = calcTotalPrizePool;
exports.getMatchesForApp = getMatchesForApp;
exports.joinContest = joinContest;
exports.getContestQuestions = getContestQuestions;
exports.savePredictions = savePredictions;
exports.getContestLeaderboard = getContestLeaderboard;
exports.getMyContests = getMyContests;
exports.getMyPredictions = getMyPredictions;
exports.getGlobalLeaderboard = getGlobalLeaderboard;
const client_1 = require("@prisma/client");
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const logger_1 = require("../utils/logger");
const iplTeams_1 = require("../config/iplTeams");
// ─── Team logo URL cache (refreshed every 10 min from DB settings) ────────────
let _logoCache = {};
let _logoCacheAt = 0;
async function getTeamLogoUrls() {
    const now = Date.now();
    if (now - _logoCacheAt < 10 * 60 * 1000)
        return _logoCache;
    try {
        const rows = await database_1.prisma.appSettings.findMany({
            where: { key: { startsWith: 'TEAM_LOGO_' } },
            select: { key: true, value: true },
        });
        _logoCache = Object.fromEntries(rows.filter(r => r.value).map(r => [r.key.replace('TEAM_LOGO_', ''), r.value]));
        _logoCacheAt = now;
    }
    catch { /* keep previous cache on DB error */ }
    return _logoCache;
}
// ─── Helper: enrich a match object with team logo/color/name fields ───────────
function enrichMatch(match, logoUrls = {}) {
    const t1 = (0, iplTeams_1.getTeam)(match.team1);
    const t2 = (0, iplTeams_1.getTeam)(match.team2);
    return {
        ...match,
        team1Logo: logoUrls[match.team1] ?? t1?.logoUrl ?? '',
        team1Color: t1?.color ?? '#7B2FBE',
        team1FullName: t1?.name ?? match.team1,
        team1Emoji: t1?.emoji ?? '🏏',
        team2Logo: logoUrls[match.team2] ?? t2?.logoUrl ?? '',
        team2Color: t2?.color ?? '#00C2E3',
        team2FullName: t2?.name ?? match.team2,
        team2Emoji: t2?.emoji ?? '🏏',
    };
}
// ─── Helper: extract rank 1 prize from prizeTiersConfig ──────────────────────
function getRank1Prize(contest) {
    const tiers = Array.isArray(contest.prizeTiersConfig) ? contest.prizeTiersConfig : [];
    if (tiers.length === 0)
        return null;
    const rank1 = tiers.find((t) => t.rank === 1 || t.rankFrom === 1) ?? tiers[0];
    return {
        type: rank1.type,
        coins: rank1.coins || null,
        itemName: rank1.itemName || null,
        itemImage: rank1.itemImage || null,
        itemValue: rank1.itemValue || null,
        productName: rank1.productName || null,
        denominationValue: rank1.denominationValue || null,
        label: rank1.label || '1st Place',
    };
}
// ─── Helper: compute total coins prize pool from prizeTiersConfig ─────────────
function calcTotalPrizePool(prizeTiersConfig) {
    if (!Array.isArray(prizeTiersConfig) || prizeTiersConfig.length === 0)
        return 0;
    return prizeTiersConfig.reduce((sum, t) => {
        if (t.type !== 'COINS')
            return sum;
        const from = t.rankFrom ?? t.rank ?? 1;
        const to = t.rankTo ?? t.rank ?? 1;
        return sum + (t.coins || 0) * (to - from + 1);
    }, 0);
}
// ─── Helper: compute displayStatus for a contest ──────────────────────────────
function getContestDisplayStatus(contestStatus, regCloseTime, matchStatus) {
    if (contestStatus === 'completed' || matchStatus === 'completed')
        return 'COMPLETED';
    if (regCloseTime && new Date() > new Date(regCloseTime))
        return 'LOCKED';
    return 'OPEN';
}
// ─── GET /api/ipl/matches ─────────────────────────────────────────────────────
// Returns upcoming matches (next 7 days) with published contests + user state
async function getMatchesForApp(req, res) {
    try {
        const userId = req.userId;
        const logoUrls = await getTeamLogoUrls();
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
            ...enrichMatch(match, logoUrls),
            isToday: match.matchDate.toDateString() === new Date().toDateString(),
            questionCount: match.questions.length,
            questions: undefined,
            matchDate: match.matchDate,
            matchStartTime: match.matchStartTime || match.matchDate,
            registrationCloseTime: match.registrationCloseTime || null,
            venue: match.venue || null,
            contests: match.contests
                .map(c => {
                const parsedTiersConfig = typeof c.prizeTiersConfig === 'string'
                    ? JSON.parse(c.prizeTiersConfig)
                    : c.prizeTiersConfig;
                const rawTiers = Array.isArray(parsedTiersConfig) ? parsedTiersConfig : [];
                const parsedWinnersConfig = typeof c.winnersConfig === 'string'
                    ? JSON.parse(c.winnersConfig)
                    : c.winnersConfig;
                const rawWinners = Array.isArray(parsedWinnersConfig) ? parsedWinnersConfig : [];
                const allTiers = rawTiers.length > 0 ? rawTiers : rawWinners.map((w) => ({
                    rankFrom: w.rankFrom, rankTo: w.rankTo, rank: w.rankFrom,
                    type: 'COINS', coins: w.coins, label: w.label,
                }));
                return {
                    id: c.id,
                    name: c.name,
                    battleType: c.battleType,
                    contestType: c.contestType,
                    entryType: c.entryType || 'FREE',
                    entryFee: c.entryFee,
                    ticketCost: c.ticketCost,
                    isFree: c.isFree,
                    maxPlayers: c.maxPlayers,
                    currentPlayers: c._count.entries,
                    spotsLeft: Math.max(0, c.maxPlayers - c._count.entries),
                    isFull: c._count.entries >= c.maxPlayers,
                    prizeType: c.prizeType,
                    prizeCoins: c.prizeCoins,
                    prizeGiftName: c.prizeGiftName,
                    rewardImageUrl: c.rewardImageUrl,
                    prizeTiersConfig: allTiers,
                    rank1Prize: getRank1Prize({ prizeTiersConfig: allTiers }),
                    totalPrizePool: calcTotalPrizePool(allTiers),
                    youtubeUrl: c.youtubeUrl,
                    questionCount: c.questionCount,
                    questionsAvailableAt: c.questionsAvailableAt,
                    questionsLockAt: c.questionsLockAt,
                    regCloseTime: c.regCloseTime || null,
                    sponsorName: c.sponsorName,
                    sponsorLogo: c.sponsorLogo,
                    maxEntriesPerUser: c.maxEntriesPerUser,
                    hasJoined: c.entries.length > 0,
                    displayStatus: getContestDisplayStatus(c.status, c.regCloseTime, match.status),
                };
            })
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
        const entryType = contest.entryType || 'FREE';
        if (entryType === 'TICKET') {
            const ticketCost = contest.ticketCost || 1;
            const { spendTickets } = await Promise.resolve().then(() => __importStar(require('../services/ticketService')));
            const result = await spendTickets(userId, ticketCost, `Contest entry: ${contest.name}`, contestId);
            if (!result.success) {
                (0, response_1.error)(res, result.error || 'Insufficient tickets!', 400);
                return;
            }
        }
        else if (entryType === 'COINS') {
            const entryFee = contest.entryFee || 0;
            if (entryFee > 0) {
                const user = await database_1.prisma.user.findUnique({ where: { id: userId }, select: { coinBalance: true } });
                if (!user || user.coinBalance < entryFee) {
                    (0, response_1.error)(res, 'Insufficient coins!', 400);
                    return;
                }
                await database_1.prisma.user.update({ where: { id: userId }, data: { coinBalance: { decrement: entryFee } } });
                await database_1.prisma.transaction.create({
                    data: { userId, type: client_1.TransactionType.SPEND_IPL_ENTRY, amount: entryFee, refId: contestId, description: `Joined: ${contest.name}`, status: 'completed' },
                });
            }
        }
        // FREE — no deduction needed
        await database_1.prisma.$transaction([
            database_1.prisma.iplContestEntry.create({
                data: { userId, contestId, matchId: contest.matchId, coinsDeducted: entryType === 'COINS' ? (contest.entryFee || 0) : 0 },
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
            entryType,
            ticketsSpent: entryType === 'TICKET' ? (contest.ticketCost || 1) : 0,
            coinsSpent: entryType === 'COINS' ? (contest.entryFee || 0) : 0,
            questionsAvailable,
            questionsAvailableAt: contest.questionsAvailableAt,
            questionCount,
            matchId: contest.matchId,
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
        const enriched = enrichMatch(contest.match, await getTeamLogoUrls());
        (0, response_1.success)(res, {
            leaderboard,
            totalEntries: entries.length,
            contestName: contest.name,
            matchName: `${contest.match.team1} vs ${contest.match.team2}`,
            team1Logo: enriched.team1Logo,
            team1Color: enriched.team1Color,
            team2Logo: enriched.team2Logo,
            team2Color: enriched.team2Color,
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
    const matchId = req.query.matchId;
    try {
        const where = { userId };
        if (matchId)
            where.contest = { matchId };
        const entries = await database_1.prisma.iplContestEntry.findMany({
            where,
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
        // Count user predictions per matchId in bulk
        const matchIds = [...new Set(entries.map(e => e.contest.matchId))];
        const predictionCounts = matchIds.length > 0
            ? await database_1.prisma.iplPrediction.groupBy({
                by: ['matchId'],
                where: { userId, matchId: { in: matchIds } },
                _count: { id: true },
            })
            : [];
        const predCountMap = new Map(predictionCounts.map(p => [p.matchId, p._count.id]));
        const result = entries.map(entry => {
            const contest = entry.contest;
            const questionsAvailable = !contest.questionsAvailableAt || contest.questionsAvailableAt <= now;
            const predictionsLocked = !!contest.questionsLockAt && contest.questionsLockAt <= now;
            const predictionCount = predCountMap.get(contest.matchId) || 0;
            let contestState = 'JOINED';
            if (!questionsAvailable) {
                contestState = 'WAITING_QUESTIONS';
            }
            else if (questionsAvailable && predictionCount === 0) {
                contestState = 'PREDICT_NOW';
            }
            else if (predictionCount > 0 && !predictionsLocked) {
                contestState = 'PREDICTED_CAN_EDIT';
            }
            else if (predictionCount > 0 && predictionsLocked) {
                contestState = 'WAITING_RESULT';
            }
            if (contest.status === 'completed') {
                contestState = (entry.coinsWon > 0 || (entry.rank !== null && entry.rank <= 3))
                    ? 'WON' : 'COMPLETED';
            }
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
                ...(() => { const e = enrichMatch(contest.match, _logoCache); return { matchTeam1Logo: e.team1Logo, matchTeam1Color: e.team1Color, matchTeam2Logo: e.team2Logo, matchTeam2Color: e.team2Color }; })(),
                matchDate: contest.match.matchDate,
                matchStatus: contest.match.status,
                result: contest.match.result,
                youtubeUrl: contest.match.youtubeUrl,
                joinedAt: entry.joinedAt,
                questionsAvailable,
                questionsAvailableAt: contest.questionsAvailableAt,
                predictionsLocked,
                questionsLockAt: contest.questionsLockAt,
                predictionCount,
                contestState,
                questionCount: contest.questionCount ?? 0,
                regCloseTime: contest.regCloseTime,
                displayStatus: getContestDisplayStatus(contest.status, contest.regCloseTime, contest.match.status),
            };
        });
        const active = result.filter(e => e.displayStatus === 'OPEN');
        const pending = result.filter(e => e.displayStatus === 'LOCKED');
        const completed = result.filter(e => e.displayStatus === 'COMPLETED' || e.status === 'completed');
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
function maskName(name) {
    if (!name)
        return 'User***';
    const parts = name.trim().split(' ');
    return parts.map((p, i) => i === 0
        ? p.charAt(0).toUpperCase() + '*'.repeat(Math.min(p.length - 1, 3))
        : p.charAt(0).toUpperCase() + '***').join(' ');
}
async function getGlobalLeaderboard(req, res) {
    const userId = req.userId;
    const page = parseInt(String(req.query.page)) || 1;
    const limit = 50;
    try {
        const topEntries = await database_1.prisma.iplContestEntry.groupBy({
            by: ['userId'],
            _sum: { totalPoints: true, coinsWon: true },
            _count: { id: true },
            orderBy: { _sum: { totalPoints: 'desc' } },
            take: limit,
            skip: (page - 1) * limit,
        });
        // ── Fallback: no contest entries yet — rank by coin balance ──────────────
        if (topEntries.length === 0) {
            const users = await database_1.prisma.user.findMany({
                where: { status: 'ACTIVE' },
                select: { id: true, name: true, coinBalance: true, favouriteTeam: true },
                orderBy: { coinBalance: 'desc' },
                take: limit,
            });
            const leaderboard = users.map((u, i) => ({
                rank: i + 1,
                userId: u.id,
                name: maskName(u.name || 'User'),
                avatar: (u.name?.charAt(0) ?? 'U').toUpperCase(),
                favouriteTeam: u.favouriteTeam,
                totalPoints: 0,
                coinsWon: u.coinBalance,
                contestsPlayed: 0,
                isCurrentUser: u.id === userId,
            }));
            const userRank = leaderboard.findIndex(p => p.userId === userId) + 1;
            (0, response_1.success)(res, { leaderboard, userRank: userRank || null, totalPlayers: users.length });
            return;
        }
        const userIds = topEntries.map(e => e.userId);
        const users = await database_1.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, favouriteTeam: true },
        });
        const userMap = new Map(users.map(u => [u.id, u]));
        const leaderboard = topEntries.map((entry, i) => {
            const u = userMap.get(entry.userId);
            return {
                rank: (page - 1) * limit + i + 1,
                userId: entry.userId,
                name: maskName(u?.name || 'User'),
                avatar: (u?.name?.charAt(0) ?? 'U').toUpperCase(),
                favouriteTeam: u?.favouriteTeam ?? null,
                totalPoints: entry._sum.totalPoints ?? 0,
                coinsWon: entry._sum.coinsWon ?? 0,
                contestsPlayed: entry._count.id,
                isCurrentUser: entry.userId === userId,
            };
        });
        const userRank = leaderboard.findIndex(p => p.userId === userId) + 1;
        (0, response_1.success)(res, { leaderboard, userRank: userRank || null, totalPlayers: leaderboard.length });
    }
    catch (err) {
        logger_1.logger.error('getGlobalLeaderboard error:', err);
        (0, response_1.error)(res, 'Failed to fetch leaderboard', 500);
    }
}
