"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const earnController_1 = require("../controllers/earnController");
const streakController_1 = require("../controllers/streakController");
const surveyController_1 = require("../controllers/surveyController");
const notificationService_1 = require("../services/notificationService");
const redeemController_1 = require("../controllers/redeemController");
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const ticketService_1 = require("../services/ticketService");
const router = (0, express_1.Router)();
// ─── New routes ───────────────────────────────────────────────────────────────
router.get('/transactions', auth_1.authMiddleware, earnController_1.getTransactions);
router.get('/daily-streak', auth_1.authMiddleware, streakController_1.getStreakData);
router.post('/daily-streak/claim', auth_1.authMiddleware, streakController_1.claimDailyStreak);
// Aliases so both /daily-bonus and /daily-streak paths work
router.get('/daily-bonus', auth_1.authMiddleware, streakController_1.getStreakData);
router.post('/daily-bonus/claim', auth_1.authMiddleware, streakController_1.claimDailyStreak);
router.get('/referral', auth_1.authMiddleware, earnController_1.getReferral);
// ─── Existing routes ──────────────────────────────────────────────────────────
router.get('/options', earnController_1.getEarnOptions);
router.post('/daily', auth_1.authMiddleware, earnController_1.claimDailyBonus);
router.get('/offerwall/:provider/token', auth_1.authMiddleware, earnController_1.getOfferwallToken);
// ─── Offerwall aggregator routes ──────────────────────────────────────────────
router.get('/offers', auth_1.authMiddleware, earnController_1.getOffers);
router.post('/offers/click', auth_1.authMiddleware, earnController_1.clickOffer);
router.post('/offers/progress', auth_1.authMiddleware, earnController_1.trackProgress);
router.get('/offers/progress', auth_1.authMiddleware, earnController_1.getProgress);
router.post('/offers/rate', auth_1.authMiddleware, earnController_1.rateOffer);
router.post('/offers/report-missing', auth_1.authMiddleware, earnController_1.reportMissingCoins);
router.post('/offers/report-dead', auth_1.authMiddleware, earnController_1.reportDeadUrl);
router.get('/streak', auth_1.authMiddleware, earnController_1.getStreak);
router.post('/offers/enhance', auth_1.authMiddleware, earnController_1.enhanceOffer);
router.get('/surveys', auth_1.authMiddleware, surveyController_1.getSurveys);
router.get('/surveys/wall-url', auth_1.authMiddleware, surveyController_1.getSurveyWallUrl);
// ─── Redeem (also mounted here for mobile app compatibility) ──────────────────
router.get('/redeem/packages', redeemController_1.getRedeemPackages);
router.get('/redeem/gift-cards', auth_1.authMiddleware, redeemController_1.getGiftCards);
router.post('/redeem/request', auth_1.authMiddleware, redeemController_1.requestRedemption);
router.get('/redeem/history', auth_1.authMiddleware, redeemController_1.getRedemptionHistory);
// ─── Ticket Routes ────────────────────────────────────────────────────────────
router.get('/tickets/balance', auth_1.authMiddleware, async (req, res) => {
    const userId = req.userId;
    const balance = await (0, ticketService_1.getTicketBalance)(userId);
    return (0, response_1.success)(res, { ticketBalance: balance });
});
router.get('/tickets/history', auth_1.authMiddleware, async (req, res) => {
    const userId = req.userId;
    const history = await database_1.prisma.ticketTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
    });
    return (0, response_1.success)(res, history);
});
// ─── Ad Rewards ───────────────────────────────────────────────────────────────
router.post('/ad-reward', auth_1.authMiddleware, async (req, res) => {
    try {
        const userId = req.userId;
        const { coins = 50 } = req.body;
        // Max 10 rewarded ads per day
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayAdCount = await database_1.prisma.transaction.count({
            where: {
                userId,
                type: 'EARN_BONUS',
                description: { contains: 'Rewarded ad' },
                createdAt: { gte: today },
            },
        });
        if (todayAdCount >= 10) {
            return (0, response_1.error)(res, 'Daily ad limit reached (10/day)', 400);
        }
        await database_1.prisma.$transaction([
            database_1.prisma.user.update({
                where: { id: userId },
                data: { coinBalance: { increment: coins } },
            }),
            database_1.prisma.transaction.create({
                data: {
                    userId,
                    type: 'EARN_BONUS',
                    amount: coins,
                    description: 'Rewarded ad watched',
                    status: 'completed',
                },
            }),
        ]);
        return (0, response_1.success)(res, { coins }, `+${coins} coins earned!`);
    }
    catch (err) {
        return (0, response_1.error)(res, 'Failed to credit ad reward', 500);
    }
});
// ─── Notifications ────────────────────────────────────────────────────────────
router.get('/notifications', auth_1.authMiddleware, async (req, res) => {
    const userId = req.userId;
    const page = parseInt(String(req.query.page || '1'), 10);
    const { notifications, unreadCount } = await (0, notificationService_1.getUserNotifications)(userId, 20, page);
    (0, response_1.success)(res, { notifications, unreadCount });
});
router.put('/notifications/read-all', auth_1.authMiddleware, async (req, res) => {
    await (0, notificationService_1.markAllRead)(req.userId);
    (0, response_1.success)(res, null, 'All notifications marked as read');
});
router.put('/notifications/:id/read', auth_1.authMiddleware, async (req, res) => {
    await database_1.prisma.notification.updateMany({
        where: { id: req.params.id, userId: req.userId },
        data: { isRead: true },
    });
    (0, response_1.success)(res, null, 'Notification marked as read');
});
exports.default = router;
