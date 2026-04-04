import { Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import { TransactionType } from '@prisma/client';

// ─── GET /api/custom-offers ───────────────────────────────────────────────────
// All active offers, enriched with per-user progress

export const getCustomOffers = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const now = new Date();

    const offers = await prisma.customOffer.findMany({
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

    const userCompletion = await prisma.customOfferCompletion.findMany({
      where: { userId },
      include: { stageCompletions: true, taskCompletions: true },
    });
    const completionMap = new Map(userCompletion.map(c => [c.offerId, c]));

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });
    const accountAgeDays = Math.floor(
      (Date.now() - new Date(user?.createdAt || 0).getTime()) / 86400000,
    );

    const enriched = offers.map(offer => {
      const completion = completionMap.get(offer.id);
      const completedTaskIds = new Set(
        completion?.taskCompletions.filter(tc => tc.status === 'completed').map(tc => tc.taskId) || [],
      );
      const completedStageIds = new Set(
        completion?.stageCompletions.map(sc => sc.stageId) || [],
      );

      const isMaxedOut = offer.maxCompletionsPerUser
        ? completion?.status === 'completed'
        : false;
      const isEligible = accountAgeDays >= offer.minAccountAgeDays;

      const enrichedStages = offer.stages.map(stage => {
        const isUnlocked =
          stage.unlocksAfterStage == null ||
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

    return success(res, enriched);
  } catch (err) {
    logger.error('getCustomOffers:', err);
    return error(res, 'Failed', 500);
  }
};

// ─── POST /api/custom-offers/:offerId/start ───────────────────────────────────

export const startCustomOffer = async (req: Request, res: Response) => {
  try {
    const userId  = req.userId!;
    const offerId = req.params.offerId as string;

    const offer = await prisma.customOffer.findUnique({ where: { id: offerId } });
    if (!offer)          return error(res, 'Offer not found', 404);
    if (!offer.isActive) return error(res, 'Offer not available', 400);

    if (offer.maxCompletionsPerUser) {
      const existing = await prisma.customOfferCompletion.findUnique({
        where: { userId_offerId: { userId, offerId } },
      });
      if (existing?.status === 'completed') {
        return error(res, 'Already completed this offer!', 400);
      }
    }

    await prisma.customOfferCompletion.upsert({
      where:  { userId_offerId: { userId, offerId } },
      update: {},
      create: { userId, offerId, status: 'in_progress' },
    });

    return success(res, { offerId, status: 'started' }, 'Offer started!');
  } catch (err) {
    logger.error('startCustomOffer:', err);
    return error(res, 'Failed', 500);
  }
};

// ─── POST /api/custom-offers/:offerId/tasks/:taskId/complete ──────────────────

export const completeTask = async (req: Request, res: Response) => {
  try {
    const userId  = req.userId!;
    const offerId = req.params.offerId as string;
    const taskId  = req.params.taskId  as string;
    const { submittedAmount, submittedData } = req.body;

    const task = await prisma.customOfferTask.findUnique({
      where: { id: taskId },
      include: { stage: true },
    });
    if (!task) return error(res, 'Task not found', 404);

    const existing = await prisma.customOfferTaskCompletion.findUnique({
      where: { userId_taskId: { userId, taskId } },
    });
    if (existing?.status === 'completed') {
      return error(res, 'Task already completed!', 400);
    }

    // Ensure offer completion record exists
    await prisma.customOfferCompletion.upsert({
      where:  { userId_offerId: { userId, offerId } },
      update: {},
      create: { userId, offerId, status: 'in_progress' },
    });

    // REDIRECT — auto-complete immediately, no pending state ever
    if (task.verifyMethod === 'REDIRECT') {
      await creditTaskReward(
        userId, offerId, task,
        submittedAmount, `redirect_${Date.now()}`,
      );
      return success(res, {
        taskId,
        ticketsEarned: task.rewardTickets,
        coinsEarned:   task.rewardCoins,
        status:        'completed',
      }, '✅ Task completed!');
    }

    // POSTBACK / MANUAL — DO NOT create pending record here.
    // Pending state is set ONLY when the partner sends a postback.
    // Return action_recorded so frontend knows the URL was opened.
    return success(res, {
      taskId,
      status:  'action_recorded',
      message: 'Open the link and complete the action!',
    });
  } catch (err) {
    logger.error('completeTask:', err);
    return error(res, 'Failed', 500);
  }
};

// ─── GET|POST /api/custom-offers/postback ────────────────────────────────────
// S2S postback from AstroCrick (no auth — signature verified)

export const handlePostback = async (req: Request, res: Response) => {
  try {
    const q = { ...req.query, ...req.body } as Record<string, string>;
    const { user_id, offer_id, task_id, event_type, amount, transaction_id, signature } = q;

    logger.info('Custom offer postback:', { user_id, offer_id, task_id, event_type, amount });

    const offer = await prisma.customOffer.findUnique({ where: { id: String(offer_id) } });
    if (!offer) {
      logger.warn('Postback: offer not found', offer_id);
      return res.status(404).send('OFFER_NOT_FOUND');
    }

    // Verify HMAC-MD5 signature: MD5(user_id + offer_id + task_id + secretKey)
    if (offer.secretKey) {
      const expected = crypto
        .createHash('md5')
        .update(String(user_id) + String(offer_id) + String(task_id) + offer.secretKey)
        .digest('hex');
      if (signature !== expected) {
        logger.warn('Postback: invalid signature for offer', offer_id);
        return res.status(401).send('INVALID_SIGNATURE');
      }
    }

    // Idempotency — reject duplicate transaction_id
    if (transaction_id) {
      const dup = await prisma.customOfferTaskCompletion.findFirst({
        where: { postbackRef: String(transaction_id) },
      });
      if (dup) {
        logger.info('Postback duplicate, skipping:', transaction_id);
        return res.send('OK');
      }
    }

    const task = await prisma.customOfferTask.findUnique({
      where: { id: String(task_id) },
      include: { stage: true },
    });
    if (!task) return res.status(404).send('TASK_NOT_FOUND');

    // Validate deposit amount
    if (task.taskType === 'DEPOSIT' && task.requiredAmount) {
      const depositAmt = parseFloat(String(amount || 0));
      if (depositAmt < task.requiredAmount) {
        logger.warn('Postback insufficient amount:', depositAmt, '<', task.requiredAmount);
        return res.status(400).send('INSUFFICIENT_AMOUNT');
      }
    }

    // Mark pending first (partner confirmed action) then immediately complete
    await prisma.customOfferTaskCompletion.upsert({
      where:  { userId_taskId: { userId: String(user_id), taskId: task.id } },
      update: { status: 'pending' },
      create: {
        userId:        String(user_id),
        offerId:       String(offer_id),
        stageId:       task.stageId,
        taskId:        task.id,
        status:        'pending',
        ticketsEarned: 0,
        coinsEarned:   0,
        postbackRef:   String(transaction_id || ''),
      },
    }).catch(() => {});

    await creditTaskReward(
      String(user_id),
      String(offer_id),
      task,
      parseFloat(String(amount || 0)),
      String(transaction_id || ''),
    );

    logger.info(
      `Postback credited: user=${user_id} task="${task.title}" ` +
      `+${task.rewardTickets}🎫 +${task.rewardCoins}🪙`,
    );

    return res.send('OK');
  } catch (err) {
    logger.error('handlePostback:', err);
    return res.status(500).send('ERROR');
  }
};

// ─── GET /api/custom-offers/:offerId/status ───────────────────────────────────

export const getOfferStatus = async (req: Request, res: Response) => {
  try {
    const userId  = req.userId!;
    const offerId = req.params.offerId as string;

    const completion = await prisma.customOfferCompletion.findUnique({
      where:   { userId_offerId: { userId, offerId } },
      include: { taskCompletions: true, stageCompletions: true },
    });

    return success(res, {
      status:          completion?.status || 'not_started',
      completedTasks:  completion?.taskCompletions.filter(t => t.status === 'completed').map(t => t.taskId) || [],
      completedStages: completion?.stageCompletions.map(s => s.stageId) || [],
    });
  } catch (err) {
    return error(res, 'Failed', 500);
  }
};

// ─── GET /api/custom-offers/smart ────────────────────────────────────────────

export const getSmartOffers = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { questDifficulty = 'Easy' } = req.query;

    const profile = await prisma.userActivityProfile.findUnique({ where: { userId } });
    const userRate = profile?.completionRate || 0.5;

    let targetDifficulty = String(questDifficulty);
    if (userRate < 0.3 && targetDifficulty === 'Hard')   targetDifficulty = 'Medium';
    if (userRate > 0.8 && targetDifficulty === 'Easy')   targetDifficulty = 'Medium';

    return success(res, {
      difficulty:       targetDifficulty,
      preferredCategory: profile?.lastOfferCategory || 'GAMING',
      offers:           [],
    });
  } catch (err) {
    return error(res, 'Failed', 500);
  }
};

// ─── Internal helper: credit rewards and check stage/offer completion ─────────

const creditTaskReward = async (
  userId:         string,
  offerId:        string,
  task:           any,
  submittedAmount?: number,
  postbackRef?:   string,
) => {
  await prisma.$transaction(async tx => {
    // Upsert offer completion record
    await tx.customOfferCompletion.upsert({
      where:  { userId_offerId: { userId, offerId } },
      update: {},
      create: { userId, offerId, status: 'in_progress' },
    });

    // Upsert task completion as completed
    await tx.customOfferTaskCompletion.upsert({
      where:  { userId_taskId: { userId, taskId: task.id } },
      update: {
        status:         'completed',
        ticketsEarned:  task.rewardTickets,
        coinsEarned:    task.rewardCoins,
        verifiedAt:     new Date(),
        verifiedBy:     postbackRef ? 'POSTBACK' : 'REDIRECT',
        postbackRef:    postbackRef || null,
        submittedAmount: submittedAmount ?? null,
      },
      create: {
        userId, offerId, stageId: task.stageId, taskId: task.id,
        submittedAmount: submittedAmount ?? null,
        ticketsEarned:  task.rewardTickets,
        coinsEarned:    task.rewardCoins,
        status:         'completed',
        verifiedAt:     new Date(),
        verifiedBy:     postbackRef ? 'POSTBACK' : 'REDIRECT',
        postbackRef:    postbackRef || null,
      },
    });

    // Credit tickets
    if (task.rewardTickets > 0) {
      await tx.user.update({
        where: { id: userId },
        data:  { ticketBalance: { increment: task.rewardTickets } },
      });
      await tx.ticketTransaction.create({
        data: {
          userId,
          amount:      task.rewardTickets,
          type:        'EARN_TICKET',
          refId:       task.id,
          description: `Custom Offer: ${task.title}`,
        },
      }).catch(() => {});
    }

    // Credit coins
    if (task.rewardCoins > 0) {
      await tx.user.update({
        where: { id: userId },
        data:  { coinBalance: { increment: task.rewardCoins } },
      });
      await tx.transaction.create({
        data: {
          userId,
          type:        TransactionType.CUSTOM_OFFER,
          amount:      task.rewardCoins,
          description: `Custom Offer: ${task.title}`,
          status:      'completed',
          refId:       task.id,
        },
      });
    }

    // Check stage completion
    await checkStageCompletion(tx, userId, offerId, task.stageId);
  });
};

const checkStageCompletion = async (
  tx:      any,
  userId:  string,
  offerId: string,
  stageId: string,
) => {
  const stage = await tx.customOfferStage.findUnique({
    where:   { id: stageId },
    include: { tasks: { where: { isActive: true } } },
  });
  if (!stage) return;

  const completedCount = await tx.customOfferTaskCompletion.count({
    where: { userId, stageId, status: 'completed' },
  });

  if (completedCount < stage.tasks.length) return;

  // Mark stage complete
  await tx.customOfferStageCompletion.upsert({
    where:  { userId_stageId: { userId, stageId } },
    update: { completedAt: new Date() },
    create: { userId, offerId, stageId },
  });
  logger.info(`Stage "${stage.title}" completed by ${userId}`);

  // Check if ALL stages are now complete
  const offer = await tx.customOffer.findUnique({
    where:   { id: offerId },
    include: { stages: { where: { isActive: true } } },
  });
  const completedStages = await tx.customOfferStageCompletion.count({ where: { userId, offerId } });

  if (completedStages >= (offer?.stages.length || 0)) {
    await tx.customOfferCompletion.update({
      where: { userId_offerId: { userId, offerId } },
      data:  { status: 'completed', completedAt: new Date() },
    });
    await tx.customOffer.update({
      where: { id: offerId },
      data:  { currentCompletions: { increment: 1 } },
    });
    logger.info(`Offer "${offer?.title}" fully completed by ${userId}`);
  }
};

// ─── Internal helper: update activity profile ─────────────────────────────────

export const trackUserActivity = async (
  userId:   string,
  action:   string,
  category?: string,
) => {
  try {
    const hour = new Date().getHours();
    await prisma.userActivityProfile.upsert({
      where:  { userId },
      update: {
        lastActiveAt:      new Date(),
        preferredHour:     hour,
        lastOfferCategory: category || undefined,
        ...(action === 'OFFER_STARTED'    && { totalOffersStarted:   { increment: 1 } }),
        ...(action === 'OFFER_COMPLETED'  && { totalOffersCompleted: { increment: 1 } }),
        ...(action === 'OFFER_COMPLETED' && category === 'GAMING'   && { gamingOfferCount:  { increment: 1 } }),
        ...(action === 'OFFER_COMPLETED' && category === 'FINANCE'  && { financeOfferCount: { increment: 1 } }),
        ...(action === 'OFFER_COMPLETED' && category === 'SURVEY'   && { surveyCount:       { increment: 1 } }),
      },
      create: {
        userId,
        lastActiveAt:        new Date(),
        preferredHour:       hour,
        lastOfferCategory:   category,
        totalOffersStarted:  action === 'OFFER_STARTED'   ? 1 : 0,
        totalOffersCompleted:action === 'OFFER_COMPLETED' ? 1 : 0,
        gamingOfferCount:    category === 'GAMING'  ? 1 : 0,
        financeOfferCount:   category === 'FINANCE' ? 1 : 0,
        surveyCount:         category === 'SURVEY'  ? 1 : 0,
      },
    });
  } catch (e) {
    logger.error('trackUserActivity:', e);
  }
};
