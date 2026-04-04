import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import {
  getSuperOfferStatus,
  enterSuperOffer,
  adComplete,
  installDetected,
  verifyUsage,
  completeSuperOffer,
  failSuperOffer,
  getMyTickets,
} from '../controllers/superOffer.controller';

const router = Router();
router.use(authMiddleware);

router.get('/status', getSuperOfferStatus);
router.post('/enter', enterSuperOffer);
router.post('/ad-complete', adComplete);
router.post('/install-detected', installDetected);
router.post('/verify-usage', verifyUsage);
router.post('/complete', completeSuperOffer);
router.post('/fail', failSuperOffer);
router.get('/tickets', getMyTickets);

export default router;
