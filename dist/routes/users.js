"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const userController_1 = require("../controllers/userController");
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const router = (0, express_1.Router)();
router.use(auth_1.authMiddleware);
router.get('/me', userController_1.getProfile);
router.put('/me', userController_1.updateProfile);
router.get('/me/transactions', userController_1.getTransactions);
router.get('/me/stats', userController_1.getStats);
router.get('/me/referrals', userController_1.getUserReferrals);
router.get('/referral/:code', userController_1.validateReferralCode);
router.get('/wallet', userController_1.getWalletData);
router.post('/me/onesignal-token', async (req, res) => {
    const { playerId } = req.body;
    if (!playerId)
        return (0, response_1.error)(res, 'playerId is required', 400);
    await database_1.prisma.user.update({
        where: { id: req.userId },
        data: { oneSignalPlayerId: playerId },
    });
    return (0, response_1.success)(res, null, 'OneSignal token saved');
});
exports.default = router;
