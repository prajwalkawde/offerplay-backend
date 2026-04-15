import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth';
import { fraudCheck } from '../middleware/fraud';
import {
  listMatches, getMatch, predict, iplLeaderboard, myPredictions, joinIPLContest, myRank,
  getMatchContestsForUser,
} from '../controllers/iplController';
import {
  getMatchesForApp,
  getResultMatchesForApp,
  joinContest,
  getContestQuestions,
  savePredictions,
  getContestLeaderboard,
  getMyContests,
  getMyPredictions,
  getMyPrize,
  claimPrize,
  getGlobalLeaderboard,
  getRank1Prize,
  calcTotalPrizePool,
  getMyPrizeHistory,
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
router.get('/results', optionalAuthMiddleware, getResultMatchesForApp);
router.post('/contests/:contestId/join',        authMiddleware, fraudCheck('ipl_contest_join'), joinContest);
router.get('/contests/:contestId/questions',    authMiddleware, getContestQuestions);
router.post('/contests/:contestId/predict',     authMiddleware, fraudCheck('ipl_predict'),      savePredictions);
router.get('/contests/:contestId/leaderboard',  optionalAuthMiddleware, getContestLeaderboard);
router.get('/my-contests', authMiddleware, getMyContests);
router.get('/contests/:contestId/my-predictions', authMiddleware, getMyPredictions);
router.get('/contests/:contestId/my-prize',     authMiddleware, getMyPrize);
router.post('/contests/:contestId/claim-prize', authMiddleware, fraudCheck('ipl_claim_prize'),  claimPrize);
router.get('/my-prizes', authMiddleware, getMyPrizeHistory);
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
    .map(c => {
      const parsedTiersConfig = typeof c.prizeTiersConfig === 'string'
        ? JSON.parse(c.prizeTiersConfig as string)
        : c.prizeTiersConfig;
      const rawTiers: any[] = Array.isArray(parsedTiersConfig) ? parsedTiersConfig as any[] : [];
      const parsedWinnersConfig = typeof (c as any).winnersConfig === 'string'
        ? JSON.parse((c as any).winnersConfig)
        : (c as any).winnersConfig;
      const rawWinners: any[] = Array.isArray(parsedWinnersConfig) ? parsedWinnersConfig : [];
      const allTiers = rawTiers.length > 0 ? rawTiers : rawWinners.map((w: any) => ({
        rankFrom: w.rankFrom, rankTo: w.rankTo, rank: w.rankFrom,
        type: 'COINS', coins: w.coins, label: w.label,
      }));
      return {
        id: c.id,
        name: c.name,
        battleType: c.battleType,
        entryType: c.entryType || 'FREE',
        entryFee: c.entryFee,
        ticketCost: c.ticketCost,
        isFree: c.isFree,
        maxPlayers: c.maxPlayers,
        currentPlayers: c._count.entries,
        spotsLeft: Math.max(0, c.maxPlayers - c._count.entries),
        isFull: c._count.entries >= c.maxPlayers,
        prizeType: c.prizeType,
        prizeCoins: c.prizeCoins,
        prizeGiftName: c.prizeGiftName,
        rewardImageUrl: c.rewardImageUrl,
        prizeTiersConfig: allTiers,
        rank1Prize: getRank1Prize({ prizeTiersConfig: allTiers }),
        totalPrizePool: calcTotalPrizePool(allTiers),
        youtubeUrl: c.youtubeUrl,
        questionCount: c.questionCount,
        questionsAvailableAt: c.questionsAvailableAt,
        questionsLockAt: c.questionsLockAt,
        regCloseTime: (c as any).regCloseTime || null,
        sponsorName: c.sponsorName,
        sponsorLogo: c.sponsorLogo,
        hasJoined: userId ? c.entries.length > 0 : false,
        displayStatus: (() => {
          const rc = (c as any).regCloseTime as Date | null;
          if (c.status === 'completed') return 'COMPLETED';
          if (rc && new Date() > new Date(rc)) return 'LOCKED';
          return 'OPEN';
        })(),
      };
    })
    .sort((a, b) => {
      if (a.battleType === 'MEGA' && b.battleType !== 'MEGA') return -1;
      if (b.battleType === 'MEGA' && a.battleType !== 'MEGA') return 1;
      return 0;
    });

  return success(res, result);
});

// ─── Existing / legacy routes ─────────────────────────────────────────────────
router.post('/join',    authMiddleware, fraudCheck('ipl_join_legacy'),    validate(joinSchema),    joinIPLContest);
router.get('/matches/:id/contests', optionalAuthMiddleware, getMatchContestsForUser);
router.get('/matches/:id', getMatch);
router.post('/predict', authMiddleware, fraudCheck('ipl_predict_legacy'), validate(predictSchema), predict);
router.get('/leaderboard', iplLeaderboard);
router.get('/my-predictions', authMiddleware, myPredictions);
router.get('/my-rank', authMiddleware, myRank);

export default router;
