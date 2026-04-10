import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { scoreMatch } from '../services/iplService';
import { finalizeContest } from '../services/contestService';
import { success, error, paginated } from '../utils/response';
import { qs } from '../utils/query';
import { ContestStatus, ContestType, PrizeType, TransactionType, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { generateQuestionsForTodayMatches, verifyMatchResults as verifyMatchResultsJob } from '../jobs/iplQuizJob';

// ─── Admin Users (rich list with tx count) ────────────────────────────────────
export async function getAdminUsers(req: Request, res: Response): Promise<void> {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(100, parseInt(String(req.query.limit || '50'), 10));
    const search = req.query.search ? String(req.query.search) : undefined;
    const status = req.query.status && req.query.status !== 'all' ? String(req.query.status) : undefined;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, name: true, phone: true, email: true,
          coinBalance: true, status: true, createdAt: true,
          _count: { select: { transactions: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    success(res, { users, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    logger.error('getAdminUsers error:', err);
    error(res, 'Failed to get users', 500);
  }
}

// ─── Admin Users — Single user detail ─────────────────────────────────────────
export async function getUserDetails(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params as { userId: string };
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        transactions: { orderBy: { createdAt: 'desc' }, take: 20 },
      },
    });
    if (!user) { error(res, 'User not found', 404); return; }
    success(res, user);
  } catch (err) {
    error(res, 'Failed', 500);
  }
}

// ─── Admin Users — Status update ──────────────────────────────────────────────
export async function updateUserStatus(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params as { userId: string };
    const { status } = req.body as { status: 'ACTIVE' | 'SUSPENDED' | 'BANNED' };
    const user = await prisma.user.update({ where: { id: userId }, data: { status } });
    success(res, user, `User ${status}!`);
  } catch (err) {
    error(res, 'Failed', 500);
  }
}

// ─── Admin Users — Adjust coins ───────────────────────────────────────────────
export async function adjustUserCoins(req: Request, res: Response): Promise<void> {
  try {
    const { userId } = req.params as { userId: string };
    const { action, amount, reason } = req.body as {
      action: 'add' | 'deduct';
      amount: number;
      reason?: string;
    };

    if (!amount || amount <= 0) { error(res, 'Valid amount required', 400); return; }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, coinBalance: true },
    });
    if (!user) { error(res, 'User not found', 404); return; }

    const coinChange = action === 'add' ? parseInt(String(amount)) : -parseInt(String(amount));

    if (action === 'deduct' && user.coinBalance < parseInt(String(amount))) {
      error(res, 'User has insufficient coins', 400);
      return;
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { coinBalance: { increment: coinChange } },
      }),
      prisma.transaction.create({
        data: {
          userId,
          type: action === 'add' ? TransactionType.ADMIN_CREDIT : TransactionType.ADMIN_DEBIT,
          amount: coinChange,
          description: reason || `Admin ${action}: ${amount} coins`,
          status: 'completed',
        },
      }),
    ]);

    const updated = await prisma.user.findUnique({
      where: { id: userId },
      select: { coinBalance: true },
    });

    success(res, { newBalance: updated?.coinBalance, coinChange },
      `${action === 'add' ? 'Added' : 'Deducted'} ${amount} coins!`);
  } catch (err) {
    logger.error('adjustUserCoins error:', err);
    error(res, 'Failed to adjust coins', 500);
  }
}

// ─── Admin Transactions — List ─────────────────────────────────────────────────
export async function getAdminTransactions(req: Request, res: Response): Promise<void> {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(100, parseInt(String(req.query.limit || '50'), 10));
    const type = req.query.type && req.query.type !== 'all' ? String(req.query.type) : undefined;
    const userId = req.query.userId ? String(req.query.userId) : undefined;
    const search = req.query.search ? String(req.query.search) : undefined;

    const where: Record<string, unknown> = {};
    if (type) where.type = type;
    if (userId) where.userId = userId;
    if (search) {
      where.user = {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      };
    }

    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, phone: true, email: true, coinBalance: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.transaction.count({ where }),
    ]);

    success(res, { transactions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    logger.error('getAdminTransactions error:', err);
    error(res, 'Failed to get transactions', 500);
  }
}

// ─── Admin Transactions — CSV Export ──────────────────────────────────────────
export async function exportTransactionsCSV(req: Request, res: Response): Promise<void> {
  try {
    const transactions = await prisma.transaction.findMany({
      include: { user: { select: { name: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10000,
    });

    const csv = [
      'ID,User,Phone,Type,Amount,Description,Date',
      ...transactions.map(t =>
        `${t.id},${t.user?.name || ''},${t.user?.phone || ''},${t.type},${t.amount},"${t.description || ''}",${t.createdAt}`
      ),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=transactions.csv');
    res.send(csv);
  } catch (err) {
    error(res, 'Export failed', 500);
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export async function adminLogin(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email: string; password: string };

  if (!email || !password) {
    error(res, 'Email and password required', 400);
    return;
  }

  const admin = await prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } });
  if (!admin) {
    error(res, 'Invalid credentials', 401);
    return;
  }

  const validPassword = await bcrypt.compare(password, admin.passwordHash);
  if (!validPassword) {
    error(res, 'Invalid credentials', 401);
    return;
  }

  const token = jwt.sign(
    { id: admin.id, email: admin.email, role: admin.role },
    env.JWT_SECRET,
    { expiresIn: '7d' } as jwt.SignOptions
  );

  success(res, {
    token,
    admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
  }, 'Login successful');
}

// ─── Dashboard (simple) ───────────────────────────────────────────────────────
export async function getDashboard(_req: Request, res: Response): Promise<void> {
  const [totalUsers, activeContests, pendingClaims, txnToday] = await Promise.all([
    prisma.user.count(),
    prisma.contest.count({
      where: { status: { in: [ContestStatus.REGISTRATION_OPEN, ContestStatus.GAMEPLAY_ACTIVE] } },
    }),
    prisma.prizeClaim.count({ where: { status: 'PENDING' } }),
    prisma.transaction.count({
      where: { createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
    }),
  ]);

  success(res, { totalUsers, activeContests, pendingClaims, txnToday });
}

// ─── Dashboard Stats (rich) ───────────────────────────────────────────────────
export async function getDashboardStats(_req: Request, res: Response): Promise<void> {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const EARN_TYPES = [
      TransactionType.EARN_TASK,
      TransactionType.EARN_SURVEY,
      TransactionType.EARN_OFFERWALL,
      TransactionType.EARN_REFERRAL,
      TransactionType.EARN_BONUS,
      TransactionType.EARN_DAILY,
      TransactionType.EARN_CONTEST_WIN,
      TransactionType.EARN_IPL_WIN,
    ];

    const [
      totalUsers,
      activeUsers,
      newUsersToday,
      totalTransactions,
      coinsDistributedToday,
      totalCoinsDistributed,
      activeContests,
      pendingClaims,
      offerwallToday,
      surveyToday,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { coinBalance: { gt: 0 } } }),
      prisma.user.count({ where: { createdAt: { gte: today } } }),
      prisma.transaction.count(),
      prisma.transaction.aggregate({
        where: { createdAt: { gte: today }, type: { in: EARN_TYPES } },
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        where: { type: { in: EARN_TYPES } },
        _sum: { amount: true },
      }),
      prisma.contest.count({
        where: { status: { in: [ContestStatus.REGISTRATION_OPEN, ContestStatus.GAMEPLAY_ACTIVE] } },
      }).catch(() => 0),
      prisma.prizeClaim.count({ where: { status: 'PENDING' } }).catch(() => 0),
      prisma.offerwallLog.aggregate({
        where: { createdAt: { gte: today }, provider: { not: 'cpx' } },
        _sum: { coinsAwarded: true },
      }).catch(() => ({ _sum: { coinsAwarded: 0 } })),
      prisma.offerwallLog.aggregate({
        where: { createdAt: { gte: today }, provider: 'cpx' },
        _sum: { coinsAwarded: true },
      }).catch(() => ({ _sum: { coinsAwarded: 0 } })),
    ]);

    const recentTransactions = await prisma.transaction.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { name: true, phone: true } } },
    }).catch(() => []);

    success(res, {
      users: {
        total: totalUsers,
        active: activeUsers,
        newToday: newUsersToday,
      },
      revenue: {
        coinsToday: coinsDistributedToday._sum.amount || 0,
        coinsTotal: totalCoinsDistributed._sum.amount || 0,
        offerwallToday: offerwallToday._sum.coinsAwarded || 0,
        surveyToday: surveyToday._sum.coinsAwarded || 0,
      },
      contests: { active: activeContests },
      claims: { pending: pendingClaims },
      transactions: totalTransactions,
      recentTransactions,
    });
  } catch (err) {
    logger.error('getDashboardStats error:', err);
    error(res, 'Failed to fetch dashboard stats', 500);
  }
}

// ─── Games ────────────────────────────────────────────────────────────────────
export async function listGames(_req: Request, res: Response): Promise<void> {
  const games = await prisma.game.findMany({ orderBy: { createdAt: 'desc' } });
  success(res, games);
}

export async function createGame(req: Request, res: Response): Promise<void> {
  const { name, description, icon, gameUrl, gameHtml, category } = req.body as {
    name: string; description?: string; icon?: string;
    gameUrl?: string; gameHtml?: string; category?: string;
  };

  const game = await prisma.game.create({
    data: { name, description, icon, gameUrl, gameHtml, category: category ?? 'general' },
  });

  success(res, game, 'Game created', 201);
}

export async function updateGame(req: Request, res: Response): Promise<void> {
  const { name, description, icon, gameUrl, gameHtml, category, isActive } = req.body as {
    name?: string; description?: string; icon?: string;
    gameUrl?: string; gameHtml?: string; category?: string; isActive?: boolean;
  };

  const game = await prisma.game.update({
    where: { id: req.params.id as string },
    data: { name, description, icon, gameUrl, gameHtml, category, isActive },
  });

  success(res, game, 'Game updated');
}

// ─── Contests ─────────────────────────────────────────────────────────────────
export async function listContests(req: Request, res: Response): Promise<void> {
  const page = parseInt(qs(req.query.page) ?? '1', 10);
  const limit = Math.min(parseInt(qs(req.query.limit) ?? '20', 10), 100);
  const skip = (page - 1) * limit;

  const [contests, total] = await Promise.all([
    prisma.contest.findMany({
      include: { game: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.contest.count(),
  ]);

  paginated(res, contests, total, page, limit);
}

export async function createContest(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    gameId: string; name: string; type: ContestType; entryFee: number;
    maxPlayers: number; minPlayers?: number; regStartTime: string;
    regEndTime: string; gameStartTime: string; gameEndTime: string;
    prizeType?: PrizeType; totalPrizePool?: number;
    prizeDistribution: Record<string, number>;
    ticketPrizeDistribution?: Record<string, number>;
  };

  const contest = await prisma.contest.create({
    data: {
      gameId: body.gameId,
      name: body.name,
      type: body.type,
      entryFee: body.entryFee,
      maxPlayers: body.maxPlayers,
      minPlayers: body.minPlayers ?? 2,
      regStartTime: new Date(body.regStartTime),
      regEndTime: new Date(body.regEndTime),
      gameStartTime: new Date(body.gameStartTime),
      gameEndTime: new Date(body.gameEndTime),
      prizeType: body.prizeType ?? PrizeType.COINS,
      totalPrizePool: body.totalPrizePool ?? 0,
      prizeDistribution: body.prizeDistribution,
      ticketPrizeDistribution: body.ticketPrizeDistribution ?? Prisma.JsonNull,
      status: ContestStatus.DRAFT,
    },
  });

  success(res, contest, 'Contest created', 201);
}

export async function updateContest(req: Request, res: Response): Promise<void> {
  const body = req.body as Partial<{
    name: string; status: ContestStatus; entryFee: number;
    maxPlayers: number; prizeDistribution: Record<string, number>;
  }>;

  const contest = await prisma.contest.update({
    where: { id: req.params.id as string },
    data: body,
  });
  success(res, contest, 'Contest updated');
}

export async function finalizeContestAdmin(req: Request, res: Response): Promise<void> {
  try {
    await finalizeContest(req.params.id as string);
    success(res, null, 'Contest finalized');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Finalization failed';
    error(res, msg, 400);
  }
}

// ─── Users ────────────────────────────────────────────────────────────────────
export async function listUsers(req: Request, res: Response): Promise<void> {
  const page = parseInt(qs(req.query.page) ?? '1', 10);
  const limit = Math.min(parseInt(qs(req.query.limit) ?? '20', 10), 100);
  const skip = (page - 1) * limit;
  const search = qs(req.query.search);

  const where = search
    ? {
        OR: [
          { name: { contains: search } },
          { email: { contains: search } },
          { phone: { contains: search } },
        ],
      }
    : {};

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true, name: true, email: true, phone: true,
        coinBalance: true, status: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  paginated(res, users, total, page, limit);
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  const { status, coinBalance } = req.body as {
    status?: 'ACTIVE' | 'SUSPENDED' | 'BANNED';
    coinBalance?: number;
  };

  const user = await prisma.user.update({
    where: { id: req.params.id as string },
    data: { status, coinBalance },
    select: { id: true, name: true, status: true, coinBalance: true },
  });

  success(res, user, 'User updated');
}

// ─── Claims ───────────────────────────────────────────────────────────────────
export async function listClaims(req: Request, res: Response): Promise<void> {
  const page = parseInt(qs(req.query.page) ?? '1', 10);
  const limit = Math.min(parseInt(qs(req.query.limit) ?? '20', 10), 100);
  const skip = (page - 1) * limit;

  const [claims, total] = await Promise.all([
    prisma.prizeClaim.findMany({
      include: {
        user: { select: { id: true, name: true } },
        contest: { select: { name: true } },
      },
      orderBy: { claimedAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.prizeClaim.count(),
  ]);

  paginated(res, claims, total, page, limit);
}

export async function updateClaim(req: Request, res: Response): Promise<void> {
  const { status, trackingInfo, giftCode } = req.body as {
    status?: 'PENDING' | 'PROCESSING' | 'DISPATCHED' | 'DELIVERED';
    trackingInfo?: string;
    giftCode?: string;
  };

  const claim = await prisma.prizeClaim.update({
    where: { id: req.params.id as string },
    data: { status, trackingInfo, giftCode },
  });

  success(res, claim, 'Claim updated');
}

// ─── IPL Admin — List matches with contest data ───────────────────────────────
export async function listAdminMatches(req: Request, res: Response): Promise<void> {
  const status = qs(req.query.status);
  const search = qs(req.query.search);
  const page = parseInt(qs(req.query.page) ?? '1', 10);
  const limit = Math.min(parseInt(qs(req.query.limit) ?? '50', 10), 100);
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (status && status !== 'all') where.contestStatus = status;
  if (search) {
    where.OR = [
      { team1: { contains: search, mode: 'insensitive' } },
      { team2: { contains: search, mode: 'insensitive' } },
      { venue: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [matches, total] = await Promise.all([
    prisma.iplMatch.findMany({
      where,
      include: {
        questions: { select: { id: true, question: true, category: true, difficulty: true, isAutoGenerated: true, approved: true, options: true, correctAnswer: true, points: true, matchId: true, status: true } },
        _count: { select: { predictions: true } },
      },
      orderBy: { matchDate: 'asc' },
      skip,
      take: limit,
    }),
    prisma.iplMatch.count({ where }),
  ]);

  paginated(res, matches, total, page, limit);
}

// ─── IPL Admin — Generate questions for a specific match ─────────────────────
export async function generateQuestionsForMatch(req: Request, res: Response): Promise<void> {
  const { matchId } = req.body as { matchId?: string };

  if (matchId) {
    // Generate for a specific match
    const match = await prisma.iplMatch.findUnique({ where: { id: matchId } });
    if (!match) { error(res, 'Match not found', 404); return; }

    const { generateIPLQuestions } = await import('../services/claudeAiService');
    const questions = await generateIPLQuestions({
      team1: match.team1, team2: match.team2,
      date: match.matchDate.toDateString(), venue: match.venue ?? 'TBD',
    });

    const created = await Promise.all(
      questions.map(q =>
        prisma.iplQuestion.create({
          data: {
            matchId: match.id, question: q.question, options: q.options,
            correctAnswer: q.correctAnswer ?? '', points: q.points ?? 100,
            category: q.category ?? 'prediction', difficulty: q.difficulty ?? 'medium',
            status: 'active', isAutoGenerated: true, generatedBy: 'claude-ai', approved: false,
          },
        })
      )
    );

    await prisma.iplMatch.update({ where: { id: matchId }, data: { contestStatus: 'questions_ready' } });
    success(res, { questions: created }, `Generated ${created.length} questions`);
    return;
  }

  // Fallback: generate for all today's matches (original behavior)
  try {
    const count = await generateQuestionsForTodayMatches();
    success(res, { questionsGenerated: count }, `Generated ${count} questions for today's matches`);
  } catch (err) {
    logger.error('Manual quiz generation failed:', err);
    const msg = err instanceof Error ? err.message : 'Quiz generation failed';
    error(res, msg, 500);
  }
}

// ─── IPL Admin — Publish contest ──────────────────────────────────────────────
export async function publishContest(req: Request, res: Response): Promise<void> {
  const { matchId, entryFee, maxPlayers, minPlayers, regCloseTime, prizeDistribution } = req.body as {
    matchId: string; entryFee: number; maxPlayers: number; minPlayers: number;
    regCloseTime: string; prizeDistribution: unknown;
  };

  const match = await prisma.iplMatch.findUnique({ where: { id: matchId } });
  if (!match) { error(res, 'Match not found', 404); return; }

  const updated = await prisma.iplMatch.update({
    where: { id: matchId },
    data: {
      entryFee, maxPlayers, minPlayers,
      regCloseTime: regCloseTime ? new Date(regCloseTime) : undefined,
      prizeDistribution: prizeDistribution as object,
      contestStatus: 'published',
    },
  });

  // Send push notifications (best effort)
  try {
    const { sendToAll } = await import('../services/notificationService');
    await sendToAll(
      '🏏 New IPL Contest Live!',
      `${match.team1} vs ${match.team2} — Join now for 🪙${entryFee} coins entry!`,
      'ipl_contest_published'
    );
  } catch (notifErr) {
    logger.warn('Failed to send publish notifications:', notifErr);
  }

  success(res, { match: updated }, 'Contest published successfully');
}

// ─── IPL Admin — Process results with full coin crediting ────────────────────
export async function processResults(req: Request, res: Response): Promise<void> {
  const { matchId, winner, team1Score, team2Score, manOfMatch, answers } = req.body as {
    matchId: string; winner: string; team1Score?: string; team2Score?: string;
    manOfMatch?: string; answers: Record<string, string>;
  };

  const match = await prisma.iplMatch.findUnique({
    where: { id: matchId },
    include: { questions: true },
  });
  if (!match) { error(res, 'Match not found', 404); return; }

  // Step 1: Update match result
  await prisma.iplMatch.update({
    where: { id: matchId },
    data: {
      result: winner, winnerId: winner,
      team1Score, team2Score, manOfMatch,
      status: 'completed', contestStatus: 'processing',
    },
  });

  // Step 2: Set correct answers on questions
  const finalAnswers = { ...answers };
  if (Object.keys(finalAnswers).length === 0) {
    // Use Claude AI to verify if no manual answers provided
    try {
      const { verifyAnswersWithAI } = await import('../services/claudeAiService');
      const verified = await verifyAnswersWithAI(match.questions, {
        winner, manOfMatch, team1Score: undefined, team2Score: undefined,
      });
      for (const q of verified) {
        if (q.id && q.correctAnswer) finalAnswers[q.id as string] = q.correctAnswer as string;
      }
    } catch (aiErr) {
      logger.warn('AI verification failed, using manual answers:', aiErr);
    }
  }

  // Step 3: Score all predictions
  let winnersCount = 0;
  let totalCredited = 0;

  for (const [questionId, correctAnswer] of Object.entries(finalAnswers)) {
    await prisma.iplQuestion.update({
      where: { id: questionId },
      data: { correctAnswer, status: 'closed' },
    });

    const question = match.questions.find(q => q.id === questionId);
    if (!question) continue;

    const predictions = await prisma.iplPrediction.findMany({ where: { questionId } });
    for (const pred of predictions) {
      const isCorrect = pred.answer === correctAnswer;
      const pointsEarned = isCorrect ? question.points : 0;
      await prisma.iplPrediction.update({
        where: { id: pred.id },
        data: { isCorrect, pointsEarned },
      });
      if (isCorrect && pointsEarned > 0) {
        const { creditCoins } = await import('../services/coinService');
        const { TransactionType } = await import('@prisma/client');
        await creditCoins(pred.userId, pointsEarned, TransactionType.EARN_IPL_WIN, pred.id, `IPL prediction correct: ${question.question}`);
        winnersCount++;
        totalCredited += pointsEarned;
      }
    }
  }

  // Step 4: Mark completed
  await prisma.iplMatch.update({ where: { id: matchId }, data: { contestStatus: 'completed' } });

  // Step 5: Notify participants (best effort)
  try {
    const { sendToAll } = await import('../services/notificationService');
    await sendToAll(
      '🏆 IPL Match Results!',
      `${match.team1} vs ${match.team2} — Results processed! ${winnersCount} winners credited.`,
      'ipl_results_processed'
    );
  } catch (notifErr) {
    logger.warn('Failed to send result notifications:', notifErr);
  }

  success(res, {
    summary: {
      winnersCount,
      totalCredited,
      matchId,
      winner,
      teamScores: { team1: team1Score, team2: team2Score },
      manOfMatch,
    },
  }, 'Results processed and coins credited');
}

// ─── IPL Admin — Season analytics ────────────────────────────────────────────
export async function getIplAnalytics(_req: Request, res: Response): Promise<void> {
  const [matches, totalPredictions] = await Promise.all([
    prisma.iplMatch.findMany({
      include: { _count: { select: { predictions: true } } },
      orderBy: { matchDate: 'asc' },
    }),
    prisma.iplPrediction.count(),
  ]);

  const completedMatches = matches.filter(m => m.status === 'completed' || m.contestStatus === 'completed');
  const totalParticipants = completedMatches.reduce((s, m) => s + m._count.predictions, 0);

  // Revenue = entryFee * participants * 0.15 platform cut (approximate)
  const totalRevenue = completedMatches.reduce((s, m) => s + m.entryFee * m._count.predictions * 0.15, 0);
  const totalPrizePool = completedMatches.reduce((s, m) => s + m.entryFee * m._count.predictions * 0.85, 0);
  const avgFillRate = completedMatches.length > 0
    ? completedMatches.reduce((s, m) => s + (m.maxPlayers > 0 ? m._count.predictions / m.maxPlayers : 0), 0) / completedMatches.length * 100
    : 0;

  const bestMatch = completedMatches.reduce<typeof completedMatches[0] | null>(
    (best, m) => (!best || m._count.predictions > best._count.predictions) ? m : best,
    null
  );

  success(res, {
    totalMatches: completedMatches.length,
    totalParticipants,
    totalPredictions,
    totalRevenue: Math.round(totalRevenue),
    totalPrizePool: Math.round(totalPrizePool),
    avgFillRate: Math.round(avgFillRate),
    mostPopularMatch: bestMatch ? `${bestMatch.team1} vs ${bestMatch.team2}` : null,
    matches: matches.map(m => ({
      id: m.id, matchNumber: m.matchNumber,
      teams: `${m.team1} vs ${m.team2}`,
      participants: m._count.predictions,
      revenue: Math.round(m.entryFee * m._count.predictions * 0.15),
      fillRate: m.maxPlayers > 0 ? Math.round(m._count.predictions / m.maxPlayers * 100) : 0,
      status: m.contestStatus,
    })),
  });
}

// ─── IPL Admin — Match participants ──────────────────────────────────────────
export async function getMatchParticipants(req: Request, res: Response): Promise<void> {
  const matchId = req.params.id as string;
  const match = await prisma.iplMatch.findUnique({ where: { id: matchId } });
  if (!match) { error(res, 'Match not found', 404); return; }

  const predictions = await prisma.iplPrediction.groupBy({
    by: ['userId'],
    where: { matchId },
    _sum: { pointsEarned: true },
    _count: { id: true },
    orderBy: { _sum: { pointsEarned: 'desc' } },
  });

  const userIds = predictions.map(p => p.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true },
  });
  const userMap = new Map(users.map(u => [u.id, u.name]));

  const participants = predictions.map((p, i) => ({
    rank: i + 1,
    userId: p.userId,
    username: userMap.get(p.userId) ?? 'Unknown',
    score: p._sum.pointsEarned ?? 0,
    predictions: p._count.id,
  }));

  success(res, { participants, total: participants.length });
}

// ─── IPL Admin — Match questions CRUD ────────────────────────────────────────
export async function getMatchQuestions(req: Request, res: Response): Promise<void> {
  const language = req.query.language as string | undefined;
  const where: any = { matchId: req.params.id as string };
  if (language) where.language = language;
  const questions = await prisma.iplQuestion.findMany({
    where,
    orderBy: [{ language: 'asc' }, { questionNumber: 'asc' }],
  });
  success(res, questions);
}

export async function updateMatchQuestions(req: Request, res: Response): Promise<void> {
  const matchId = req.params.id as string;
  const { questions } = req.body as {
    questions: Array<{
      id: string; question: string; options: string[]; correctAnswer?: string;
      points: number; category: string; difficulty: string; approved: boolean;
    }>;
  };

  for (const q of questions) {
    if (q.id.startsWith('new_') || q.id.startsWith('gen_')) {
      // Create new question
      await prisma.iplQuestion.create({
        data: {
          matchId, question: q.question, options: q.options,
          correctAnswer: q.correctAnswer ?? '', points: q.points,
          category: q.category, difficulty: q.difficulty,
          status: 'active', isAutoGenerated: false, approved: q.approved,
        },
      });
    } else {
      // Update existing
      await prisma.iplQuestion.update({
        where: { id: q.id },
        data: {
          question: q.question, options: q.options,
          correctAnswer: q.correctAnswer, points: q.points,
          category: q.category, difficulty: q.difficulty, approved: q.approved,
        },
      });
    }
  }

  success(res, null, 'Questions updated');
}

export async function deleteIplQuestion(req: Request, res: Response): Promise<void> {
  await prisma.iplQuestion.delete({ where: { id: req.params.qid as string } });
  success(res, null, 'Question deleted');
}

// ─── IPL Admin ────────────────────────────────────────────────────────────────
export async function createIplMatch(req: Request, res: Response): Promise<void> {
  const {
    matchNumber, team1, team2, matchDate, venue, youtubeUrl,
    matchStartTime, registrationCloseTime, resultDeclareTime,
  } = req.body as {
    matchNumber: number; team1: string; team2: string; matchDate: string;
    venue?: string; youtubeUrl?: string;
    matchStartTime?: string; registrationCloseTime?: string; resultDeclareTime?: string;
  };

  if (team1 && team2 && team1 === team2) {
    error(res, 'Team 1 and Team 2 must be different!', 400);
    return;
  }

  const match = await prisma.iplMatch.create({
    data: {
      matchNumber: parseInt(String(matchNumber)) || 1,
      team1, team2,
      matchDate: new Date(matchDate),
      venue: venue || 'TBD',
      youtubeUrl: youtubeUrl || null,
      status: 'upcoming',
      matchStartTime: matchStartTime ? new Date(matchStartTime) : null,
      registrationCloseTime: registrationCloseTime ? new Date(registrationCloseTime) : null,
      resultDeclareTime: resultDeclareTime ? new Date(resultDeclareTime) : null,
    },
  });

  success(res, match, 'IPL match created', 201);
}

export async function setMatchResult(req: Request, res: Response): Promise<void> {
  const { result, winnerId, answers } = req.body as {
    result: string;
    winnerId?: string;
    answers: Record<string, string>;
  };

  await prisma.iplMatch.update({
    where: { id: req.params.id as string },
    data: { result, winnerId, status: 'completed' },
  });

  await scoreMatch(req.params.id as string, answers);
  success(res, null, 'Match result set and predictions scored');
}

// ─── AI Quiz Generation (Admin Manual Triggers) ───────────────────────────────
export async function triggerQuizGeneration(_req: Request, res: Response): Promise<void> {
  try {
    const count = await generateQuestionsForTodayMatches();
    success(res, { questionsGenerated: count }, `Generated ${count} questions for today's matches`);
  } catch (err) {
    logger.error('Manual quiz generation failed:', err);
    const msg = err instanceof Error ? err.message : 'Quiz generation failed';
    error(res, msg, 500);
  }
}

export async function triggerResultVerification(req: Request, res: Response): Promise<void> {
  try {
    await verifyMatchResultsJob(req.params.id as string);
    success(res, null, 'Match results verified and coins credited');
  } catch (err) {
    logger.error('Manual result verification failed:', err);
    const msg = err instanceof Error ? err.message : 'Result verification failed';
    error(res, msg, 400);
  }
}

export async function createIplQuestion(req: Request, res: Response): Promise<void> {
  const { matchId, question, options, points } = req.body as {
    matchId: string; question: string; options: string[]; points?: number;
  };

  const q = await prisma.iplQuestion.create({
    data: { matchId, question, options, points: points ?? 100 },
  });

  success(res, q, 'Question created', 201);
}
