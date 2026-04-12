import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { integrityCheck } from '../middleware/integrityCheck.middleware';
import { verifyRequestSignature } from '../middleware/requestSign.middleware';
import { logDeviceSecurity } from '../middleware/deviceSecurity.middleware';
import {
  getSuperOfferStatus,
  enterSuperOffer,
  adComplete,
  installDetected,
  verifyUsage,
  completeSuperOffer,
  failSuperOffer,
  getMyTickets,
  superOfferQuizStart,
  superOfferQuizComplete,
} from '../controllers/superOffer.controller';

const router = Router();
router.use(authMiddleware);
router.use(logDeviceSecurity);
router.use(verifyRequestSignature);

router.get('/status', getSuperOfferStatus);
router.post('/enter', integrityCheck, enterSuperOffer);
router.post('/ad-complete', adComplete);
router.post('/install-detected', installDetected);
router.post('/verify-usage', verifyUsage);
router.post('/complete', integrityCheck, completeSuperOffer);
router.post('/fail', failSuperOffer);
router.get('/tickets', getMyTickets);
router.post('/quiz-start', superOfferQuizStart);
router.post('/quiz-complete', superOfferQuizComplete);

export default router;
