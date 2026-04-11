import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { submitPrediction, getLeaderboard } from '../services/iplService';
import { debitCoins } from '../services/coinService';
import { success, error, paginated } from '../utils/response';
import { qs } from '../utils/query';
import { getRank1Prize, calcTotalPrizePool } from './iplAppController';

export async function listMatches(req: Request, res: Response): Promise<void> {
  const status = qs(req.query.status);
  const page = parseInt(qs(req.query.page) ?? '1', 10);
  const limit = Math.min(parseInt(qs(req.query.limit) ?? '20', 10), 50);
  const skip = (page - 1) * limit;

  const where = { ...(status && { status }) };
  const [matches, total] = await Promise.all([
    prisma.iplMatch.findMany({ where, orderBy: { matchDate: 'asc' }, skip, take: limit }),
    prisma.iplMatch.count({ where }),
  ]);

  paginated(res, matches, total, page, limit);
}

export async function getMatch(req: Request, res: Response): Promise<void> {
  const match = await prisma.iplMatch.findUnique({
    where: { id: req.params.id as string },
    include: {
      questions: {
        where: { status: 'active' },
        select: { id: true, question: true, options: true, points: true, status: true },
      },
    },
  });

  if (!match) { error(res, 'Match not found', 404); return; }
  success(res, match);
}

export async function predict(req: Request, res: Response): Promise<void> {
  const { matchId, questionId, answer } = req.body as {
    matchId: string; questionId: string; answer: string;
  };

  try {
    await submitPrediction(req.userId!, matchId, questionId, answer);
    success(res, null, 'Prediction submitted', 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Prediction failed';
    error(res, msg, 400);
  }
}

export async function iplLeaderboard(req: Request, res: Response): Promise<void> {
  const limit = Math.min(parseInt(qs(req.query.limit) ?? '50', 10), 100);
  const data = await getLeaderboard(limit);
  success(res, data);
}

export async function joinIPLContest(req: Request, res: Response): Promise<void> {
  const { matchId, entryFee } = req.body as { matchId: string; entryFee: number };
  const userId = req.userId!;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { coinBalance: true },
    });

    if (!user || user.coinBalance < entryFee) {
      error(res, 'Insufficient coins', 400);
      return;
    }

    await debitCoins(userId, entryFee, 'SPEND_IPL_ENTRY', matchId, 'IPL match prediction entry fee');

    success(res, {
      newBalance: user.coinBalance - entryFee,
      message: 'Entry fee deducted successfully',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to join contest';
    error(res, msg, 500);
  }
}

export async function getMatchContestsForUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params as { id: string };

  const contests = await prisma.iplContest.findMany({
    where: { matchId: id, status: { in: ['published', 'live'] } },
    include: { _count: { select: { entries: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const result = contests.map(c => {
    const parsedTiers = typeof c.prizeTiersConfig === 'string'
      ? JSON.parse(c.prizeTiersConfig as string)
      : c.prizeTiersConfig;
    const allTiers: any[] = Array.isArray(parsedTiers) ? parsedTiers : [];

    return {
      id: c.id,
      matchId: c.matchId,
      name: c.name,
      contestType: c.contestType,
      battleType: c.battleType,
      maxPlayers: c.maxPlayers,
      minPlayers: c.minPlayers,
      currentPlayers: c._count.entries,
      spotsLeft: Math.max(0, c.maxPlayers - c._count.entries),
      isFull: c._count.entries >= c.maxPlayers,
      entryFee: c.entryFee,
      ticketCost: c.ticketCost,
      isFree: c.isFree,
      entryType: c.entryType || 'FREE',
      prizeType: c.prizeType,
      prizeCoins: c.prizeCoins,
      prizeGiftName: c.prizeGiftName,
      prizeGiftValue: c.prizeGiftValue,
      prizeDistribution: c.prizeDistribution,
      prizeTiersConfig: allTiers,
      rank1Prize: getRank1Prize({ prizeTiersConfig: allTiers }),
      totalPrizePool: calcTotalPrizePool(allTiers),
      regCloseTime: c.regCloseTime,
      questionsAvailableAt: c.questionsAvailableAt,
      questionsLockAt: c.questionsLockAt,
      sponsorName: c.sponsorName,
      sponsorLogo: c.sponsorLogo,
      youtubeUrl: c.youtubeUrl,
      maxEntriesPerUser: c.maxEntriesPerUser,
      botCount: c.botCount,
      questionCount: c.questionCount,
      status: c.status,
    };
  });

  success(res, result);
}

export async function joinContestById(req: Request, res: Response): Promise<void> {
  const { contestId } = req.params as { contestId: string };
  const userId = req.userId!;

  try {
    const contest = await prisma.iplContest.findUnique({ where: { id: contestId } });
    if (!contest) { error(res, 'Contest not found', 404); return; }
    if (contest.status !== 'published' && contest.status !== 'live') {
      error(res, 'Contest is not available', 400); return;
    }

    const existing = await prisma.iplContestEntry.findFirst({ where: { userId, contestId } });
    if (existing) { error(res, 'Already joined this contest', 400); return; }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { coinBalance: true } });
    if (!user || user.coinBalance < contest.entryFee) {
      error(res, 'Insufficient coins', 400); return;
    }

    const currentCount = await prisma.iplContestEntry.count({ where: { contestId } });
    if (currentCount >= contest.maxPlayers) { error(res, 'Contest is full', 400); return; }

    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { coinBalance: { decrement: contest.entryFee } } }),
      prisma.iplContestEntry.create({ data: { userId, contestId, coinsDeducted: contest.entryFee } }),
      prisma.transaction.create({
        data: {
          userId, type: 'SPEND_IPL_ENTRY', amount: contest.entryFee,
          refId: contestId, description: `IPL Contest entry: ${contest.name}`,
        },
      }),
    ]);

    success(res, { newBalance: user.coinBalance - contest.entryFee }, 'Successfully joined contest!');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to join contest';
    error(res, msg, 500);
  }
}

export async function saveContestPredictions(req: Request, res: Response): Promise<void> {
  const { contestId } = req.params as { contestId: string };
  const userId = req.userId!;
  const { predictions } = req.body as { predictions: Array<{ questionId: string; answer: string }> };

  if (!Array.isArray(predictions) || predictions.length === 0) {
    error(res, 'predictions array is required', 400); return;
  }

  try {
    const entry = await prisma.iplContestEntry.findFirst({ where: { userId, contestId } });
    if (!entry) { error(res, 'Not joined this contest', 400); return; }

    const contest = await prisma.iplContest.findUnique({ where: { id: contestId } });
    if (!contest) { error(res, 'Contest not found', 404); return; }

    for (const pred of predictions) {
      await prisma.iplPrediction.upsert({
        where: { userId_questionId: { userId, questionId: pred.questionId } },
        update: { answer: pred.answer },
        create: {
          userId, matchId: contest.matchId,
          questionId: pred.questionId, answer: pred.answer,
        },
      });
    }

    success(res, null, 'Predictions saved!');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to save predictions';
    error(res, msg, 500);
  }
}

export async function myRank(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;

  const [userPoints, allPoints] = await Promise.all([
    prisma.iplPrediction.aggregate({
      where: { userId },
      _sum: { pointsEarned: true },
    }),
    prisma.iplPrediction.groupBy({
      by: ['userId'],
      _sum: { pointsEarned: true },
      orderBy: { _sum: { pointsEarned: 'desc' } },
    }),
  ]);

  const myTotal = userPoints._sum.pointsEarned ?? 0;
  const rank = allPoints.findIndex((r) => r.userId === userId) + 1;
  const totalPlayers = allPoints.length;

  success(res, {
    rank: rank > 0 ? rank : null,
    totalPoints: myTotal,
    totalPlayers,
  });
}

export async function myPredictions(req: Request, res: Response): Promise<void> {
  const page = parseInt(qs(req.query.page) ?? '1', 10);
  const limit = Math.min(parseInt(qs(req.query.limit) ?? '20', 10), 50);
  const skip = (page - 1) * limit;

  const where = { userId: req.userId! };
  const [predictions, total] = await Promise.all([
    prisma.iplPrediction.findMany({
      where,
      include: {
        match: { select: { team1: true, team2: true, matchDate: true } },
        question: { select: { question: true, options: true, correctAnswer: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.iplPrediction.count({ where }),
  ]);

  paginated(res, predictions, total, page, limit);
}
