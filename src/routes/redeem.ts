import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { fraudCheck } from '../middleware/fraud';
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
router.post('/request', fraudCheck('withdrawal'), requestRedemption);
router.get('/history', getRedemptionHistory);
router.post('/rate/:id', rateRedemption);

// Legacy compatibility
router.get('/options', listOptions);

export default router;
