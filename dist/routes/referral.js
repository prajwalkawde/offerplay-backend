"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const adminAuth_1 = require("../middleware/adminAuth");
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const referralController_1 = require("../controllers/referralController");
const deepLinkController_1 = require("../controllers/deepLinkController");
const router = (0, express_1.Router)();
// ─── App routes ───────────────────────────────────────────────────────────────
router.get('/dashboard', auth_1.authMiddleware, referralController_1.getReferralDashboard);
router.get('/link', auth_1.authMiddleware, deepLinkController_1.getUserReferralLink);
router.post('/apply', auth_1.authMiddleware, referralController_1.applyReferralCode);
router.post('/track-install', deepLinkController_1.trackInstall);
router.get('/milestones', auth_1.authMiddleware, referralController_1.getMilestones);
router.post('/milestones/:id/claim', auth_1.authMiddleware, referralController_1.claimMilestone);
// ─── Admin: settings ──────────────────────────────────────────────────────────
router.get('/admin/settings', adminAuth_1.adminAuthMiddleware, async (_req, res) => {
    const s = await database_1.prisma.referralSettings.findFirst().catch(() => null);
    (0, response_1.success)(res, s || {
        signupBonus: 100, referrerSignupBonus: 50,
        taskCommissionPct: 10, surveyCommissionPct: 10,
        offerwallCommissionPct: 10, contestWinCommissionPct: 5,
        isLifetimeCommission: true, maxReferrals: null, isActive: true,
    });
});
router.put('/admin/settings', adminAuth_1.adminAuthMiddleware, async (req, res) => {
    try {
        const existing = await database_1.prisma.referralSettings.findFirst().catch(() => null);
        const settings = existing
            ? await database_1.prisma.referralSettings.update({ where: { id: existing.id }, data: { ...req.body } })
            : await database_1.prisma.referralSettings.create({ data: req.body });
        (0, response_1.success)(res, settings, 'Referral settings saved!');
    }
    catch (err) {
        (0, response_1.error)(res, err.message || 'Failed to save settings', 500);
    }
});
// ─── Admin: milestones ────────────────────────────────────────────────────────
router.get('/admin/milestones', adminAuth_1.adminAuthMiddleware, async (_req, res) => {
    const m = await database_1.prisma.referralMilestone.findMany({ orderBy: { requiredReferrals: 'asc' } });
    (0, response_1.success)(res, m);
});
router.post('/admin/milestones', adminAuth_1.adminAuthMiddleware, async (req, res) => {
    try {
        const m = await database_1.prisma.referralMilestone.create({ data: req.body });
        (0, response_1.success)(res, m, 'Created!');
    }
    catch (err) {
        (0, response_1.error)(res, err.message || 'Failed', 500);
    }
});
router.put('/admin/milestones/:id', adminAuth_1.adminAuthMiddleware, async (req, res) => {
    try {
        const m = await database_1.prisma.referralMilestone.update({ where: { id: req.params.id }, data: req.body });
        (0, response_1.success)(res, m, 'Updated!');
    }
    catch (err) {
        (0, response_1.error)(res, err.message || 'Failed', 500);
    }
});
router.delete('/admin/milestones/:id', adminAuth_1.adminAuthMiddleware, async (req, res) => {
    try {
        await database_1.prisma.referralMilestone.delete({ where: { id: req.params.id } });
        (0, response_1.success)(res, null, 'Deleted!');
    }
    catch (err) {
        (0, response_1.error)(res, err.message || 'Failed', 500);
    }
});
// ─── Admin: milestone claims ──────────────────────────────────────────────────
router.get('/admin/claims', adminAuth_1.adminAuthMiddleware, referralController_1.getAdminMilestoneClaims);
router.put('/admin/claims/:id', adminAuth_1.adminAuthMiddleware, referralController_1.processAdminClaim);
// ─── Admin: referral list ─────────────────────────────────────────────────────
router.get('/admin/list', adminAuth_1.adminAuthMiddleware, async (_req, res) => {
    const referrals = await database_1.prisma.referral.findMany({
        include: {
            referrer: { select: { name: true, phone: true } },
            referred: { select: { name: true, phone: true } },
            _count: { select: { commissions: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
    });
    (0, response_1.success)(res, referrals);
});
exports.default = router;
