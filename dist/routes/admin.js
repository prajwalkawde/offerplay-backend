"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const validate_1 = require("../middleware/validate");
const adminAuth_1 = require("../middleware/adminAuth");
const adminController_1 = require("../controllers/adminController");
const iplAdminController_1 = require("../controllers/iplAdminController");
const offerwallAdminController_1 = require("../controllers/offerwallAdminController");
const inventoryController_1 = require("../controllers/inventoryController");
const coinRateController_1 = require("../controllers/coinRateController");
const settingsController_1 = require("../controllers/settingsController");
const redeemController_1 = require("../controllers/redeemController");
const xoxodayService_1 = require("../services/xoxodayService");
const streakController_1 = require("../controllers/streakController");
const upload_1 = require("../middleware/upload");
const router = (0, express_1.Router)();
const loginSchema = zod_1.z.object({ email: zod_1.z.string().email(), password: zod_1.z.string().min(6) });
// Public admin login (both paths for compatibility)
router.post('/auth/login', (0, validate_1.validate)(loginSchema), adminController_1.adminLogin);
router.post('/login', (0, validate_1.validate)(loginSchema), adminController_1.adminLogin);
// ─── Public: policy content for mobile app ────────────────────────────────────
router.get('/settings/policy/:type', async (req, res) => {
    try {
        const typeMap = {
            TERMS: 'POLICY_TERMS', PRIVACY: 'POLICY_PRIVACY', PAYMENT: 'POLICY_PAYMENT',
        };
        const key = typeMap[req.params.type];
        if (!key)
            return (0, response_1.error)(res, 'Not found', 404);
        const setting = await database_1.prisma.appSettings.findUnique({ where: { key } });
        return (0, response_1.success)(res, {
            type: req.params.type,
            title: setting?.label || 'Policy',
            content: setting?.value || 'Coming soon...',
            updatedAt: setting?.updatedAt,
        });
    }
    catch {
        return (0, response_1.error)(res, 'Failed', 500);
    }
});
// All routes below require admin JWT
router.use(adminAuth_1.adminAuthMiddleware);
router.get('/dashboard', adminController_1.getDashboard);
router.get('/dashboard/stats', adminController_1.getDashboardStats);
// Games
router.get('/games', adminController_1.listGames);
router.post('/games', adminController_1.createGame);
router.put('/games/:id', adminController_1.updateGame);
// Contests
router.get('/contests', adminController_1.listContests);
router.post('/contests', adminController_1.createContest);
router.put('/contests/:id', adminController_1.updateContest);
router.post('/contests/:id/finalize', adminController_1.finalizeContestAdmin);
// Users
router.get('/users', adminController_1.getAdminUsers);
router.post('/users/:userId/adjust-coins', adminController_1.adjustUserCoins);
router.get('/users/:userId', adminController_1.getUserDetails);
router.put('/users/:userId/status', adminController_1.updateUserStatus);
router.put('/users/:id', adminController_1.updateUser);
// Transactions
router.get('/transactions/export', adminController_1.exportTransactionsCSV);
router.get('/transactions', adminController_1.getAdminTransactions);
// Claims
router.get('/claims', adminController_1.listClaims);
router.put('/claims/:id', adminController_1.updateClaim);
// IPL — Matches
router.get('/ipl/matches', iplAdminController_1.getAdminIPLMatches);
router.post('/ipl/matches', iplAdminController_1.createAdminIPLMatch);
router.put('/ipl/matches/:id', iplAdminController_1.updateIPLMatch);
router.delete('/ipl/matches/:id', iplAdminController_1.deleteAdminIPLMatch);
router.post('/ipl/matches/:id/result', adminController_1.setMatchResult);
router.post('/ipl/matches/process-results', iplAdminController_1.processIPLResults);
// IPL — Questions
router.post('/ipl/questions', adminController_1.createIplQuestion);
router.get('/ipl/match/:id/questions', adminController_1.getMatchQuestions);
router.get('/ipl/matches/:id/questions', adminController_1.getMatchQuestions);
router.put('/ipl/match/:id/questions', adminController_1.updateMatchQuestions);
router.delete('/ipl/questions/:qid', adminController_1.deleteIplQuestion);
router.post('/ipl/matches/:matchId/save-questions', iplAdminController_1.saveEditedQuestions);
// IPL — Contest lifecycle
router.post('/ipl/generate-questions', iplAdminController_1.generateIPLQuestions);
router.post('/ipl/generate-result-report', iplAdminController_1.generateResultReport);
router.post('/ipl/publish-contest', adminController_1.publishContest);
router.post('/ipl/process-results', iplAdminController_1.processIPLResults);
// IPL — Analytics & participants
router.get('/ipl/analytics', iplAdminController_1.getIPLAnalytics);
router.get('/ipl/match/:id/participants', adminController_1.getMatchParticipants);
router.get('/ipl/matches/:id/participants', adminController_1.getMatchParticipants);
// IPL — Cricbuzz sync
router.get('/ipl/fetch-today', iplAdminController_1.fetchTodayMatches);
// IPL — Multi-contest per match
router.get('/ipl/matches/:matchId/contests', iplAdminController_1.getMatchContests);
router.post('/ipl/matches/:matchId/contests', iplAdminController_1.createIPLContest);
router.put('/ipl/contests/:contestId', iplAdminController_1.updateIPLContest);
router.delete('/ipl/contests/:contestId', iplAdminController_1.deleteIPLContest);
router.post('/ipl/contests/:contestId/publish', iplAdminController_1.publishIPLContest);
router.post('/ipl/contests/:contestId/process', iplAdminController_1.processIPLContestResults);
router.get('/ipl/contests/:contestId/participants', iplAdminController_1.getContestParticipants);
// Legacy AI triggers
router.post('/ipl/verify-results/:id', adminController_1.triggerResultVerification);
// ─── Cache Management ─────────────────────────────────────────────────────────
const redis_1 = require("../config/redis");
const database_1 = require("../config/database");
router.delete('/cache/clear', async (req, res) => {
    const [feedKeys, pubscaleKeys] = await Promise.all([
        redis_1.redis.keys('offer_feed:*'),
        redis_1.redis.keys('pubscale:*'),
    ]);
    const allKeys = [...feedKeys, ...pubscaleKeys];
    if (allKeys.length > 0)
        await redis_1.redis.del(...allKeys);
    res.json({ success: true, cleared: allKeys.length, message: `Cleared ${allKeys.length} cache keys` });
});
// ─── Offerwall Admin ──────────────────────────────────────────────────────────
router.get('/offerwall/offers', offerwallAdminController_1.listOfferwallOffers);
router.get('/offerwall/live-offers', offerwallAdminController_1.fetchLiveOffersForAdmin);
router.post('/offerwall/blacklist', offerwallAdminController_1.blacklistOffer);
router.post('/offerwall/whitelist', offerwallAdminController_1.whitelistOffer);
router.get('/offerwall/quality-report', offerwallAdminController_1.getQualityReport);
router.get('/offerwall/postback-logs', offerwallAdminController_1.getPostbackLogs);
router.get('/offerwall/retry-queue', offerwallAdminController_1.getRetryQueue);
router.post('/offerwall/manual-credit', offerwallAdminController_1.manualCredit);
router.get('/offerwall/stats', offerwallAdminController_1.getOfferwallStats);
router.get('/surveys/stats', offerwallAdminController_1.getSurveyStats);
// ─── Prize Inventory ──────────────────────────────────────────────────────────
router.get('/inventory', inventoryController_1.getInventory);
router.post('/inventory', inventoryController_1.createInventoryItem);
router.put('/inventory/:id', inventoryController_1.updateInventoryItem);
router.delete('/inventory/:id', inventoryController_1.deleteInventoryItem);
// ─── Sponsors ─────────────────────────────────────────────────────────────────
router.get('/sponsors', inventoryController_1.getSponsors);
router.post('/sponsors', inventoryController_1.createSponsor);
router.put('/sponsors/:id', inventoryController_1.updateSponsor);
// ─── IPL Prize Claims ─────────────────────────────────────────────────────────
router.get('/ipl/prize-claims', inventoryController_1.getIplPrizeClaims);
router.put('/ipl/prize-claims/:id', inventoryController_1.updateIplPrizeClaim);
// ─── Coin Conversion Rates ────────────────────────────────────────────────────
router.get('/coin-rates', coinRateController_1.getCoinRates);
router.post('/coin-rates', coinRateController_1.createCoinRate);
router.put('/coin-rates/:id', coinRateController_1.updateCoinRate);
// ─── App Settings / API Keys ──────────────────────────────────────────────────
router.get('/settings', settingsController_1.getSettings);
router.put('/settings/:key', settingsController_1.updateSetting);
router.post('/settings/bulk', settingsController_1.updateMultipleSettings);
router.put('/settings/bulk/update', settingsController_1.updateBulkPut);
// ─── Redemptions ──────────────────────────────────────────────────────────────
router.get('/redemptions', redeemController_1.getAdminRedemptions);
router.get('/redeem-packages', redeemController_1.getAdminPackages);
router.post('/redeem-packages', redeemController_1.upsertRedeemPackage);
router.put('/redeem-packages/:id', redeemController_1.upsertRedeemPackage);
router.delete('/redeem-packages/:id', redeemController_1.deleteRedeemPackage);
router.post('/redemptions/:id/process', redeemController_1.manualProcessRedemption);
router.put('/redemptions/:id/status', redeemController_1.updateRedemptionStatus);
// ─── Test / Dev Helpers ───────────────────────────────────────────────────────
router.post('/test/reset-daily-bonus/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
        await database_1.prisma.userStreak.upsert({
            where: { userId },
            update: { lastClaimDate: yesterday },
            create: { userId, lastClaimDate: yesterday },
        });
        // Also clear Redis key for old claimDailyBonus endpoint
        const today = new Date().toISOString().slice(0, 10);
        await redis_1.redis.del(`daily:${userId}:${today}`);
        return (0, response_1.success)(res, null, 'Daily bonus reset!');
    }
    catch (err) {
        return (0, response_1.error)(res, 'Failed', 500);
    }
});
router.post('/test/reset-all-daily-bonus', async (req, res) => {
    try {
        const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
        await database_1.prisma.userStreak.updateMany({
            data: { lastClaimDate: yesterday },
        });
        // Clear all Redis daily bonus keys for today
        const today = new Date().toISOString().slice(0, 10);
        const keys = await redis_1.redis.keys(`daily:*:${today}`);
        if (keys.length > 0)
            await redis_1.redis.del(...keys);
        return (0, response_1.success)(res, { usersReset: true }, 'All daily bonuses reset!');
    }
    catch (err) {
        return (0, response_1.error)(res, 'Failed', 500);
    }
});
// ─── Daily Streak ─────────────────────────────────────────────────────────────
router.get('/streak-config', streakController_1.getStreakConfig);
router.put('/streak-config/:day', streakController_1.updateStreakConfig);
router.get('/streak-stats', streakController_1.getStreakStats);
// ─── Xoxoday ──────────────────────────────────────────────────────────────────
router.get('/xoxoday/test', async (_req, res) => {
    const result = await (0, xoxodayService_1.testXoxodayConnection)();
    const envInfo = {
        hasClientId: !!process.env.XOXODAY_CLIENT_ID,
        hasSecretId: !!process.env.XOXODAY_SECRET_ID,
        clientIdPreview: process.env.XOXODAY_CLIENT_ID?.slice(0, 8) + '...',
    };
    return (0, response_1.success)(res, { ...result, envInfo });
});
router.get('/xoxoday/test-connection', async (_req, res) => {
    const result = await (0, xoxodayService_1.testXoxodayConnection)();
    const products = result.connected ? await (0, xoxodayService_1.getXoxodayProducts)('IN') : [];
    res.json({
        success: true,
        data: {
            ...result,
            productCount: products.length,
            source: result.connected ? 'LIVE_XOXODAY_API' : 'MOCK_DATA',
            sample: products.slice(0, 3).map((p) => ({
                id: p.id, name: p.name,
                denominations: Array.isArray(p.denominations) ? p.denominations.length : 0,
            })),
        },
    });
});
router.get('/xoxoday/products', async (req, res) => {
    try {
        const products = await (0, xoxodayService_1.getXoxodayProducts)('IN');
        res.json({
            success: true,
            data: { products, total: products.length, isMock: !process.env.XOXODAY_CLIENT_ID },
        });
    }
    catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
// ─── Redemption detail + approve ──────────────────────────────────────────────
router.get('/redemptions/:id', redeemController_1.getRedemptionDetails);
router.post('/redemptions/:id/approve', redeemController_1.approveRedemption);
// ─── File Upload ───────────────────────────────────────────────────────────────
const response_1 = require("../utils/response");
router.post('/upload', upload_1.upload.single('file'), (req, res) => {
    if (!req.file) {
        (0, response_1.error)(res, 'No file uploaded', 400);
        return;
    }
    const url = `/uploads/${req.file.filename}`;
    const fullUrl = `${req.protocol}://${req.get('host')}${url}`;
    (0, response_1.success)(res, { url: fullUrl, filename: req.file.filename }, 'Uploaded!');
});
exports.default = router;
