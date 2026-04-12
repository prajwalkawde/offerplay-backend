import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { integrityCheck } from '../middleware/integrityCheck.middleware';
import { verifyRequestSignature } from '../middleware/requestSign.middleware';
import { logDeviceSecurity } from '../middleware/deviceSecurity.middleware';
import { fraudCheck } from '../middleware/fraud';
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
router.post('/enter',            fraudCheck('offer_enter'),   integrityCheck, enterSuperOffer);
router.post('/ad-complete',      fraudCheck('offer_ad'),      adComplete);
router.post('/install-detected', fraudCheck('offer_install'), installDetected);
router.post('/verify-usage',     fraudCheck('offer_verify'),  verifyUsage);
router.post('/complete',         fraudCheck('offer_complete'), integrityCheck, completeSuperOffer);
router.post('/fail', failSuperOffer);
router.get('/tickets', getMyTickets);
router.post('/quiz-start',    fraudCheck('super_offer_quiz_start'),    superOfferQuizStart);
router.post('/quiz-complete', fraudCheck('super_offer_quiz_complete'), superOfferQuizComplete);

export default router;
