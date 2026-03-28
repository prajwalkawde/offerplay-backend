"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const redeemController_1 = require("../controllers/redeemController");
const router = (0, express_1.Router)();
router.use(auth_1.authMiddleware);
// New endpoints
router.get('/packages', redeemController_1.getRedeemPackages);
router.get('/gift-cards', redeemController_1.getGiftCards);
router.post('/request', redeemController_1.requestRedemption);
router.get('/history', redeemController_1.getRedemptionHistory);
router.post('/rate/:id', redeemController_1.rateRedemption);
// Legacy compatibility
router.get('/options', redeemController_1.listOptions);
exports.default = router;
