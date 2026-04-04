import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth';
import {
  listMatches, getMatch, predict, iplLeaderboard, myPredictions, joinIPLContest, myRank,
  getMatchContestsForUser,
} from '../controllers/iplController';
import {
  getMatchesForApp,
  joinContest,
  getContestQuestions,
  savePredictions,
  getContestLeaderboard,
  getMyContests,
  getMyPredictions,
  getGlobalLeaderboard,
} from '../controllers/iplAppController';
import { prisma } from '../config/database';
import { success } from '../utils/response';

const router = Router();

const predictSchema = z.object({
  matchId: z.string().cuid(),
  questionId: z.string().cuid(),
  answer: z.string().min(1),
});

const joinSchema = z.object({
  matchId: z.string().min(1),
  entryFee: z.number().int().positive(),
});

// ─── App-facing routes ────────────────────────────────────────────────────────
router.get('/matches', optionalAuthMiddleware, getMatchesForApp);
router.post('/contests/:contestId/join', authMiddleware, joinContest);
router.get('/contests/:contestId/questions', authMiddleware, getContestQuestions);
router.post('/contests/:contestId/predict', authMiddleware, savePredictions);
router.get('/contests/:contestId/leaderboard', optionalAuthMiddleware, getContestLeaderboard);
router.get('/my-contests', authMiddleware, getMyContests);
router.get('/contests/:contestId/my-predictions', authMiddleware, getMyPredictions);
router.get('/global-leaderboard', optionalAuthMiddleware, getGlobalLeaderboard);
router.get('/matches/:matchId/contests', optionalAuthMiddleware, async (req, res) => {
  const { matchId } = req.params as { matchId: string };
  const userId = (req as any).userId as string | undefined;
  const contests = await prisma.iplContest.findMany({
    where: { matchId, status: 'published' },
    include: {
      _count: { select: { entries: true } },
      entries: userId ? { where: { userId }, take: 1 } : { take: 0 },
    },
    orderBy: [{ battleType: 'asc' }],
  });

  const result = contests
    .map(c => ({
      ...c,
      currentPlayers: c._count.entries,
      spotsLeft: Math.max(0, c.maxPlayers - c._count.entries),
      isFull: c._count.entries >= c.maxPlayers,
      hasJoined: userId ? c.entries.length > 0 : false,
      _count: undefined,
      entries: undefined,
    }))
    .sort((a, b) => {
      if (a.battleType === 'MEGA' && b.battleType !== 'MEGA') return -1;
      if (b.battleType === 'MEGA' && a.battleType !== 'MEGA') return 1;
      return 0;
    });

  return success(res, result);
});

// ─── Existing / legacy routes ─────────────────────────────────────────────────
router.post('/join', authMiddleware, validate(joinSchema), joinIPLContest);
router.get('/matches/:id/contests', getMatchContestsForUser);
router.get('/matches/:id', getMatch);
router.post('/predict', authMiddleware, validate(predictSchema), predict);
router.get('/leaderboard', iplLeaderboard);
router.get('/my-predictions', authMiddleware, myPredictions);
router.get('/my-rank', authMiddleware, myRank);

export default router;
