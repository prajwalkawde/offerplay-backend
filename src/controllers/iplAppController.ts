import { Request, Response } from 'express';
import { TransactionType } from '@prisma/client';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';

// ─── GET /api/ipl/matches ─────────────────────────────────────────────────────
// Returns upcoming matches (next 7 days) with published contests + user state
export async function getMatchesForApp(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);

    const matches = await prisma.iplMatch.findMany({
      where: {
        matchDate: { gte: today, lte: nextWeek },
        status: { not: 'cancelled' },
      },
      include: {
        questions: { select: { id: true } },
        contests: {
          where: { status: 'published' },
          include: {
            _count: { select: { entries: true } },
            // Fetch the calling user's entry (or nothing if not logged in)
            entries: {
              where: userId ? { userId } : { userId: '' },
              take: 1,
            },
          },
          orderBy: [{ battleType: 'asc' }, { entryFee: 'desc' }],
        },
      },
      orderBy: { matchDate: 'asc' },
    });

    const result = matches.map(match => ({
      ...match,
      isToday: match.matchDate.toDateString() === new Date().toDateString(),
      questionCount: match.questions.length,
      questions: undefined,
      contests: match.contests
        .map(c => ({
          id: c.id,
          name: c.name,
          battleType: c.battleType,
          contestType: c.contestType,
          entryFee: c.entryFee,
          isFree: c.isFree,
          maxPlayers: c.maxPlayers,
          currentPlayers: c._count.entries,
          spotsLeft: Math.max(0, c.maxPlayers - c._count.entries),
          isFull: c._count.entries >= c.maxPlayers,
          prizeType: c.prizeType,
          prizeCoins: c.prizeCoins,
          prizeGiftName: c.prizeGiftName,
          rewardImageUrl: c.rewardImageUrl,
          youtubeUrl: c.youtubeUrl,
          questionCount: c.questionCount,
          sponsorName: c.sponsorName,
          sponsorLogo: c.sponsorLogo,
          maxEntriesPerUser: c.maxEntriesPerUser,
          hasJoined: c.entries.length > 0,
        }))
        // MEGA first, then by entry fee descending
        .sort((a, b) => {
          if (a.battleType === 'MEGA' && b.battleType !== 'MEGA') return -1;
          if (b.battleType === 'MEGA' && a.battleType !== 'MEGA') return 1;
          return 0;
        }),
    }));

    success(res, result);
  } catch (err) {
    logger.error('getMatchesForApp error:', err);
    error(res, 'Failed to fetch matches', 500);
  }
}

// ─── POST /api/ipl/contests/:contestId/join ───────────────────────────────────
export async function joinContest(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { contestId } = req.params as { contestId: string };

  try {
    const contest = await prisma.iplContest.findUnique({
      where: { id: contestId },
      include: {
        _count: { select: { entries: true } },
        match: {
          include: {
            questions: { where: { status: 'active' }, select: { id: true } },
          },
        },
      },
    });

    if (!contest) { error(res, 'Contest not found', 404); return; }
    if (contest.status !== 'published') {
      error(res, 'Contest not available', 400); return;
    }

    // Already joined?
    const existing = await prisma.iplContestEntry.findUnique({
      where: { contestId_userId: { contestId, userId } },
    });
    if (existing) { error(res, 'Already joined!', 400); return; }

    // Contest full?
    if (contest._count.entries >= contest.maxPlayers) {
      error(res, 'Contest is full!', 400); return;
    }

    // Max entries per user per match + battle-type
    const userMatchEntries = await prisma.iplContestEntry.count({
      where: { userId, contest: { matchId: contest.matchId, battleType: contest.battleType } },
    });
    if (userMatchEntries >= (contest.maxEntriesPerUser || 3)) {
      error(res, `Max ${contest.maxEntriesPerUser || 3} entries per match type`, 400);
      return;
    }

    const entryType = contest.entryType || 'FREE';

    if (entryType === 'TICKET') {
      const ticketCost = contest.ticketCost || 1;
      const { spendTickets } = await import('../services/ticketService');
      const result = await spendTickets(userId, ticketCost, `Contest entry: ${contest.name}`, contestId);
      if (!result.success) { error(res, result.error || 'Insufficient tickets!', 400); return; }

    } else if (entryType === 'COINS') {
      const entryFee = contest.entryFee || 0;
      if (entryFee > 0) {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { coinBalance: true } });
        if (!user || user.coinBalance < entryFee) { error(res, 'Insufficient coins!', 400); return; }
        await prisma.user.update({ where: { id: userId }, data: { coinBalance: { decrement: entryFee } } });
        await prisma.transaction.create({
          data: { userId, type: TransactionType.SPEND_IPL_ENTRY, amount: entryFee, refId: contestId, description: `Joined: ${contest.name}`, status: 'completed' },
        });
      }
    }
    // FREE — no deduction needed

    await prisma.$transaction([
      prisma.iplContestEntry.create({
        data: { userId, contestId, matchId: contest.matchId, coinsDeducted: entryType === 'COINS' ? (contest.entryFee || 0) : 0 },
      }),
      prisma.iplContest.update({
        where: { id: contestId },
        data: { currentPlayers: { increment: 1 } },
      }),
    ]);

    const now = new Date();
    const questionsAvailable =
      !contest.questionsAvailableAt || contest.questionsAvailableAt <= now;
    const questionCount = contest.match?.questions?.length ?? 0;

    success(res, {
      contestId,
      entryType,
      ticketsSpent: entryType === 'TICKET' ? (contest.ticketCost || 1) : 0,
      coinsSpent: entryType === 'COINS' ? (contest.entryFee || 0) : 0,
      questionsAvailable,
      questionsAvailableAt: contest.questionsAvailableAt,
      questionCount,
      matchId: contest.matchId,
    }, 'Successfully joined contest!');
  } catch (err) {
    logger.error('joinContest error:', err);
    error(res, 'Failed to join contest', 500);
  }
}

// ─── GET /api/ipl/contests/:contestId/questions ───────────────────────────────
export async function getContestQuestions(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { contestId } = req.params as { contestId: string };

  try {
    const entry = await prisma.iplContestEntry.findUnique({
      where: { contestId_userId: { contestId, userId } },
      include: {
        contest: {
          include: {
            match: {
              include: {
                questions: {
                  where: { status: 'active' },
                  orderBy: { id: 'asc' },
                },
              },
            },
          },
        },
      },
    });

    if (!entry) { error(res, 'Join the contest first!', 400); return; }

    const contest = entry.contest;
    const now = new Date();

    if (contest.questionsAvailableAt && contest.questionsAvailableAt > now) {
      success(res, {
        questionsAvailable: false,
        questionsAvailableAt: contest.questionsAvailableAt,
        message: 'Questions not available yet',
        questions: [],
      });
      return;
    }

    const predictionsLocked =
      !!contest.questionsLockAt && contest.questionsLockAt <= now;

    const questions = contest.match?.questions ?? [];

    if (questions.length === 0) {
      success(res, {
        questionsAvailable: true,
        questionsLocked: predictionsLocked,
        questions: [],
        message: 'No questions available for this match yet',
      });
      return;
    }

    const matchId = contest.match?.id;
    const predictions = matchId
      ? await prisma.iplPrediction.findMany({ where: { userId, matchId } })
      : [];

    const predMap: Record<string, string> = {};
    predictions.forEach((p: { questionId: string; answer: string }) => {
      predMap[p.questionId] = p.answer;
    });

    success(res, {
      questionsAvailable: true,
      questionsLocked: predictionsLocked,
      questionsLockAt: contest.questionsLockAt,
      questions: questions.map((q: { id: string; question: string; options: unknown; points: number; difficulty: string; category: string; correctAnswer: string | null }) => ({
        id: q.id,
        question: q.question,
        options: q.options,
        points: q.points,
        difficulty: q.difficulty || 'medium',
        category: q.category || 'prediction',
        myAnswer: predMap[q.id] || null,
        correctAnswer: predictionsLocked ? q.correctAnswer : null,
      })),
      totalQuestions: questions.length,
      answeredCount: predictions.length,
    });
  } catch (err) {
    logger.error('getContestQuestions error:', err);
    error(res, 'Failed to fetch questions', 500);
  }
}

// ─── POST /api/ipl/contests/:contestId/predict ────────────────────────────────
// predictions = [{ questionId, answer }]
export async function savePredictions(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { contestId } = req.params as { contestId: string };
  const { predictions } = req.body as { predictions: Array<{ questionId: string; answer: string }> };

  if (!Array.isArray(predictions) || predictions.length === 0) {
    error(res, 'predictions array is required', 400); return;
  }

  try {
    // Verify user joined this contest
    const entry = await prisma.iplContestEntry.findFirst({
      where: { userId, contestId },
      include: { contest: { select: { matchId: true } } },
    });
    if (!entry) { error(res, 'Join the contest first', 400); return; }

    const matchId = entry.contest.matchId;

    // Upsert each prediction — key is userId_questionId (per existing schema)
    for (const pred of predictions) {
      await prisma.iplPrediction.upsert({
        where: { userId_questionId: { userId, questionId: pred.questionId } },
        update: { answer: pred.answer },
        create: { userId, matchId, questionId: pred.questionId, answer: pred.answer },
      });
    }

    success(res, { predictionsCount: predictions.length }, 'Predictions saved!');
  } catch (err) {
    logger.error('savePredictions error:', err);
    error(res, 'Failed to save predictions', 500);
  }
}

// ─── GET /api/ipl/contests/:contestId/leaderboard ────────────────────────────
export async function getContestLeaderboard(req: Request, res: Response): Promise<void> {
  const userId = req.userId;
  const { contestId } = req.params as { contestId: string };

  try {
    const contest = await prisma.iplContest.findUnique({
      where: { id: contestId },
      include: { match: { select: { team1: true, team2: true } } },
    });
    if (!contest) { error(res, 'Contest not found', 404); return; }

    const entries = await prisma.iplContestEntry.findMany({
      where: { contestId },
      include: { user: { select: { id: true, name: true, phone: true } } },
      orderBy: [{ totalPoints: 'desc' }, { joinedAt: 'asc' }],
      take: 100,
    });

    const leaderboard = entries.map((entry, i) => ({
      rank: i + 1,
      userId: entry.userId,
      name: entry.user.name?.split(' ')[0] ?? `User${entry.userId.slice(0, 4)}`,
      fullName: entry.user.name ?? 'Unknown',
      avatar: (entry.user.name?.charAt(0) ?? 'U').toUpperCase(),
      totalPoints: entry.totalPoints,
      coinsWon: entry.coinsWon,
      isCurrentUser: entry.userId === userId,
    }));

    const userRank = leaderboard.find(e => e.isCurrentUser);

    success(res, {
      leaderboard,
      totalEntries: entries.length,
      contestName: contest.name,
      matchName: `${contest.match.team1} vs ${contest.match.team2}`,
      status: contest.status,
      userRank: userRank?.rank ?? null,
      userPoints: userRank?.totalPoints ?? 0,
    });
  } catch (err) {
    logger.error('getContestLeaderboard error:', err);
    error(res, 'Failed to fetch leaderboard', 500);
  }
}

// ─── GET /api/ipl/my-contests ─────────────────────────────────────────────────
export async function getMyContests(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;

  try {
    const entries = await prisma.iplContestEntry.findMany({
      where: { userId },
      include: {
        contest: {
          include: {
            match: {
              select: {
                id: true,
                team1: true,
                team2: true,
                matchDate: true,
                status: true,
                result: true,
                youtubeUrl: true,
              },
            },
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
      take: 50,
    });

    const now = new Date();

    const result = entries.map(entry => {
      const contest = entry.contest;
      const questionsAvailable =
        !contest.questionsAvailableAt || contest.questionsAvailableAt <= now;
      const predictionsLocked =
        !!contest.questionsLockAt && contest.questionsLockAt <= now;

      return {
        entryId: entry.id,
        contestId: contest.id,
        contestName: contest.name,
        battleType: contest.battleType,
        ticketsSpent: contest.ticketCost,
        rank: entry.rank,
        totalPoints: entry.totalPoints,
        coinsWon: entry.coinsWon,
        status: contest.status,
        matchId: contest.matchId,
        matchTeam1: contest.match.team1,
        matchTeam2: contest.match.team2,
        matchDate: contest.match.matchDate,
        matchStatus: contest.match.status,
        result: contest.match.result,
        youtubeUrl: contest.match.youtubeUrl,
        joinedAt: entry.joinedAt,
        questionsAvailable,
        questionsAvailableAt: contest.questionsAvailableAt,
        predictionsLocked,
        questionsLockAt: contest.questionsLockAt,
      };
    });

    const active = result.filter(e => e.status === 'published' && !e.predictionsLocked);
    const pending = result.filter(e => e.status === 'published' && !e.questionsAvailable);
    const completed = result.filter(e => e.status === 'completed');

    success(res, {
      all: result,
      active,
      pending,
      completed,
      totalJoined: result.length,
    });
  } catch (err) {
    logger.error('getMyContests error:', err);
    error(res, 'Failed to fetch contests', 500);
  }
}

// ─── GET /api/ipl/contests/:contestId/my-predictions ─────────────────────────
export async function getMyPredictions(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { contestId } = req.params as { contestId: string };

  try {
    const entry = await prisma.iplContestEntry.findFirst({
      where: { userId, contestId },
      include: { contest: { select: { matchId: true } } },
    });
    if (!entry) { error(res, 'Not joined this contest', 400); return; }

    const predictions = await prisma.iplPrediction.findMany({
      where: { userId, matchId: entry.contest.matchId },
      include: {
        question: { select: { question: true, options: true, correctAnswer: true, points: true } },
      },
    });

    success(res, {
      predictions: predictions.map(p => ({
        questionId: p.questionId,
        question: p.question?.question,
        options: p.question?.options,
        myAnswer: p.answer,
        correctAnswer: p.question?.correctAnswer ?? null,
        isCorrect: p.isCorrect,
        pointsEarned: p.pointsEarned,
        maxPoints: p.question?.points ?? 100,
      })),
      totalPoints: entry.totalPoints,
      rank: entry.rank,
      coinsWon: entry.coinsWon,
    });
  } catch (err) {
    logger.error('getMyPredictions error:', err);
    error(res, 'Failed to fetch predictions', 500);
  }
}

// ─── GET /api/ipl/global-leaderboard ─────────────────────────────────────────
export async function getGlobalLeaderboard(req: Request, res: Response): Promise<void> {
  const userId = req.userId;

  try {
    const topEntries = await prisma.iplContestEntry.groupBy({
      by: ['userId'],
      _sum: { totalPoints: true, coinsWon: true },
      _count: { id: true },
      orderBy: { _sum: { totalPoints: 'desc' } },
      take: 50,
    });

    const userIds = topEntries.map(e => e.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const userMap = new Map(users.map(u => [u.id, u.name]));

    const leaderboard = topEntries.map((entry, i) => ({
      rank: i + 1,
      userId: entry.userId,
      name: userMap.get(entry.userId)?.split(' ')[0] ?? `User${entry.userId.slice(0, 4)}`,
      avatar: (userMap.get(entry.userId)?.charAt(0) ?? 'U').toUpperCase(),
      totalPoints: entry._sum.totalPoints ?? 0,
      coinsWon: entry._sum.coinsWon ?? 0,
      contestsPlayed: entry._count.id,
      isCurrentUser: entry.userId === userId,
    }));

    success(res, leaderboard);
  } catch (err) {
    logger.error('getGlobalLeaderboard error:', err);
    error(res, 'Failed to fetch leaderboard', 500);
  }
}
