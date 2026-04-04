import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authMiddleware } from '../middleware/auth';
import { fraudCheck } from '../middleware/fraud';
import {
  listContests, getContest, joinContestHandler,
  submitScoreHandler, getContestLeaderboard,
} from '../controllers/contestController';

const router = Router();

const scoreSchema = z.object({ score: z.number().int().nonnegative() });

router.get('/', listContests);
router.get('/:id', getContest);
router.post('/:id/join', authMiddleware, fraudCheck, joinContestHandler);
router.post('/:id/score', authMiddleware, validate(scoreSchema), submitScoreHandler);
router.get('/:id/leaderboard', getContestLeaderboard);

export default router;
