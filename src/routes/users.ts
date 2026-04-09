import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import {
  getProfile, updateProfile, getTransactions,
  getStats, getUserReferrals, validateReferralCode, getWalletData,
} from '../controllers/userController';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';

const router = Router();

router.use(authMiddleware);

router.get('/me', getProfile);
router.put('/me', updateProfile);
router.get('/me/transactions', getTransactions);
router.get('/me/stats', getStats);
router.get('/me/referrals', getUserReferrals);
router.get('/referral/:code', validateReferralCode);
router.get('/wallet', getWalletData);

router.get('/me/onesignal-debug', async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { id: true, name: true, phone: true, oneSignalPlayerId: true },
  });
  const hasApiKey = !!(process.env.ONESIGNAL_REST_API_KEY);
  const hasAppId  = !!(process.env.ONESIGNAL_APP_ID);
  return success(res, {
    user,
    config: { hasAppId, hasApiKey },
    status: user?.oneSignalPlayerId
      ? (hasApiKey ? 'ready' : 'player_id_saved_but_no_api_key')
      : 'no_player_id_registered',
  });
});

// Test: send a push notification to yourself
router.post('/me/onesignal-test', async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { id: true, oneSignalPlayerId: true },
  });
  if (!user?.oneSignalPlayerId) {
    return error(res, 'No OneSignal player ID registered for this user', 400);
  }
  const { sendBulkNotification } = await import('../services/notificationService');
  await sendBulkNotification(
    [user.id],
    '🔔 Test Notification',
    'OneSignal push is working!',
    'TEST',
  );
  return success(res, { playerId: user.oneSignalPlayerId }, 'Test notification sent');
});

router.post('/me/onesignal-token', async (req: Request, res: Response) => {
  const { playerId } = req.body as { playerId?: string };
  if (!playerId) return error(res, 'playerId is required', 400);

  await prisma.user.update({
    where: { id: req.userId! },
    data: { oneSignalPlayerId: playerId },
  });

  return success(res, null, 'OneSignal token saved');
});

export default router;
