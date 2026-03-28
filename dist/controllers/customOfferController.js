"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackUserActivity = exports.getSmartOffers = exports.getOfferStatus = exports.handlePostback = exports.completeTask = exports.startCustomOffer = exports.getCustomOffers = void 0;
const crypto_1 = __importDefault(require("crypto"));
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const logger_1 = require("../utils/logger");
const client_1 = require("@prisma/client");
// ─── GET /api/custom-offers ───────────────────────────────────────────────────
// All active offers, enriched with per-user progress
const getCustomOffers = async (req, res) => {
    try {
        const userId = req.user.id;
        const now = new Date();
        const offers = await database_1.prisma.customOffer.findMany({
            where: {
                isActive: true,
                OR: [{ availableFrom: null }, { availableFrom: { lte: now } }],
                AND: [{ OR: [{ availableTo: null }, { availableTo: { gte: now } }] }],
            },
            include: {
                stages: {
                    where: { isActive: true },
                    orderBy: { stageNumber: 'asc' },
                    include: {
                        tasks: { where: { isActive: true }, orderBy: { taskOrder: 'asc' } },
                    },
                },
            },
            orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }],
        });
        const userCompletion = await database_1.prisma.customOfferCompletion.findMany({
            where: { userId },
            include: { stageCompletions: true, taskCompletions: true },
        });
        const completionMap = new Map(userCompletion.map(c => [c.offerId, c]));
        const user = await database_1.prisma.user.findUnique({
            where: { id: userId },
            select: { createdAt: true },
        });
        const accountAgeDays = Math.floor((Date.now() - new Date(user?.createdAt || 0).getTime()) / 86400000);
        const enriched = offers.map(offer => {
            const completion = completionMap.get(offer.id);
            const completedTaskIds = new Set(completion?.taskCompletions.filter(tc => tc.status === 'completed').map(tc => tc.taskId) || []);
            const completedStageIds = new Set(completion?.stageCompletions.map(sc => sc.stageId) || []);
            const isMaxedOut = offer.maxCompletionsPerUser
                ? completion?.status === 'completed'
                : false;
            const isEligible = accountAgeDays >= offer.minAccountAgeDays;
            const enrichedStages = offer.stages.map(stage => {
                const isUnlocked = stage.unlocksAfterStage == null ||
                    (() => {
                        const prev = offer.stages.find(s => s.stageNumber === stage.unlocksAfterStage);
                        return prev ? completedStageIds.has(prev.id) : true;
                    })();
                const enrichedTasks = stage.tasks.map(task => {
                    const tc = completion?.taskCompletions.find(t => t.taskId === task.id);
                    return {
                        ...task,
                        isCompleted: completedTaskIds.has(task.id),
                        status: tc?.status || 'not_started',
                        submittedAmount: tc?.submittedAmount ?? null,
                    };
                });
                const tasksCompleted = enrichedTasks.filter(t => t.isCompleted).length;
                return {
                    ...stage,
                    tasks: enrichedTasks,
                    isUnlocked,
                    isCompleted: completedStageIds.has(stage.id),
                    tasksCompleted,
                    totalTasks: enrichedTasks.length,
                    progressPct: enrichedTasks.length > 0 ? (tasksCompleted / enrichedTasks.length) * 100 : 0,
                    totalTickets: enrichedTasks.reduce((s, t) => s + t.rewardTickets, 0),
                    totalCoins: enrichedTasks.reduce((s, t) => s + t.rewardCoins, 0),
                };
            });
            return {
                id: offer.id,
                title: offer.title,
                description: offer.description,
                partnerName: offer.partnerName,
                partnerUrl: offer.partnerUrl,
                logoUrl: offer.logoUrl,
                bannerUrl: offer.bannerUrl,
                badgeText: offer.badgeText,
                badgeColor: offer.badgeColor,
                isFeatured: offer.isFeatured,
                isEligible,
                isMaxedOut,
                overallStatus: completion?.status || 'not_started',
                stages: enrichedStages,
                totalTickets: enrichedStages.reduce((s, st) => s + st.totalTickets, 0),
                totalCoins: enrichedStages.reduce((s, st) => s + st.totalCoins, 0),
                completedStages: completedStageIds.size,
                totalStages: offer.stages.length,
            };
        });
        return (0, response_1.success)(res, enriched);
    }
    catch (err) {
        logger_1.logger.error('getCustomOffers:', err);
        return (0, response_1.error)(res, 'Failed', 500);
    }
};
exports.getCustomOffers = getCustomOffers;
// ─── POST /api/custom-offers/:offerId/start ───────────────────────────────────
const startCustomOffer = async (req, res) => {
    try {
        const userId = req.user.id;
        const offerId = req.params.offerId;
        const offer = await database_1.prisma.customOffer.findUnique({ where: { id: offerId } });
        if (!offer)
            return (0, response_1.error)(res, 'Offer not found', 404);
        if (!offer.isActive)
            return (0, response_1.error)(res, 'Offer not available', 400);
        if (offer.maxCompletionsPerUser) {
            const existing = await database_1.prisma.customOfferCompletion.findUnique({
                where: { userId_offerId: { userId, offerId } },
            });
            if (existing?.status === 'completed') {
                return (0, response_1.error)(res, 'Already completed this offer!', 400);
            }
        }
        await database_1.prisma.customOfferCompletion.upsert({
            where: { userId_offerId: { userId, offerId } },
            update: {},
            create: { userId, offerId, status: 'in_progress' },
        });
        return (0, response_1.success)(res, { offerId, status: 'started' }, 'Offer started!');
    }
    catch (err) {
        logger_1.logger.error('startCustomOffer:', err);
        return (0, response_1.error)(res, 'Failed', 500);
    }
};
exports.startCustomOffer = startCustomOffer;
// ─── POST /api/custom-offers/:offerId/tasks/:taskId/complete ──────────────────
const completeTask = async (req, res) => {
    try {
        const userId = req.user.id;
        const offerId = req.params.offerId;
        const taskId = req.params.taskId;
        const { submittedAmount, submittedData } = req.body;
        const task = await database_1.prisma.customOfferTask.findUnique({
            where: { id: taskId },
            include: { stage: true },
        });
        if (!task)
            return (0, response_1.error)(res, 'Task not found', 404);
        const existing = await database_1.prisma.customOfferTaskCompletion.findUnique({
            where: { userId_taskId: { userId, taskId } },
        });
        if (existing?.status === 'completed') {
            return (0, response_1.error)(res, 'Task already completed!', 400);
        }
        // Ensure offer completion record exists
        await database_1.prisma.customOfferCompletion.upsert({
            where: { userId_offerId: { userId, offerId } },
            update: {},
            create: { userId, offerId, status: 'in_progress' },
        });
        // REDIRECT — auto-complete immediately, no pending state ever
        if (task.verifyMethod === 'REDIRECT') {
            await creditTaskReward(userId, offerId, task, submittedAmount, `redirect_${Date.now()}`);
            return (0, response_1.success)(res, {
                taskId,
                ticketsEarned: task.rewardTickets,
                coinsEarned: task.rewardCoins,
                status: 'completed',
            }, '✅ Task completed!');
        }
        // POSTBACK / MANUAL — DO NOT create pending record here.
        // Pending state is set ONLY when the partner sends a postback.
        // Return action_recorded so frontend knows the URL was opened.
        return (0, response_1.success)(res, {
            taskId,
            status: 'action_recorded',
            message: 'Open the link and complete the action!',
        });
    }
    catch (err) {
        logger_1.logger.error('completeTask:', err);
        return (0, response_1.error)(res, 'Failed', 500);
    }
};
exports.completeTask = completeTask;
// ─── GET|POST /api/custom-offers/postback ────────────────────────────────────
// S2S postback from AstroCrick (no auth — signature verified)
const handlePostback = async (req, res) => {
    try {
        const q = { ...req.query, ...req.body };
        const { user_id, offer_id, task_id, event_type, amount, transaction_id, signature } = q;
        logger_1.logger.info('Custom offer postback:', { user_id, offer_id, task_id, event_type, amount });
        const offer = await database_1.prisma.customOffer.findUnique({ where: { id: String(offer_id) } });
        if (!offer) {
            logger_1.logger.warn('Postback: offer not found', offer_id);
            return res.status(404).send('OFFER_NOT_FOUND');
        }
        // Verify HMAC-MD5 signature: MD5(user_id + offer_id + task_id + secretKey)
        if (offer.secretKey) {
            const expected = crypto_1.default
                .createHash('md5')
                .update(String(user_id) + String(offer_id) + String(task_id) + offer.secretKey)
                .digest('hex');
            if (signature !== expected) {
                logger_1.logger.warn('Postback: invalid signature for offer', offer_id);
                return res.status(401).send('INVALID_SIGNATURE');
            }
        }
        // Idempotency — reject duplicate transaction_id
        if (transaction_id) {
            const dup = await database_1.prisma.customOfferTaskCompletion.findFirst({
                where: { postbackRef: String(transaction_id) },
            });
            if (dup) {
                logger_1.logger.info('Postback duplicate, skipping:', transaction_id);
                return res.send('OK');
            }
        }
        const task = await database_1.prisma.customOfferTask.findUnique({
            where: { id: String(task_id) },
            include: { stage: true },
        });
        if (!task)
            return res.status(404).send('TASK_NOT_FOUND');
        // Validate deposit amount
        if (task.taskType === 'DEPOSIT' && task.requiredAmount) {
            const depositAmt = parseFloat(String(amount || 0));
            if (depositAmt < task.requiredAmount) {
                logger_1.logger.warn('Postback insufficient amount:', depositAmt, '<', task.requiredAmount);
                return res.status(400).send('INSUFFICIENT_AMOUNT');
            }
        }
        // Mark pending first (partner confirmed action) then immediately complete
        await database_1.prisma.customOfferTaskCompletion.upsert({
            where: { userId_taskId: { userId: String(user_id), taskId: task.id } },
            update: { status: 'pending' },
            create: {
                userId: String(user_id),
                offerId: String(offer_id),
                stageId: task.stageId,
                taskId: task.id,
                status: 'pending',
                ticketsEarned: 0,
                coinsEarned: 0,
                postbackRef: String(transaction_id || ''),
            },
        }).catch(() => { });
        await creditTaskReward(String(user_id), String(offer_id), task, parseFloat(String(amount || 0)), String(transaction_id || ''));
        logger_1.logger.info(`Postback credited: user=${user_id} task="${task.title}" ` +
            `+${task.rewardTickets}🎫 +${task.rewardCoins}🪙`);
        return res.send('OK');
    }
    catch (err) {
        logger_1.logger.error('handlePostback:', err);
        return res.status(500).send('ERROR');
    }
};
exports.handlePostback = handlePostback;
// ─── GET /api/custom-offers/:offerId/status ───────────────────────────────────
const getOfferStatus = async (req, res) => {
    try {
        const userId = req.user.id;
        const offerId = req.params.offerId;
        const completion = await database_1.prisma.customOfferCompletion.findUnique({
            where: { userId_offerId: { userId, offerId } },
            include: { taskCompletions: true, stageCompletions: true },
        });
        return (0, response_1.success)(res, {
            status: completion?.status || 'not_started',
            completedTasks: completion?.taskCompletions.filter(t => t.status === 'completed').map(t => t.taskId) || [],
            completedStages: completion?.stageCompletions.map(s => s.stageId) || [],
        });
    }
    catch (err) {
        return (0, response_1.error)(res, 'Failed', 500);
    }
};
exports.getOfferStatus = getOfferStatus;
// ─── GET /api/custom-offers/smart ────────────────────────────────────────────
const getSmartOffers = async (req, res) => {
    try {
        const userId = req.user.id;
        const { questDifficulty = 'Easy' } = req.query;
        const profile = await database_1.prisma.userActivityProfile.findUnique({ where: { userId } });
        const userRate = profile?.completionRate || 0.5;
        let targetDifficulty = String(questDifficulty);
        if (userRate < 0.3 && targetDifficulty === 'Hard')
            targetDifficulty = 'Medium';
        if (userRate > 0.8 && targetDifficulty === 'Easy')
            targetDifficulty = 'Medium';
        return (0, response_1.success)(res, {
            difficulty: targetDifficulty,
            preferredCategory: profile?.lastOfferCategory || 'GAMING',
            offers: [],
        });
    }
    catch (err) {
        return (0, response_1.error)(res, 'Failed', 500);
    }
};
exports.getSmartOffers = getSmartOffers;
// ─── Internal helper: credit rewards and check stage/offer completion ─────────
const creditTaskReward = async (userId, offerId, task, submittedAmount, postbackRef) => {
    await database_1.prisma.$transaction(async (tx) => {
        // Upsert offer completion record
        await tx.customOfferCompletion.upsert({
            where: { userId_offerId: { userId, offerId } },
            update: {},
            create: { userId, offerId, status: 'in_progress' },
        });
        // Upsert task completion as completed
        await tx.customOfferTaskCompletion.upsert({
            where: { userId_taskId: { userId, taskId: task.id } },
            update: {
                status: 'completed',
                ticketsEarned: task.rewardTickets,
                coinsEarned: task.rewardCoins,
                verifiedAt: new Date(),
                verifiedBy: postbackRef ? 'POSTBACK' : 'REDIRECT',
                postbackRef: postbackRef || null,
                submittedAmount: submittedAmount ?? null,
            },
            create: {
                userId, offerId, stageId: task.stageId, taskId: task.id,
                submittedAmount: submittedAmount ?? null,
                ticketsEarned: task.rewardTickets,
                coinsEarned: task.rewardCoins,
                status: 'completed',
                verifiedAt: new Date(),
                verifiedBy: postbackRef ? 'POSTBACK' : 'REDIRECT',
                postbackRef: postbackRef || null,
            },
        });
        // Credit tickets
        if (task.rewardTickets > 0) {
            await tx.user.update({
                where: { id: userId },
                data: { ticketBalance: { increment: task.rewardTickets } },
            });
            await tx.ticketTransaction.create({
                data: {
                    userId,
                    amount: task.rewardTickets,
                    type: 'EARN_TICKET',
                    refId: task.id,
                    description: `Custom Offer: ${task.title}`,
                },
            }).catch(() => { });
        }
        // Credit coins
        if (task.rewardCoins > 0) {
            await tx.user.update({
                where: { id: userId },
                data: { coinBalance: { increment: task.rewardCoins } },
            });
            await tx.transaction.create({
                data: {
                    userId,
                    type: client_1.TransactionType.CUSTOM_OFFER,
                    amount: task.rewardCoins,
                    description: `Custom Offer: ${task.title}`,
                    status: 'completed',
                    refId: task.id,
                },
            });
        }
        // Check stage completion
        await checkStageCompletion(tx, userId, offerId, task.stageId);
    });
};
const checkStageCompletion = async (tx, userId, offerId, stageId) => {
    const stage = await tx.customOfferStage.findUnique({
        where: { id: stageId },
        include: { tasks: { where: { isActive: true } } },
    });
    if (!stage)
        return;
    const completedCount = await tx.customOfferTaskCompletion.count({
        where: { userId, stageId, status: 'completed' },
    });
    if (completedCount < stage.tasks.length)
        return;
    // Mark stage complete
    await tx.customOfferStageCompletion.upsert({
        where: { userId_stageId: { userId, stageId } },
        update: { completedAt: new Date() },
        create: { userId, offerId, stageId },
    });
    logger_1.logger.info(`Stage "${stage.title}" completed by ${userId}`);
    // Check if ALL stages are now complete
    const offer = await tx.customOffer.findUnique({
        where: { id: offerId },
        include: { stages: { where: { isActive: true } } },
    });
    const completedStages = await tx.customOfferStageCompletion.count({ where: { userId, offerId } });
    if (completedStages >= (offer?.stages.length || 0)) {
        await tx.customOfferCompletion.update({
            where: { userId_offerId: { userId, offerId } },
            data: { status: 'completed', completedAt: new Date() },
        });
        await tx.customOffer.update({
            where: { id: offerId },
            data: { currentCompletions: { increment: 1 } },
        });
        logger_1.logger.info(`Offer "${offer?.title}" fully completed by ${userId}`);
    }
};
// ─── Internal helper: update activity profile ─────────────────────────────────
const trackUserActivity = async (userId, action, category) => {
    try {
        const hour = new Date().getHours();
        await database_1.prisma.userActivityProfile.upsert({
            where: { userId },
            update: {
                lastActiveAt: new Date(),
                preferredHour: hour,
                lastOfferCategory: category || undefined,
                ...(action === 'OFFER_STARTED' && { totalOffersStarted: { increment: 1 } }),
                ...(action === 'OFFER_COMPLETED' && { totalOffersCompleted: { increment: 1 } }),
                ...(action === 'OFFER_COMPLETED' && category === 'GAMING' && { gamingOfferCount: { increment: 1 } }),
                ...(action === 'OFFER_COMPLETED' && category === 'FINANCE' && { financeOfferCount: { increment: 1 } }),
                ...(action === 'OFFER_COMPLETED' && category === 'SURVEY' && { surveyCount: { increment: 1 } }),
            },
            create: {
                userId,
                lastActiveAt: new Date(),
                preferredHour: hour,
                lastOfferCategory: category,
                totalOffersStarted: action === 'OFFER_STARTED' ? 1 : 0,
                totalOffersCompleted: action === 'OFFER_COMPLETED' ? 1 : 0,
                gamingOfferCount: category === 'GAMING' ? 1 : 0,
                financeOfferCount: category === 'FINANCE' ? 1 : 0,
                surveyCount: category === 'SURVEY' ? 1 : 0,
            },
        });
    }
    catch (e) {
        logger_1.logger.error('trackUserActivity:', e);
    }
};
exports.trackUserActivity = trackUserActivity;
