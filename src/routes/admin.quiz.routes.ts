import { Router } from 'express';
import { adminAuthMiddleware } from '../middleware/adminAuth';
import {
  adminGetQuestions,
  adminCreateQuestion,
  adminUpdateQuestion,
  adminDeleteQuestion,
  adminGenerateQuestions,
  adminGetSettings,
  adminUpdateSettings,
  adminGetAnalytics,
} from '../controllers/admin.quiz.controller';

const router = Router();
router.use(adminAuthMiddleware);

router.get('/questions', adminGetQuestions);
router.post('/questions', adminCreateQuestion);
router.put('/questions/:id', adminUpdateQuestion);
router.delete('/questions/:id', adminDeleteQuestion);
router.post('/generate', adminGenerateQuestions);
router.get('/settings', adminGetSettings);
router.put('/settings', adminUpdateSettings);
router.get('/analytics', adminGetAnalytics);

export default router;
