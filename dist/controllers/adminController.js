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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdminUsers = getAdminUsers;
exports.getUserDetails = getUserDetails;
exports.updateUserStatus = updateUserStatus;
exports.adjustUserCoins = adjustUserCoins;
exports.getAdminTransactions = getAdminTransactions;
exports.exportTransactionsCSV = exportTransactionsCSV;
exports.adminLogin = adminLogin;
exports.getDashboard = getDashboard;
exports.getDashboardStats = getDashboardStats;
exports.listGames = listGames;
exports.createGame = createGame;
exports.updateGame = updateGame;
exports.listContests = listContests;
exports.createContest = createContest;
exports.updateContest = updateContest;
exports.finalizeContestAdmin = finalizeContestAdmin;
exports.listUsers = listUsers;
exports.updateUser = updateUser;
exports.listClaims = listClaims;
exports.updateClaim = updateClaim;
exports.listAdminMatches = listAdminMatches;
exports.generateQuestionsForMatch = generateQuestionsForMatch;
exports.publishContest = publishContest;
exports.processResults = processResults;
exports.getIplAnalytics = getIplAnalytics;
exports.getMatchParticipants = getMatchParticipants;
exports.getMatchQuestions = getMatchQuestions;
exports.updateMatchQuestions = updateMatchQuestions;
exports.deleteIplQuestion = deleteIplQuestion;
exports.createIplMatch = createIplMatch;
exports.setMatchResult = setMatchResult;
exports.triggerQuizGeneration = triggerQuizGeneration;
exports.triggerResultVerification = triggerResultVerification;
exports.createIplQuestion = createIplQuestion;
const database_1 = require("../config/database");
const iplService_1 = require("../services/iplService");
const contestService_1 = require("../services/contestService");
const response_1 = require("../utils/response");
const query_1 = require("../utils/query");
const client_1 = require("@prisma/client");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const iplQuizJob_1 = require("../jobs/iplQuizJob");
// ─── Admin Users (rich list with tx count) ────────────────────────────────────
async function getAdminUsers(req, res) {
    try {
        const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
        const limit = Math.min(100, parseInt(String(req.query.limit || '50'), 10));
        const search = req.query.search ? String(req.query.search) : undefined;
        const status = req.query.status && req.query.status !== 'all' ? String(req.query.status) : undefined;
        const where = {};
        if (status)
            where.status = status;
        if (search) {
            where.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search } },
                { email: { contains: search, mode: 'insensitive' } },
            ];
        }
        const [users, total] = await Promise.all([
            database_1.prisma.user.findMany({
                where,
                select: {
                    id: true, name: true, phone: true, email: true,
                    coinBalance: true, status: true, createdAt: true,
                    _count: { select: { transactions: true } },
                },
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            database_1.prisma.user.count({ where }),
        ]);
        (0, response_1.success)(res, { users, total, page, pages: Math.ceil(total / limit) });
    }
    catch (err) {
        logger_1.logger.error('getAdminUsers error:', err);
        (0, response_1.error)(res, 'Failed to get users', 500);
    }
}
// ─── Admin Users — Single user detail ─────────────────────────────────────────
async function getUserDetails(req, res) {
    try {
        const { userId } = req.params;
        const user = await database_1.prisma.user.findUnique({
            where: { id: userId },
            include: {
                transactions: { orderBy: { createdAt: 'desc' }, take: 20 },
            },
        });
        if (!user) {
            (0, response_1.error)(res, 'User not found', 404);
            return;
        }
        (0, response_1.success)(res, user);
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed', 500);
    }
}
// ─── Admin Users — Status update ──────────────────────────────────────────────
async function updateUserStatus(req, res) {
    try {
        const { userId } = req.params;
        const { status } = req.body;
        const user = await database_1.prisma.user.update({ where: { id: userId }, data: { status } });
        (0, response_1.success)(res, user, `User ${status}!`);
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed', 500);
    }
}
// ─── Admin Users — Adjust coins ───────────────────────────────────────────────
async function adjustUserCoins(req, res) {
    try {
        const { userId } = req.params;
        const { action, amount, reason } = req.body;
        if (!amount || amount <= 0) {
            (0, response_1.error)(res, 'Valid amount required', 400);
            return;
        }
        const user = await database_1.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, coinBalance: true },
        });
        if (!user) {
            (0, response_1.error)(res, 'User not found', 404);
            return;
        }
        const coinChange = action === 'add' ? parseInt(String(amount)) : -parseInt(String(amount));
        if (action === 'deduct' && user.coinBalance < parseInt(String(amount))) {
            (0, response_1.error)(res, 'User has insufficient coins', 400);
            return;
        }
        await database_1.prisma.$transaction([
            database_1.prisma.user.update({
                where: { id: userId },
                data: { coinBalance: { increment: coinChange } },
            }),
            database_1.prisma.transaction.create({
                data: {
                    userId,
                    type: action === 'add' ? client_1.TransactionType.ADMIN_CREDIT : client_1.TransactionType.ADMIN_DEBIT,
                    amount: coinChange,
                    description: reason || `Admin ${action}: ${amount} coins`,
                    status: 'completed',
                },
            }),
        ]);
        const updated = await database_1.prisma.user.findUnique({
            where: { id: userId },
            select: { coinBalance: true },
        });
        (0, response_1.success)(res, { newBalance: updated?.coinBalance, coinChange }, `${action === 'add' ? 'Added' : 'Deducted'} ${amount} coins!`);
    }
    catch (err) {
        logger_1.logger.error('adjustUserCoins error:', err);
        (0, response_1.error)(res, 'Failed to adjust coins', 500);
    }
}
// ─── Admin Transactions — List ─────────────────────────────────────────────────
async function getAdminTransactions(req, res) {
    try {
        const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
        const limit = Math.min(100, parseInt(String(req.query.limit || '50'), 10));
        const type = req.query.type && req.query.type !== 'all' ? String(req.query.type) : undefined;
        const userId = req.query.userId ? String(req.query.userId) : undefined;
        const search = req.query.search ? String(req.query.search) : undefined;
        const where = {};
        if (type)
            where.type = type;
        if (userId)
            where.userId = userId;
        if (search) {
            where.user = {
                OR: [
                    { name: { contains: search, mode: 'insensitive' } },
                    { phone: { contains: search } },
                    { email: { contains: search, mode: 'insensitive' } },
                ],
            };
        }
        const [transactions, total] = await Promise.all([
            database_1.prisma.transaction.findMany({
                where,
                include: {
                    user: { select: { id: true, name: true, phone: true, email: true, coinBalance: true } },
                },
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            database_1.prisma.transaction.count({ where }),
        ]);
        (0, response_1.success)(res, { transactions, total, page, pages: Math.ceil(total / limit) });
    }
    catch (err) {
        logger_1.logger.error('getAdminTransactions error:', err);
        (0, response_1.error)(res, 'Failed to get transactions', 500);
    }
}
// ─── Admin Transactions — CSV Export ──────────────────────────────────────────
async function exportTransactionsCSV(req, res) {
    try {
        const transactions = await database_1.prisma.transaction.findMany({
            include: { user: { select: { name: true, phone: true } } },
            orderBy: { createdAt: 'desc' },
            take: 10000,
        });
        const csv = [
            'ID,User,Phone,Type,Amount,Description,Date',
            ...transactions.map(t => `${t.id},${t.user?.name || ''},${t.user?.phone || ''},${t.type},${t.amount},"${t.description || ''}",${t.createdAt}`),
        ].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=transactions.csv');
        res.send(csv);
    }
    catch (err) {
        (0, response_1.error)(res, 'Export failed', 500);
    }
}
// ─── Auth ─────────────────────────────────────────────────────────────────────
async function adminLogin(req, res) {
    const { email, password } = req.body;
    if (!email || !password) {
        (0, response_1.error)(res, 'Email and password required', 400);
        return;
    }
    const admin = await database_1.prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } });
    if (!admin) {
        (0, response_1.error)(res, 'Invalid credentials', 401);
        return;
    }
    const validPassword = await bcryptjs_1.default.compare(password, admin.passwordHash);
    if (!validPassword) {
        (0, response_1.error)(res, 'Invalid credentials', 401);
        return;
    }
    const token = jsonwebtoken_1.default.sign({ id: admin.id, email: admin.email, role: admin.role }, env_1.env.JWT_SECRET, { expiresIn: '7d' });
    (0, response_1.success)(res, {
        token,
        admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
    }, 'Login successful');
}
// ─── Dashboard (simple) ───────────────────────────────────────────────────────
async function getDashboard(_req, res) {
    const [totalUsers, activeContests, pendingClaims, txnToday] = await Promise.all([
        database_1.prisma.user.count(),
        database_1.prisma.contest.count({
            where: { status: { in: [client_1.ContestStatus.REGISTRATION_OPEN, client_1.ContestStatus.GAMEPLAY_ACTIVE] } },
        }),
        database_1.prisma.prizeClaim.count({ where: { status: 'PENDING' } }),
        database_1.prisma.transaction.count({
            where: { createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
        }),
    ]);
    (0, response_1.success)(res, { totalUsers, activeContests, pendingClaims, txnToday });
}
// ─── Dashboard Stats (rich) ───────────────────────────────────────────────────
async function getDashboardStats(_req, res) {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const EARN_TYPES = [
            client_1.TransactionType.EARN_TASK,
            client_1.TransactionType.EARN_SURVEY,
            client_1.TransactionType.EARN_OFFERWALL,
            client_1.TransactionType.EARN_REFERRAL,
            client_1.TransactionType.EARN_BONUS,
            client_1.TransactionType.EARN_DAILY,
            client_1.TransactionType.EARN_CONTEST_WIN,
            client_1.TransactionType.EARN_IPL_WIN,
        ];
        const [totalUsers, activeUsers, newUsersToday, totalTransactions, coinsDistributedToday, totalCoinsDistributed, activeContests, pendingClaims, offerwallToday, surveyToday,] = await Promise.all([
            database_1.prisma.user.count(),
            database_1.prisma.user.count({ where: { coinBalance: { gt: 0 } } }),
            database_1.prisma.user.count({ where: { createdAt: { gte: today } } }),
            database_1.prisma.transaction.count(),
            database_1.prisma.transaction.aggregate({
                where: { createdAt: { gte: today }, type: { in: EARN_TYPES } },
                _sum: { amount: true },
            }),
            database_1.prisma.transaction.aggregate({
                where: { type: { in: EARN_TYPES } },
                _sum: { amount: true },
            }),
            database_1.prisma.contest.count({
                where: { status: { in: [client_1.ContestStatus.REGISTRATION_OPEN, client_1.ContestStatus.GAMEPLAY_ACTIVE] } },
            }).catch(() => 0),
            database_1.prisma.prizeClaim.count({ where: { status: 'PENDING' } }).catch(() => 0),
            database_1.prisma.offerwallLog.aggregate({
                where: { createdAt: { gte: today }, provider: { not: 'cpx' } },
                _sum: { coinsAwarded: true },
            }).catch(() => ({ _sum: { coinsAwarded: 0 } })),
            database_1.prisma.offerwallLog.aggregate({
                where: { createdAt: { gte: today }, provider: 'cpx' },
                _sum: { coinsAwarded: true },
            }).catch(() => ({ _sum: { coinsAwarded: 0 } })),
        ]);
        const recentTransactions = await database_1.prisma.transaction.findMany({
            take: 10,
            orderBy: { createdAt: 'desc' },
            include: { user: { select: { name: true, phone: true } } },
        }).catch(() => []);
        (0, response_1.success)(res, {
            users: {
                total: totalUsers,
                active: activeUsers,
                newToday: newUsersToday,
            },
            revenue: {
                coinsToday: coinsDistributedToday._sum.amount || 0,
                coinsTotal: totalCoinsDistributed._sum.amount || 0,
                offerwallToday: offerwallToday._sum.coinsAwarded || 0,
                surveyToday: surveyToday._sum.coinsAwarded || 0,
            },
            contests: { active: activeContests },
            claims: { pending: pendingClaims },
            transactions: totalTransactions,
            recentTransactions,
        });
    }
    catch (err) {
        logger_1.logger.error('getDashboardStats error:', err);
        (0, response_1.error)(res, 'Failed to fetch dashboard stats', 500);
    }
}
// ─── Games ────────────────────────────────────────────────────────────────────
async function listGames(_req, res) {
    const games = await database_1.prisma.game.findMany({ orderBy: { createdAt: 'desc' } });
    (0, response_1.success)(res, games);
}
async function createGame(req, res) {
    const { name, description, icon, gameUrl, gameHtml, category } = req.body;
    const game = await database_1.prisma.game.create({
        data: { name, description, icon, gameUrl, gameHtml, category: category ?? 'general' },
    });
    (0, response_1.success)(res, game, 'Game created', 201);
}
async function updateGame(req, res) {
    const { name, description, icon, gameUrl, gameHtml, category, isActive } = req.body;
    const game = await database_1.prisma.game.update({
        where: { id: req.params.id },
        data: { name, description, icon, gameUrl, gameHtml, category, isActive },
    });
    (0, response_1.success)(res, game, 'Game updated');
}
// ─── Contests ─────────────────────────────────────────────────────────────────
async function listContests(req, res) {
    const page = parseInt((0, query_1.qs)(req.query.page) ?? '1', 10);
    const limit = Math.min(parseInt((0, query_1.qs)(req.query.limit) ?? '20', 10), 100);
    const skip = (page - 1) * limit;
    const [contests, total] = await Promise.all([
        database_1.prisma.contest.findMany({
            include: { game: true },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        database_1.prisma.contest.count(),
    ]);
    (0, response_1.paginated)(res, contests, total, page, limit);
}
async function createContest(req, res) {
    const body = req.body;
    const contest = await database_1.prisma.contest.create({
        data: {
            gameId: body.gameId,
            name: body.name,
            type: body.type,
            entryFee: body.entryFee,
            maxPlayers: body.maxPlayers,
            minPlayers: body.minPlayers ?? 2,
            regStartTime: new Date(body.regStartTime),
            regEndTime: new Date(body.regEndTime),
            gameStartTime: new Date(body.gameStartTime),
            gameEndTime: new Date(body.gameEndTime),
            prizeType: body.prizeType ?? client_1.PrizeType.COINS,
            totalPrizePool: body.totalPrizePool ?? 0,
            prizeDistribution: body.prizeDistribution,
            status: client_1.ContestStatus.DRAFT,
        },
    });
    (0, response_1.success)(res, contest, 'Contest created', 201);
}
async function updateContest(req, res) {
    const body = req.body;
    const contest = await database_1.prisma.contest.update({
        where: { id: req.params.id },
        data: body,
    });
    (0, response_1.success)(res, contest, 'Contest updated');
}
async function finalizeContestAdmin(req, res) {
    try {
        await (0, contestService_1.finalizeContest)(req.params.id);
        (0, response_1.success)(res, null, 'Contest finalized');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'Finalization failed';
        (0, response_1.error)(res, msg, 400);
    }
}
// ─── Users ────────────────────────────────────────────────────────────────────
async function listUsers(req, res) {
    const page = parseInt((0, query_1.qs)(req.query.page) ?? '1', 10);
    const limit = Math.min(parseInt((0, query_1.qs)(req.query.limit) ?? '20', 10), 100);
    const skip = (page - 1) * limit;
    const search = (0, query_1.qs)(req.query.search);
    const where = search
        ? {
            OR: [
                { name: { contains: search } },
                { email: { contains: search } },
                { phone: { contains: search } },
            ],
        }
        : {};
    const [users, total] = await Promise.all([
        database_1.prisma.user.findMany({
            where,
            select: {
                id: true, name: true, email: true, phone: true,
                coinBalance: true, status: true, createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        database_1.prisma.user.count({ where }),
    ]);
    (0, response_1.paginated)(res, users, total, page, limit);
}
async function updateUser(req, res) {
    const { status, coinBalance } = req.body;
    const user = await database_1.prisma.user.update({
        where: { id: req.params.id },
        data: { status, coinBalance },
        select: { id: true, name: true, status: true, coinBalance: true },
    });
    (0, response_1.success)(res, user, 'User updated');
}
// ─── Claims ───────────────────────────────────────────────────────────────────
async function listClaims(req, res) {
    const page = parseInt((0, query_1.qs)(req.query.page) ?? '1', 10);
    const limit = Math.min(parseInt((0, query_1.qs)(req.query.limit) ?? '20', 10), 100);
    const skip = (page - 1) * limit;
    const [claims, total] = await Promise.all([
        database_1.prisma.prizeClaim.findMany({
            include: {
                user: { select: { id: true, name: true } },
                contest: { select: { name: true } },
            },
            orderBy: { claimedAt: 'desc' },
            skip,
            take: limit,
        }),
        database_1.prisma.prizeClaim.count(),
    ]);
    (0, response_1.paginated)(res, claims, total, page, limit);
}
async function updateClaim(req, res) {
    const { status, trackingInfo, giftCode } = req.body;
    const claim = await database_1.prisma.prizeClaim.update({
        where: { id: req.params.id },
        data: { status, trackingInfo, giftCode },
    });
    (0, response_1.success)(res, claim, 'Claim updated');
}
// ─── IPL Admin — List matches with contest data ───────────────────────────────
async function listAdminMatches(req, res) {
    const status = (0, query_1.qs)(req.query.status);
    const search = (0, query_1.qs)(req.query.search);
    const page = parseInt((0, query_1.qs)(req.query.page) ?? '1', 10);
    const limit = Math.min(parseInt((0, query_1.qs)(req.query.limit) ?? '50', 10), 100);
    const skip = (page - 1) * limit;
    const where = {};
    if (status && status !== 'all')
        where.contestStatus = status;
    if (search) {
        where.OR = [
            { team1: { contains: search, mode: 'insensitive' } },
            { team2: { contains: search, mode: 'insensitive' } },
            { venue: { contains: search, mode: 'insensitive' } },
        ];
    }
    const [matches, total] = await Promise.all([
        database_1.prisma.iplMatch.findMany({
            where,
            include: {
                questions: { select: { id: true, question: true, category: true, difficulty: true, isAutoGenerated: true, approved: true, options: true, correctAnswer: true, points: true, matchId: true, status: true } },
                _count: { select: { predictions: true } },
            },
            orderBy: { matchDate: 'asc' },
            skip,
            take: limit,
        }),
        database_1.prisma.iplMatch.count({ where }),
    ]);
    (0, response_1.paginated)(res, matches, total, page, limit);
}
// ─── IPL Admin — Generate questions for a specific match ─────────────────────
async function generateQuestionsForMatch(req, res) {
    const { matchId } = req.body;
    if (matchId) {
        // Generate for a specific match
        const match = await database_1.prisma.iplMatch.findUnique({ where: { id: matchId } });
        if (!match) {
            (0, response_1.error)(res, 'Match not found', 404);
            return;
        }
        const { generateIPLQuestions } = await Promise.resolve().then(() => __importStar(require('../services/claudeAiService')));
        const questions = await generateIPLQuestions({
            team1: match.team1, team2: match.team2,
            date: match.matchDate.toDateString(), venue: match.venue ?? 'TBD',
        });
        const created = await Promise.all(questions.map(q => database_1.prisma.iplQuestion.create({
            data: {
                matchId: match.id, question: q.question, options: q.options,
                correctAnswer: q.correctAnswer ?? '', points: q.points ?? 100,
                category: q.category ?? 'prediction', difficulty: q.difficulty ?? 'medium',
                status: 'active', isAutoGenerated: true, generatedBy: 'claude-ai', approved: false,
            },
        })));
        await database_1.prisma.iplMatch.update({ where: { id: matchId }, data: { contestStatus: 'questions_ready' } });
        (0, response_1.success)(res, { questions: created }, `Generated ${created.length} questions`);
        return;
    }
    // Fallback: generate for all today's matches (original behavior)
    try {
        const count = await (0, iplQuizJob_1.generateQuestionsForTodayMatches)();
        (0, response_1.success)(res, { questionsGenerated: count }, `Generated ${count} questions for today's matches`);
    }
    catch (err) {
        logger_1.logger.error('Manual quiz generation failed:', err);
        const msg = err instanceof Error ? err.message : 'Quiz generation failed';
        (0, response_1.error)(res, msg, 500);
    }
}
// ─── IPL Admin — Publish contest ──────────────────────────────────────────────
async function publishContest(req, res) {
    const { matchId, entryFee, maxPlayers, minPlayers, regCloseTime, prizeDistribution } = req.body;
    const match = await database_1.prisma.iplMatch.findUnique({ where: { id: matchId } });
    if (!match) {
        (0, response_1.error)(res, 'Match not found', 404);
        return;
    }
    const updated = await database_1.prisma.iplMatch.update({
        where: { id: matchId },
        data: {
            entryFee, maxPlayers, minPlayers,
            regCloseTime: regCloseTime ? new Date(regCloseTime) : undefined,
            prizeDistribution: prizeDistribution,
            contestStatus: 'published',
        },
    });
    // Send push notifications (best effort)
    try {
        const { sendToAll } = await Promise.resolve().then(() => __importStar(require('../services/notificationService')));
        await sendToAll('🏏 New IPL Contest Live!', `${match.team1} vs ${match.team2} — Join now for 🪙${entryFee} coins entry!`, 'ipl_contest_published');
    }
    catch (notifErr) {
        logger_1.logger.warn('Failed to send publish notifications:', notifErr);
    }
    (0, response_1.success)(res, { match: updated }, 'Contest published successfully');
}
// ─── IPL Admin — Process results with full coin crediting ────────────────────
async function processResults(req, res) {
    const { matchId, winner, team1Score, team2Score, manOfMatch, answers } = req.body;
    const match = await database_1.prisma.iplMatch.findUnique({
        where: { id: matchId },
        include: { questions: true },
    });
    if (!match) {
        (0, response_1.error)(res, 'Match not found', 404);
        return;
    }
    // Step 1: Update match result
    await database_1.prisma.iplMatch.update({
        where: { id: matchId },
        data: {
            result: winner, winnerId: winner,
            team1Score, team2Score, manOfMatch,
            status: 'completed', contestStatus: 'processing',
        },
    });
    // Step 2: Set correct answers on questions
    const finalAnswers = { ...answers };
    if (Object.keys(finalAnswers).length === 0) {
        // Use Claude AI to verify if no manual answers provided
        try {
            const { verifyAnswersWithAI } = await Promise.resolve().then(() => __importStar(require('../services/claudeAiService')));
            const verified = await verifyAnswersWithAI(match.questions, {
                winner, manOfMatch, team1Score: undefined, team2Score: undefined,
            });
            for (const q of verified) {
                if (q.id && q.correctAnswer)
                    finalAnswers[q.id] = q.correctAnswer;
            }
        }
        catch (aiErr) {
            logger_1.logger.warn('AI verification failed, using manual answers:', aiErr);
        }
    }
    // Step 3: Score all predictions
    let winnersCount = 0;
    let totalCredited = 0;
    for (const [questionId, correctAnswer] of Object.entries(finalAnswers)) {
        await database_1.prisma.iplQuestion.update({
            where: { id: questionId },
            data: { correctAnswer, status: 'closed' },
        });
        const question = match.questions.find(q => q.id === questionId);
        if (!question)
            continue;
        const predictions = await database_1.prisma.iplPrediction.findMany({ where: { questionId } });
        for (const pred of predictions) {
            const isCorrect = pred.answer === correctAnswer;
            const pointsEarned = isCorrect ? question.points : 0;
            await database_1.prisma.iplPrediction.update({
                where: { id: pred.id },
                data: { isCorrect, pointsEarned },
            });
            if (isCorrect && pointsEarned > 0) {
                const { creditCoins } = await Promise.resolve().then(() => __importStar(require('../services/coinService')));
                const { TransactionType } = await Promise.resolve().then(() => __importStar(require('@prisma/client')));
                await creditCoins(pred.userId, pointsEarned, TransactionType.EARN_IPL_WIN, pred.id, `IPL prediction correct: ${question.question}`);
                winnersCount++;
                totalCredited += pointsEarned;
            }
        }
    }
    // Step 4: Mark completed
    await database_1.prisma.iplMatch.update({ where: { id: matchId }, data: { contestStatus: 'completed' } });
    // Step 5: Notify participants (best effort)
    try {
        const { sendToAll } = await Promise.resolve().then(() => __importStar(require('../services/notificationService')));
        await sendToAll('🏆 IPL Match Results!', `${match.team1} vs ${match.team2} — Results processed! ${winnersCount} winners credited.`, 'ipl_results_processed');
    }
    catch (notifErr) {
        logger_1.logger.warn('Failed to send result notifications:', notifErr);
    }
    (0, response_1.success)(res, {
        summary: {
            winnersCount,
            totalCredited,
            matchId,
            winner,
            teamScores: { team1: team1Score, team2: team2Score },
            manOfMatch,
        },
    }, 'Results processed and coins credited');
}
// ─── IPL Admin — Season analytics ────────────────────────────────────────────
async function getIplAnalytics(_req, res) {
    const [matches, totalPredictions] = await Promise.all([
        database_1.prisma.iplMatch.findMany({
            include: { _count: { select: { predictions: true } } },
            orderBy: { matchDate: 'asc' },
        }),
        database_1.prisma.iplPrediction.count(),
    ]);
    const completedMatches = matches.filter(m => m.status === 'completed' || m.contestStatus === 'completed');
    const totalParticipants = completedMatches.reduce((s, m) => s + m._count.predictions, 0);
    // Revenue = entryFee * participants * 0.15 platform cut (approximate)
    const totalRevenue = completedMatches.reduce((s, m) => s + m.entryFee * m._count.predictions * 0.15, 0);
    const totalPrizePool = completedMatches.reduce((s, m) => s + m.entryFee * m._count.predictions * 0.85, 0);
    const avgFillRate = completedMatches.length > 0
        ? completedMatches.reduce((s, m) => s + (m.maxPlayers > 0 ? m._count.predictions / m.maxPlayers : 0), 0) / completedMatches.length * 100
        : 0;
    const bestMatch = completedMatches.reduce((best, m) => (!best || m._count.predictions > best._count.predictions) ? m : best, null);
    (0, response_1.success)(res, {
        totalMatches: completedMatches.length,
        totalParticipants,
        totalPredictions,
        totalRevenue: Math.round(totalRevenue),
        totalPrizePool: Math.round(totalPrizePool),
        avgFillRate: Math.round(avgFillRate),
        mostPopularMatch: bestMatch ? `${bestMatch.team1} vs ${bestMatch.team2}` : null,
        matches: matches.map(m => ({
            id: m.id, matchNumber: m.matchNumber,
            teams: `${m.team1} vs ${m.team2}`,
            participants: m._count.predictions,
            revenue: Math.round(m.entryFee * m._count.predictions * 0.15),
            fillRate: m.maxPlayers > 0 ? Math.round(m._count.predictions / m.maxPlayers * 100) : 0,
            status: m.contestStatus,
        })),
    });
}
// ─── IPL Admin — Match participants ──────────────────────────────────────────
async function getMatchParticipants(req, res) {
    const matchId = req.params.id;
    const match = await database_1.prisma.iplMatch.findUnique({ where: { id: matchId } });
    if (!match) {
        (0, response_1.error)(res, 'Match not found', 404);
        return;
    }
    const predictions = await database_1.prisma.iplPrediction.groupBy({
        by: ['userId'],
        where: { matchId },
        _sum: { pointsEarned: true },
        _count: { id: true },
        orderBy: { _sum: { pointsEarned: 'desc' } },
    });
    const userIds = predictions.map(p => p.userId);
    const users = await database_1.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true },
    });
    const userMap = new Map(users.map(u => [u.id, u.name]));
    const participants = predictions.map((p, i) => ({
        rank: i + 1,
        userId: p.userId,
        username: userMap.get(p.userId) ?? 'Unknown',
        score: p._sum.pointsEarned ?? 0,
        predictions: p._count.id,
    }));
    (0, response_1.success)(res, { participants, total: participants.length });
}
// ─── IPL Admin — Match questions CRUD ────────────────────────────────────────
async function getMatchQuestions(req, res) {
    const questions = await database_1.prisma.iplQuestion.findMany({
        where: { matchId: req.params.id },
        orderBy: { id: 'asc' },
    });
    (0, response_1.success)(res, questions);
}
async function updateMatchQuestions(req, res) {
    const matchId = req.params.id;
    const { questions } = req.body;
    for (const q of questions) {
        if (q.id.startsWith('new_') || q.id.startsWith('gen_')) {
            // Create new question
            await database_1.prisma.iplQuestion.create({
                data: {
                    matchId, question: q.question, options: q.options,
                    correctAnswer: q.correctAnswer ?? '', points: q.points,
                    category: q.category, difficulty: q.difficulty,
                    status: 'active', isAutoGenerated: false, approved: q.approved,
                },
            });
        }
        else {
            // Update existing
            await database_1.prisma.iplQuestion.update({
                where: { id: q.id },
                data: {
                    question: q.question, options: q.options,
                    correctAnswer: q.correctAnswer, points: q.points,
                    category: q.category, difficulty: q.difficulty, approved: q.approved,
                },
            });
        }
    }
    (0, response_1.success)(res, null, 'Questions updated');
}
async function deleteIplQuestion(req, res) {
    await database_1.prisma.iplQuestion.delete({ where: { id: req.params.qid } });
    (0, response_1.success)(res, null, 'Question deleted');
}
// ─── IPL Admin ────────────────────────────────────────────────────────────────
async function createIplMatch(req, res) {
    const { matchNumber, team1, team2, matchDate, venue, youtubeUrl, matchStartTime, registrationCloseTime, resultDeclareTime, } = req.body;
    if (team1 && team2 && team1 === team2) {
        (0, response_1.error)(res, 'Team 1 and Team 2 must be different!', 400);
        return;
    }
    const match = await database_1.prisma.iplMatch.create({
        data: {
            matchNumber: parseInt(String(matchNumber)) || 1,
            team1, team2,
            matchDate: new Date(matchDate),
            venue: venue || 'TBD',
            youtubeUrl: youtubeUrl || null,
            status: 'upcoming',
            matchStartTime: matchStartTime ? new Date(matchStartTime) : null,
            registrationCloseTime: registrationCloseTime ? new Date(registrationCloseTime) : null,
            resultDeclareTime: resultDeclareTime ? new Date(resultDeclareTime) : null,
        },
    });
    (0, response_1.success)(res, match, 'IPL match created', 201);
}
async function setMatchResult(req, res) {
    const { result, winnerId, answers } = req.body;
    await database_1.prisma.iplMatch.update({
        where: { id: req.params.id },
        data: { result, winnerId, status: 'completed' },
    });
    await (0, iplService_1.scoreMatch)(req.params.id, answers);
    (0, response_1.success)(res, null, 'Match result set and predictions scored');
}
// ─── AI Quiz Generation (Admin Manual Triggers) ───────────────────────────────
async function triggerQuizGeneration(_req, res) {
    try {
        const count = await (0, iplQuizJob_1.generateQuestionsForTodayMatches)();
        (0, response_1.success)(res, { questionsGenerated: count }, `Generated ${count} questions for today's matches`);
    }
    catch (err) {
        logger_1.logger.error('Manual quiz generation failed:', err);
        const msg = err instanceof Error ? err.message : 'Quiz generation failed';
        (0, response_1.error)(res, msg, 500);
    }
}
async function triggerResultVerification(req, res) {
    try {
        await (0, iplQuizJob_1.verifyMatchResults)(req.params.id);
        (0, response_1.success)(res, null, 'Match results verified and coins credited');
    }
    catch (err) {
        logger_1.logger.error('Manual result verification failed:', err);
        const msg = err instanceof Error ? err.message : 'Result verification failed';
        (0, response_1.error)(res, msg, 400);
    }
}
async function createIplQuestion(req, res) {
    const { matchId, question, options, points } = req.body;
    const q = await database_1.prisma.iplQuestion.create({
        data: { matchId, question, options, points: points ?? 100 },
    });
    (0, response_1.success)(res, q, 'Question created', 201);
}
