import { Router } from 'express';
import { authMiddleware as auth } from '../middleware/auth';
import { adminAuthMiddleware as adminAuth } from '../middleware/adminAuth';
import { fraudCheck } from '../middleware/fraud';
import {
  getCustomOffers,
  startCustomOffer,
  completeTask,
  handlePostback,
  getOfferStatus,
  getSmartOffers,
} from '../controllers/customOfferController';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { TransactionType } from '@prisma/client';

const router = Router();

// ── S2S Postback (no auth — must be BEFORE /:offerId routes) ──────────────────
router.get('/postback', handlePostback);
router.post('/postback', handlePostback);

// ── Smart offers ──────────────────────────────────────────────────────────────
router.get('/smart', auth, getSmartOffers);

// ── Admin routes (must be BEFORE /:offerId routes) ───────────────────────────
router.get('/admin/list', adminAuth, async (_req, res) => {
  const offers = await prisma.customOffer.findMany({
    include: {
      stages: { include: { tasks: true }, orderBy: { stageNumber: 'asc' } },
      _count: { select: { completions: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return success(res, offers);
});

router.post('/admin/offers', adminAuth, async (req, res) => {
  try {
    const offer = await prisma.customOffer.create({ data: req.body });
    return success(res, offer, 'Offer created!');
  } catch (e: any) { return error(res, e.message, 500); }
});

router.put('/admin/offers/:id', adminAuth, async (req, res) => {
  try {
    const offer = await prisma.customOffer.update({
      where: { id: req.params.id as string },
      data:  req.body,
    });
    return success(res, offer, 'Updated!');
  } catch (e: any) { return error(res, e.message, 500); }
});

router.delete('/admin/offers/:id', adminAuth, async (req, res) => {
  try {
    await prisma.customOffer.delete({ where: { id: req.params.id as string } });
    return success(res, null, 'Deleted!');
  } catch (e: any) { return error(res, e.message, 500); }
});

router.post('/admin/offers/:offerId/stages', adminAuth, async (req, res) => {
  try {
    const stage = await prisma.customOfferStage.create({
      data: { ...req.body, offerId: req.params.offerId as string },
    });
    return success(res, stage, 'Stage created!');
  } catch (e: any) { return error(res, e.message, 500); }
});

router.put('/admin/stages/:id', adminAuth, async (req, res) => {
  try {
    const stage = await prisma.customOfferStage.update({
      where: { id: req.params.id as string },
      data:  req.body,
    });
    return success(res, stage, 'Updated!');
  } catch (e: any) { return error(res, e.message, 500); }
});

router.delete('/admin/stages/:id', adminAuth, async (req, res) => {
  try {
    await prisma.customOfferStage.delete({ where: { id: req.params.id as string } });
    return success(res, null, 'Deleted!');
  } catch (e: any) { return error(res, e.message, 500); }
});

router.post('/admin/stages/:stageId/tasks', adminAuth, async (req, res) => {
  try {
    const task = await prisma.customOfferTask.create({
      data: { ...req.body, stageId: req.params.stageId as string },
    });
    return success(res, task, 'Task created!');
  } catch (e: any) { return error(res, e.message, 500); }
});

router.put('/admin/tasks/:id', adminAuth, async (req, res) => {
  try {
    const task = await prisma.customOfferTask.update({
      where: { id: req.params.id as string },
      data:  req.body,
    });
    return success(res, task, 'Updated!');
  } catch (e: any) { return error(res, e.message, 500); }
});

router.delete('/admin/tasks/:id', adminAuth, async (req, res) => {
  try {
    await prisma.customOfferTask.delete({ where: { id: req.params.id as string } });
    return success(res, null, 'Deleted!');
  } catch (e: any) { return error(res, e.message, 500); }
});

router.get('/admin/completions', adminAuth, async (_req, res) => {
  const completions = await prisma.customOfferCompletion.findMany({
    include: {
      user:  { select: { name: true, phone: true } },
      offer: { select: { title: true } },
      taskCompletions: true,
    },
    orderBy: { startedAt: 'desc' },
    take: 200,
  });
  return success(res, completions);
});

router.post('/admin/tasks/:taskId/verify', adminAuth, async (req, res) => {
  try {
    const taskId = req.params.taskId as string;
    const { userId, status } = req.body as { userId: string; status: string };

    const task = await prisma.customOfferTask.findUnique({ where: { id: taskId } });
    if (!task) return error(res, 'Task not found', 404);

    await prisma.customOfferTaskCompletion.update({
      where: { userId_taskId: { userId, taskId } },
      data:  { status, verifiedAt: new Date(), verifiedBy: 'ADMIN' },
    });

    if (status === 'completed') {
      if (task.rewardTickets > 0) {
        await prisma.user.update({
          where: { id: userId },
          data:  { ticketBalance: { increment: task.rewardTickets } },
        });
        await prisma.ticketTransaction.create({
          data: {
            userId, amount: task.rewardTickets, type: 'EARN_TICKET',
            refId: taskId, description: `Admin verified: ${task.title}`,
          },
        }).catch(() => {});
      }
      if (task.rewardCoins > 0) {
        await prisma.user.update({
          where: { id: userId },
          data:  { coinBalance: { increment: task.rewardCoins } },
        });
        await prisma.transaction.create({
          data: {
            userId, type: TransactionType.CUSTOM_OFFER,
            amount: task.rewardCoins,
            description: `Admin verified: ${task.title}`,
            status: 'completed', refId: taskId,
          },
        });
      }
    }

    return success(res, null, 'Task verified!');
  } catch (e: any) { return error(res, e.message, 500); }
});

// ── User routes ───────────────────────────────────────────────────────────────
router.get('/', auth, getCustomOffers);
router.post('/:offerId/start', auth, startCustomOffer);
router.post('/:offerId/tasks/:taskId/complete', auth, fraudCheck('custom_offer_complete'), completeTask);
router.get('/:offerId/status', auth, getOfferStatus);

export default router;
