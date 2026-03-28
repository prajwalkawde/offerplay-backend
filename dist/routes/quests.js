"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const adminAuth_1 = require("../middleware/adminAuth");
const questController_1 = require("../controllers/questController");
const adjoeController_1 = require("../controllers/adjoeController");
const router = (0, express_1.Router)();
// User routes
router.get('/', auth_1.authMiddleware, questController_1.getQuests);
router.post('/:id/claim', auth_1.authMiddleware, questController_1.claimQuestReward);
router.get('/adjoe/stats', auth_1.authMiddleware, adjoeController_1.getAdjoeStats);
// Admin routes
router.get('/admin/list', adminAuth_1.adminAuthMiddleware, questController_1.adminListQuests);
router.post('/admin/quests', adminAuth_1.adminAuthMiddleware, questController_1.adminCreateQuest);
router.put('/admin/quests/:id', adminAuth_1.adminAuthMiddleware, questController_1.adminUpdateQuest);
router.delete('/admin/quests/:id', adminAuth_1.adminAuthMiddleware, questController_1.adminDeleteQuest);
exports.default = router;
