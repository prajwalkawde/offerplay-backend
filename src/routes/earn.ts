import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { verifyRequestSignature } from '../middleware/requestSign.middleware';
import { logDeviceSecurity } from '../middleware/deviceSecurity.middleware';
import { fraudCheck } from '../middleware/fraud';
import {
  claimDailyBonus,
  getEarnOptions,
  getOfferwallToken,
  getOffers,
  clickOffer,
  trackProgress,
  getProgress,
  getRecentCoins,
  rateOffer,
  reportMissingCoins,
  reportDeadUrl,
  getStreak,
  enhanceOffer,
  getTransactions,
  getReferral,
  getSurveyHistory,
} from '../controllers/earnController';
import {
  getStreakData,
  claimDailyStreak,
} from '../controllers/streakController';
import { getSurveys, getSurveyWallUrl } from '../controllers/surveyController';
import {
  getUserNotifications,
  markAllRead,
} from '../services/notificationService';
import {
  getRedeemPackages,
  getGiftCards,
  requestRedemption,
  getRedemptionHistory,
} from '../controllers/redeemController';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { getTicketBalance } from '../services/ticketService';
import { updateQuestProgress } from '../controllers/questController';

const router = Router();

// ─── New routes ───────────────────────────────────────────────────────────────
router.get('/transactions', authMiddleware, getTransactions);
router.get('/daily-streak', authMiddleware, getStreakData);
router.post('/daily-streak/claim', authMiddleware, fraudCheck('daily_streak_claim'), claimDailyStreak);
// Aliases so both /daily-bonus and /daily-streak paths work
router.get('/daily-bonus', authMiddleware, getStreakData);
router.post('/daily-bonus/claim', authMiddleware, logDeviceSecurity, verifyRequestSignature, fraudCheck('daily_bonus'), claimDailyStreak);
router.get('/referral', authMiddleware, getReferral);

// ─── Existing routes ──────────────────────────────────────────────────────────
router.get('/options', getEarnOptions);
router.post('/daily', authMiddleware, fraudCheck('daily_bonus_legacy'), claimDailyBonus);
router.get('/offerwall/:provider/token', authMiddleware, getOfferwallToken);

// ─── Offerwall aggregator routes ──────────────────────────────────────────────
router.get('/offers', authMiddleware, getOffers);
router.post('/offers/click', authMiddleware, clickOffer);
router.post('/offers/progress', authMiddleware, trackProgress);
router.get('/offers/progress', authMiddleware, getProgress);
router.get('/offers/recent-coins', authMiddleware, getRecentCoins);
router.post('/offers/rate', authMiddleware, rateOffer);
router.post('/offers/report-missing', authMiddleware, reportMissingCoins);
router.post('/offers/report-dead', authMiddleware, reportDeadUrl);
router.get('/streak', authMiddleware, getStreak);
router.post('/offers/enhance', authMiddleware, enhanceOffer);
router.get('/surveys', authMiddleware, getSurveys);
router.get('/surveys/wall-url', authMiddleware, getSurveyWallUrl);
router.get('/surveys/history', authMiddleware, getSurveyHistory);

// ─── Torox wall URL (S2S session — token never sent to client) ────────────────
router.get('/torox/wall-url', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.userId!;
  try {
    const axios = (await import('axios')).default;
    const { env } = await import('../config/env');
    const resp = await axios.post(
      `https://api.wall.torox.io/partner/session?placement_id=${env.TOROX_APP_ID}&token=${env.TOROX_API_KEY}`,
      { player: { uid: userId } },
      { timeout: 10000 },
    );
    const wallUrl: string = resp.data?.wall_url;
    if (!wallUrl) throw new Error('No wall_url in response');
    return success(res, { url: wallUrl });
  } catch (err: any) {
    return error(res, err.message || 'Failed to get Torox wall URL', 500);
  }
});

// ─── Redeem (also mounted here for mobile app compatibility) ──────────────────
router.get('/redeem/packages', getRedeemPackages);
router.get('/redeem/gift-cards', authMiddleware, getGiftCards);
router.post('/redeem/request', authMiddleware, fraudCheck('withdrawal'), requestRedemption);
router.get('/redeem/history', authMiddleware, getRedemptionHistory);

// ─── Ticket Routes ────────────────────────────────────────────────────────────
router.get('/tickets/balance', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const balance = await getTicketBalance(userId);
  return success(res, { ticketBalance: balance });
});

router.get('/tickets/history', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const history = await prisma.ticketTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return success(res, history);
});

// ─── Ad Rewards ───────────────────────────────────────────────────────────────
router.post('/ad-reward', authMiddleware, fraudCheck('ad_reward'), async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const { coins = 50 } = req.body;

    // Max 10 rewarded ads per day
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayAdCount = await prisma.transaction.count({
      where: {
        userId,
        type: 'EARN_BONUS',
        description: { contains: 'Rewarded ad' },
        createdAt: { gte: today },
      },
    });

    if (todayAdCount >= 10) {
      return error(res, 'Daily ad limit reached (10/day)', 400);
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { coinBalance: { increment: coins } },
      }),
      prisma.transaction.create({
        data: {
          userId,
          type: 'EARN_BONUS',
          amount: coins,
          description: 'Rewarded ad watched',
          status: 'completed',
        },
      }),
    ]);

    await updateQuestProgress(userId, 'WATCH_ADS', 1);

    return success(res, { coins }, `+${coins} coins earned!`);
  } catch (err) {
    return error(res, 'Failed to credit ad reward', 500);
  }
});

// ─── Notifications ────────────────────────────────────────────────────────────
router.get('/notifications', authMiddleware, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const page = parseInt(String(req.query.page || '1'), 10);
  const { notifications, unreadCount } = await getUserNotifications(userId, 20, page);
  success(res, { notifications, unreadCount });
});

router.put('/notifications/read-all', authMiddleware, async (req: Request, res: Response) => {
  await markAllRead(req.userId!);
  success(res, null, 'All notifications marked as read');
});

router.put('/notifications/:id/read', authMiddleware, async (req: Request, res: Response) => {
  await prisma.notification.updateMany({
    where: { id: req.params.id as string, userId: req.userId! },
    data: { isRead: true },
  });
  success(res, null, 'Notification marked as read');
});

export default router;
