import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import {
  getProfile, updateProfile, getTransactions,
  getStats, getUserReferrals, validateReferralCode,
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
