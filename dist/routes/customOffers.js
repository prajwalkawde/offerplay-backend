"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const adminAuth_1 = require("../middleware/adminAuth");
const customOfferController_1 = require("../controllers/customOfferController");
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const client_1 = require("@prisma/client");
const router = (0, express_1.Router)();
// ── S2S Postback (no auth — must be BEFORE /:offerId routes) ──────────────────
router.get('/postback', customOfferController_1.handlePostback);
router.post('/postback', customOfferController_1.handlePostback);
// ── Smart offers ──────────────────────────────────────────────────────────────
router.get('/smart', auth_1.authMiddleware, customOfferController_1.getSmartOffers);
// ── Admin routes (must be BEFORE /:offerId routes) ───────────────────────────
router.get('/admin/list', adminAuth_1.adminAuthMiddleware, async (_req, res) => {
    const offers = await database_1.prisma.customOffer.findMany({
        include: {
            stages: { include: { tasks: true }, orderBy: { stageNumber: 'asc' } },
            _count: { select: { completions: true } },
        },
        orderBy: { createdAt: 'desc' },
    });
    return (0, response_1.success)(res, offers);
});
router.post('/admin/offers', adminAuth_1.adminAuthMiddleware, async (req, res) => {
    try {
        const offer = await database_1.prisma.customOffer.create({ data: req.body });
        return (0, response_1.success)(res, offer, 'Offer created!');
    }
    catch (e) {
        return (0, response_1.error)(res, e.message, 500);
    }
});
router.put('/admin/offers/:id', adminAuth_1.adminAuthMiddleware, async (req, res) => {
    try {
        const offer = await database_1.prisma.customOffer.update({
            where: { id: req.params.id },
            data: req.body,
        });
        return (0, response_1.success)(res, offer, 'Updated!');
    }
    catch (e) {
        return (0, response_1.error)(res, e.message, 500);
    }
});
router.delete('/admin/offers/:id', adminAuth_1.adminAuthMiddleware, async (req, res) => {
    try {
        await database_1.prisma.customOffer.delete({ where: { id: req.params.id } });
        return (0, response_1.success)(res, null, 'Deleted!');
    }
    catch (e) {
        return (0, response_1.error)(res, e.message, 500);
    }
});
router.post('/admin/offers/:offerId/stages', adminAuth_1.adminAuthMiddleware, async (req, res) => {
    try {
        const stage = await database_1.prisma.customOfferStage.create({
            data: { ...req.body, offerId: req.params.offerId },
        });
        return (0, response_1.success)(res, stage, 'Stage created!');
    }
    catch (e) {
        return (0, response_1.error)(res, e.message, 500);
    }
});
router.put('/admin/stages/:id', adminAuth_1.adminAuthMiddleware, async (req, res) => {
    try {
        const stage = await database_1.prisma.customOfferStage.update({
            where: { id: req.params.id },
            data: req.body,
        });
        return (0, response_1.success)(res, stage, 'Updated!');
    }
    catch (e) {
        return (0, response_1.error)(res, e.message, 500);
    }
});
router.delete('/admin/stages/:id', adminAuth_1.adminAuthMiddleware, async (req, res) => {
    try {
        await database_1.prisma.customOfferStage.delete({ where: { id: req.params.id } });
        return (0, response_1.success)(res, null, 'Deleted!');
    }
    catch (e) {
        return (0, response_1.error)(res, e.message, 500);
    }
});
router.post('/admin/stages/:stageId/tasks', adminAuth_1.adminAuthMiddleware, async (req, res) => {
    try {
        const task = await database_1.prisma.customOfferTask.create({
            data: { ...req.body, stageId: req.params.stageId },
        });
        return (0, response_1.success)(res, task, 'Task created!');
    }
    catch (e) {
        return (0, response_1.error)(res, e.message, 500);
    }
});
router.put('/admin/tasks/:id', adminAuth_1.adminAuthMiddleware, async (req, res) => {
    try {
        const task = await database_1.prisma.customOfferTask.update({
            where: { id: req.params.id },
            data: req.body,
        });
        return (0, response_1.success)(res, task, 'Updated!');
    }
    catch (e) {
        return (0, response_1.error)(res, e.message, 500);
    }
});
router.delete('/admin/tasks/:id', adminAuth_1.adminAuthMiddleware, async (req, res) => {
    try {
        await database_1.prisma.customOfferTask.delete({ where: { id: req.params.id } });
        return (0, response_1.success)(res, null, 'Deleted!');
    }
    catch (e) {
        return (0, response_1.error)(res, e.message, 500);
    }
});
router.get('/admin/completions', adminAuth_1.adminAuthMiddleware, async (_req, res) => {
    const completions = await database_1.prisma.customOfferCompletion.findMany({
        include: {
            user: { select: { name: true, phone: true } },
            offer: { select: { title: true } },
            taskCompletions: true,
        },
        orderBy: { startedAt: 'desc' },
        take: 200,
    });
    return (0, response_1.success)(res, completions);
});
router.post('/admin/tasks/:taskId/verify', adminAuth_1.adminAuthMiddleware, async (req, res) => {
    try {
        const taskId = req.params.taskId;
        const { userId, status } = req.body;
        const task = await database_1.prisma.customOfferTask.findUnique({ where: { id: taskId } });
        if (!task)
            return (0, response_1.error)(res, 'Task not found', 404);
        await database_1.prisma.customOfferTaskCompletion.update({
            where: { userId_taskId: { userId, taskId } },
            data: { status, verifiedAt: new Date(), verifiedBy: 'ADMIN' },
        });
        if (status === 'completed') {
            if (task.rewardTickets > 0) {
                await database_1.prisma.user.update({
                    where: { id: userId },
                    data: { ticketBalance: { increment: task.rewardTickets } },
                });
                await database_1.prisma.ticketTransaction.create({
                    data: {
                        userId, amount: task.rewardTickets, type: 'EARN_TICKET',
                        refId: taskId, description: `Admin verified: ${task.title}`,
                    },
                }).catch(() => { });
            }
            if (task.rewardCoins > 0) {
                await database_1.prisma.user.update({
                    where: { id: userId },
                    data: { coinBalance: { increment: task.rewardCoins } },
                });
                await database_1.prisma.transaction.create({
                    data: {
                        userId, type: client_1.TransactionType.CUSTOM_OFFER,
                        amount: task.rewardCoins,
                        description: `Admin verified: ${task.title}`,
                        status: 'completed', refId: taskId,
                    },
                });
            }
        }
        return (0, response_1.success)(res, null, 'Task verified!');
    }
    catch (e) {
        return (0, response_1.error)(res, e.message, 500);
    }
});
// ── User routes ───────────────────────────────────────────────────────────────
router.get('/', auth_1.authMiddleware, customOfferController_1.getCustomOffers);
router.post('/:offerId/start', auth_1.authMiddleware, customOfferController_1.startCustomOffer);
router.post('/:offerId/tasks/:taskId/complete', auth_1.authMiddleware, customOfferController_1.completeTask);
router.get('/:offerId/status', auth_1.authMiddleware, customOfferController_1.getOfferStatus);
exports.default = router;
