"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const validate_1 = require("../middleware/validate");
const auth_1 = require("../middleware/auth");
const iplController_1 = require("../controllers/iplController");
const iplAppController_1 = require("../controllers/iplAppController");
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const router = (0, express_1.Router)();
const predictSchema = zod_1.z.object({
    matchId: zod_1.z.string().cuid(),
    questionId: zod_1.z.string().cuid(),
    answer: zod_1.z.string().min(1),
});
const joinSchema = zod_1.z.object({
    matchId: zod_1.z.string().min(1),
    entryFee: zod_1.z.number().int().positive(),
});
// ─── App-facing routes ────────────────────────────────────────────────────────
router.get('/matches', auth_1.optionalAuthMiddleware, iplAppController_1.getMatchesForApp);
router.post('/contests/:contestId/join', auth_1.authMiddleware, iplAppController_1.joinContest);
router.get('/contests/:contestId/questions', auth_1.authMiddleware, iplAppController_1.getContestQuestions);
router.post('/contests/:contestId/predict', auth_1.authMiddleware, iplAppController_1.savePredictions);
router.get('/contests/:contestId/leaderboard', auth_1.optionalAuthMiddleware, iplAppController_1.getContestLeaderboard);
router.get('/my-contests', auth_1.authMiddleware, iplAppController_1.getMyContests);
router.get('/contests/:contestId/my-predictions', auth_1.authMiddleware, iplAppController_1.getMyPredictions);
router.get('/global-leaderboard', auth_1.optionalAuthMiddleware, iplAppController_1.getGlobalLeaderboard);
router.get('/matches/:matchId/contests', auth_1.optionalAuthMiddleware, async (req, res) => {
    const { matchId } = req.params;
    const userId = req.userId;
    const contests = await database_1.prisma.iplContest.findMany({
        where: { matchId, status: 'published' },
        include: {
            _count: { select: { entries: true } },
            entries: userId ? { where: { userId }, take: 1 } : { take: 0 },
        },
        orderBy: [{ battleType: 'asc' }],
    });
    const result = contests
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
            rank1Prize: (0, iplAppController_1.getRank1Prize)({ prizeTiersConfig: allTiers }),
            totalPrizePool: (0, iplAppController_1.calcTotalPrizePool)(allTiers),
            youtubeUrl: c.youtubeUrl,
            questionCount: c.questionCount,
            questionsAvailableAt: c.questionsAvailableAt,
            questionsLockAt: c.questionsLockAt,
            regCloseTime: c.regCloseTime || null,
            sponsorName: c.sponsorName,
            sponsorLogo: c.sponsorLogo,
            hasJoined: userId ? c.entries.length > 0 : false,
            displayStatus: (() => {
                const rc = c.regCloseTime;
                if (c.status === 'completed')
                    return 'COMPLETED';
                if (rc && new Date() > new Date(rc))
                    return 'LOCKED';
                return 'OPEN';
            })(),
        };
    })
        .sort((a, b) => {
        if (a.battleType === 'MEGA' && b.battleType !== 'MEGA')
            return -1;
        if (b.battleType === 'MEGA' && a.battleType !== 'MEGA')
            return 1;
        return 0;
    });
    return (0, response_1.success)(res, result);
});
// ─── Existing / legacy routes ─────────────────────────────────────────────────
router.post('/join', auth_1.authMiddleware, (0, validate_1.validate)(joinSchema), iplController_1.joinIPLContest);
router.get('/matches/:id/contests', iplController_1.getMatchContestsForUser);
router.get('/matches/:id', iplController_1.getMatch);
router.post('/predict', auth_1.authMiddleware, (0, validate_1.validate)(predictSchema), iplController_1.predict);
router.get('/leaderboard', iplController_1.iplLeaderboard);
router.get('/my-predictions', auth_1.authMiddleware, iplController_1.myPredictions);
router.get('/my-rank', auth_1.authMiddleware, iplController_1.myRank);
exports.default = router;
