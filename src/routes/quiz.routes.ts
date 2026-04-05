import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
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

router.post('/start', startStage);
router.post('/questions', getQuestions);
router.post('/hint', useHint);
router.post('/claim', claimStage);
router.post('/bonus', claimBonusTicket);
router.post('/extra-ticket', claimExtraTicket);
router.get('/status', getQuizStatus);

export default router;
