import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { integrityCheck } from '../middleware/integrityCheck.middleware';
import { verifyRequestSignature } from '../middleware/requestSign.middleware';
import { logDeviceSecurity } from '../middleware/deviceSecurity.middleware';
import { fraudCheck } from '../middleware/fraud';
import {
  startStage,
  getQuestions,
  useHint,
  claimStage,
  claimBonusTicket,
  getQuizStatus,
  claimExtraTicket,
} from '../controllers/quiz.controller';

const router = Router();
router.use(authMiddleware);
router.use(logDeviceSecurity);
router.use(verifyRequestSignature);

router.post('/start',        fraudCheck('quiz_start'), startStage);
router.post('/questions', getQuestions);
router.post('/hint',         fraudCheck('quiz_hint'),  useHint);
router.post('/claim',        fraudCheck('quiz_claim'), integrityCheck, claimStage);
router.post('/bonus',        fraudCheck('quiz_bonus'), claimBonusTicket);
router.post('/extra-ticket', fraudCheck('quiz_extra'), claimExtraTicket);
router.get('/status', getQuizStatus);

export default router;
