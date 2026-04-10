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

// Save FCM token for push notifications
router.post('/me/fcm-token', async (req: Request, res: Response) => {
  const { fcmToken } = req.body as { fcmToken?: string };
  if (!fcmToken) return error(res, 'fcmToken is required', 400);

  await prisma.user.update({
    where: { id: req.userId! },
    data: { fcmToken },
  });

  return success(res, null, 'FCM token saved');
});

// Debug: check FCM status for current user
router.get('/me/fcm-debug', async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { id: true, name: true, phone: true, fcmToken: true },
  });
  return success(res, {
    user,
    status: user?.fcmToken ? 'ready' : 'no_fcm_token',
  });
});

// Test: send a push notification to yourself
router.post('/me/push-test', async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { id: true, fcmToken: true },
  });
  if (!user?.fcmToken) {
    return error(res, 'No FCM token registered for this user', 400);
  }
  const { sendBulkNotification } = await import('../services/notificationService');
  await sendBulkNotification(
    [user.id],
    '🔔 Test Notification',
    'FCM push is working!',
    'TEST',
  );
  return success(res, null, 'Test notification sent');
});

export default router;
