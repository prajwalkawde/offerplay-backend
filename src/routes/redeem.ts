import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import {
  getRedeemPackages,
  getGiftCards,
  requestRedemption,
  getRedemptionHistory,
  rateRedemption,
  listOptions,
  redemptionHistory,
} from '../controllers/redeemController';

const router = Router();

router.use(authMiddleware);

// New endpoints
router.get('/packages', getRedeemPackages);
router.get('/gift-cards', getGiftCards);
router.post('/request', requestRedemption);
router.get('/history', getRedemptionHistory);
router.post('/rate/:id', rateRedemption);

// Legacy compatibility
router.get('/options', listOptions);

export default router;
