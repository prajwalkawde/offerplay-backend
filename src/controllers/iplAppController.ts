import { Request, Response } from 'express';
import { TransactionType } from '@prisma/client';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import { getTeam } from '../config/iplTeams';

// ─── Team logo URL cache (refreshed every 10 min from DB settings) ────────────
let _logoCache: Record<string, string> = {};
let _logoCacheAt = 0;

async function getTeamLogoUrls(): Promise<Record<string, string>> {
  const now = Date.now();
  if (now - _logoCacheAt < 10 * 60 * 1000) return _logoCache;
  try {
    const rows = await prisma.appSettings.findMany({
      where: { key: { startsWith: 'TEAM_LOGO_' } },
      select: { key: true, value: true },
    });
    _logoCache = Object.fromEntries(
      rows.filter(r => r.value).map(r => [r.key.replace('TEAM_LOGO_', ''), r.value])
    );
    _logoCacheAt = now;
  } catch { /* keep previous cache on DB error */ }
  return _logoCache;
}

// ─── Helper: enrich a match object with team logo/color/name fields ───────────
export function enrichMatch(
  match: { team1: string; team2: string; [key: string]: any },
  logoUrls: Record<string, string> = {}
) {
  const t1 = getTeam(match.team1);
  const t2 = getTeam(match.team2);
  return {
    ...match,
    team1Logo:     match.team1Logo || logoUrls[match.team1] || t1?.logoUrl || '',
    team1Color:    t1?.color       ?? '#7B2FBE',
    team1FullName: t1?.name        ?? match.team1,
    team1Emoji:    t1?.emoji       ?? '🏏',
    team2Logo:     match.team2Logo || logoUrls[match.team2] || t2?.logoUrl || '',
    team2Color:    t2?.color       ?? '#00C2E3',
    team2FullName: t2?.name        ?? match.team2,
    team2Emoji:    t2?.emoji       ?? '🏏',
  };
}

// ─── Helper: extract rank 1 prize from prizeTiersConfig ──────────────────────
export function getRank1Prize(contest: any): any {
  const tiers: any[] = Array.isArray(contest.prizeTiersConfig) ? contest.prizeTiersConfig : [];
  if (tiers.length === 0) return null;
  const rank1 = tiers.find((t: any) => t.rank === 1 || t.rankFrom === 1) ?? tiers[0];
  return {
    type: rank1.type,
    coins: rank1.coins || null,
    itemName: rank1.itemName || null,
    itemImage: rank1.itemImage || null,
    itemValue: rank1.itemValue || null,
    productName: rank1.productName || null,
    denominationValue: rank1.denominationValue || null,
    label: rank1.label || '1st Place',
  };
}

// ─── Helper: compute total coins prize pool from prizeTiersConfig ─────────────
export function calcTotalPrizePool(prizeTiersConfig: any[]): number {
  if (!Array.isArray(prizeTiersConfig) || prizeTiersConfig.length === 0) return 0;
  return prizeTiersConfig.reduce((sum, t) => {
    if (t.type !== 'COINS') return sum;
    const from = t.rankFrom ?? t.rank ?? 1;
    const to = t.rankTo ?? t.rank ?? 1;
    return sum + (t.coins || 0) * (to - from + 1);
  }, 0);
}

// ─── Helper: compute displayStatus for a contest ──────────────────────────────
function getContestDisplayStatus(
  contestStatus: string,
  regCloseTime: Date | null | undefined,
  matchStatus?: string | null,
): 'OPEN' | 'LOCKED' | 'COMPLETED' {
  if (contestStatus === 'completed' || matchStatus === 'completed') return 'COMPLETED';
  if (regCloseTime && new Date() > new Date(regCloseTime)) return 'LOCKED';
  return 'OPEN';
}

// ─── GET /api/ipl/matches ─────────────────────────────────────────────────────
// Returns upcoming matches (next 7 days) with published contests + user state
export async function getMatchesForApp(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId;
    const logoUrls = await getTeamLogoUrls();

    // Use IST midnight (UTC+5:30) as the day boundary — target market is India
    const nowUtc = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const nowIst = new Date(nowUtc.getTime() + istOffsetMs);
    nowIst.setHours(0, 0, 0, 0);
    const today = new Date(nowIst.getTime() - istOffsetMs); // back to UTC
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
      ...enrichMatch(match, logoUrls),
      isToday: Math.floor((match.matchDate.getTime() + istOffsetMs) / 86400000) === Math.floor((Date.now() + istOffsetMs) / 86400000),
      questionCount: match.questions.length,
      questions: undefined,
      matchDate: match.matchDate,
      matchStartTime: match.matchStartTime || match.matchDate,
      registrationCloseTime: match.registrationCloseTime || null,
      venue: match.venue || null,
      contests: match.contests
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
            contestType: c.contestType,
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
            regCloseTime: c.regCloseTime || null,
            sponsorName: c.sponsorName,
            sponsorLogo: c.sponsorLogo,
            maxEntriesPerUser: c.maxEntriesPerUser,
            hasJoined: c.entries.length > 0,
            displayStatus: getContestDisplayStatus(c.status, c.regCloseTime, match.status),
          };
        })
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

    // Block joining after registration deadline (all times compared in UTC)
    if (contest.regCloseTime && new Date() > new Date(contest.regCloseTime)) {
      error(res, 'Registration is closed for this contest', 400); return;
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
    // Get user's language preference
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { language: true } });
    const userLang = user?.language || 'en';

    const entry = await prisma.iplContestEntry.findUnique({
      where: { contestId_userId: { contestId, userId } },
      include: {
        contest: {
          include: { match: { select: { id: true } } },
        },
      },
    });

    if (!entry) { error(res, 'Join the contest first!', 400); return; }

    const contest = entry.contest as any;
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

    const matchId = contest.match?.id;
    if (!matchId) {
      success(res, { questionsAvailable: true, questionsLocked: predictionsLocked, questions: [], message: 'No questions available' });
      return;
    }

    // Fetch questions in user's language, fallback to English
    let questions = await prisma.iplQuestion.findMany({
      where: { matchId, status: 'active', language: userLang },
      orderBy: { questionNumber: 'asc' },
    });

    if (questions.length === 0 && userLang !== 'en') {
      questions = await prisma.iplQuestion.findMany({
        where: { matchId, status: 'active', language: 'en' },
        orderBy: { questionNumber: 'asc' },
      });
    }

    if (questions.length === 0) {
      success(res, {
        questionsAvailable: true,
        questionsLocked: predictionsLocked,
        questions: [],
        message: 'No questions available for this match yet',
      });
      return;
    }

    const predictions = await prisma.iplPrediction.findMany({ where: { userId, matchId } });
    const predMap: Record<string, string> = {};
    predictions.forEach((p: { questionId: string; answer: string }) => {
      predMap[p.questionId] = p.answer;
    });

    success(res, {
      questionsAvailable: true,
      questionsLocked: predictionsLocked,
      questionsLockAt: contest.questionsLockAt,
      language: userLang,
      questions: questions.map(q => ({
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
      include: { contest: { select: { matchId: true, questionsLockAt: true } } },
    });
    if (!entry) { error(res, 'Join the contest first', 400); return; }

    // Server-side lock check
    if (entry.contest.questionsLockAt && entry.contest.questionsLockAt <= new Date()) {
      error(res, 'Predictions are locked for this contest', 400); return;
    }

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
    const enriched = enrichMatch(contest.match, await getTeamLogoUrls());

    success(res, {
      leaderboard,
      totalEntries: entries.length,
      contestName: contest.name,
      matchName: `${contest.match.team1} vs ${contest.match.team2}`,
      team1Logo: enriched.team1Logo,
      team1Color: enriched.team1Color,
      team2Logo: enriched.team2Logo,
      team2Color: enriched.team2Color,
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
  const matchId = req.query.matchId as string | undefined;

  try {
    const where: any = { userId };
    if (matchId) where.contest = { matchId };

    const entries = await prisma.iplContestEntry.findMany({
      where,
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

    // Count user predictions per matchId in bulk
    const matchIds = [...new Set(entries.map(e => e.contest.matchId))];
    const predictionCounts = matchIds.length > 0
      ? await prisma.iplPrediction.groupBy({
          by: ['matchId'],
          where: { userId, matchId: { in: matchIds } },
          _count: { id: true },
        })
      : [];
    const predCountMap = new Map(predictionCounts.map(p => [p.matchId, p._count.id]));

    const result = entries.map(entry => {
      const contest = entry.contest;
      const questionsAvailable =
        !contest.questionsAvailableAt || contest.questionsAvailableAt <= now;
      const predictionsLocked =
        !!contest.questionsLockAt && contest.questionsLockAt <= now;
      const predictionCount = predCountMap.get(contest.matchId) || 0;

      let contestState = 'JOINED';
      if (!questionsAvailable) {
        contestState = 'WAITING_QUESTIONS';
      } else if (questionsAvailable && predictionCount === 0) {
        contestState = 'PREDICT_NOW';
      } else if (predictionCount > 0 && !predictionsLocked) {
        contestState = 'PREDICTED_CAN_EDIT';
      } else if (predictionCount > 0 && predictionsLocked) {
        contestState = 'WAITING_RESULT';
      }
      if (contest.status === 'completed') {
        contestState = (entry.coinsWon > 0 || (entry.rank !== null && entry.rank <= 3))
          ? 'WON' : 'COMPLETED';
      }

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
        ...(() => { const e = enrichMatch(contest.match, _logoCache); return { matchTeam1Logo: e.team1Logo, matchTeam1Color: e.team1Color, matchTeam2Logo: e.team2Logo, matchTeam2Color: e.team2Color }; })(),
        matchDate: contest.match.matchDate,
        matchStatus: contest.match.status,
        result: contest.match.result,
        youtubeUrl: contest.match.youtubeUrl,
        joinedAt: entry.joinedAt,
        questionsAvailable,
        questionsAvailableAt: contest.questionsAvailableAt,
        predictionsLocked,
        questionsLockAt: contest.questionsLockAt,
        predictionCount,
        contestState,
        questionCount: (contest as any).questionCount ?? 0,
        regCloseTime: contest.regCloseTime,
        displayStatus: getContestDisplayStatus(contest.status, contest.regCloseTime, contest.match.status),
      };
    });

    const active = result.filter(e => e.displayStatus === 'OPEN');
    const pending = result.filter(e => e.displayStatus === 'LOCKED');
    const completed = result.filter(e => e.displayStatus === 'COMPLETED' || e.status === 'completed');

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
function maskName(name: string): string {
  if (!name) return 'User***';
  const parts = name.trim().split(' ');
  return parts.map((p, i) =>
    i === 0
      ? p.charAt(0).toUpperCase() + '*'.repeat(Math.min(p.length - 1, 3))
      : p.charAt(0).toUpperCase() + '***'
  ).join(' ');
}

export async function getGlobalLeaderboard(req: Request, res: Response): Promise<void> {
  const userId = req.userId;
  const page  = parseInt(String(req.query.page)) || 1;
  const limit = 50;

  try {
    const topEntries = await prisma.iplContestEntry.groupBy({
      by: ['userId'],
      _sum: { totalPoints: true, coinsWon: true },
      _count: { id: true },
      orderBy: { _sum: { totalPoints: 'desc' } },
      take: limit,
      skip: (page - 1) * limit,
    });

    // ── Fallback: no contest entries yet — rank by coin balance ──────────────
    if (topEntries.length === 0) {
      const users = await prisma.user.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, name: true, coinBalance: true, favouriteTeam: true },
        orderBy: { coinBalance: 'desc' },
        take: limit,
      });
      const leaderboard = users.map((u, i) => ({
        rank: i + 1,
        userId: u.id,
        name: maskName(u.name || 'User'),
        avatar: (u.name?.charAt(0) ?? 'U').toUpperCase(),
        favouriteTeam: u.favouriteTeam,
        totalPoints: 0,
        coinsWon: u.coinBalance,
        contestsPlayed: 0,
        isCurrentUser: u.id === userId,
      }));
      const userRank = leaderboard.findIndex(p => p.userId === userId) + 1;
      success(res, { leaderboard, userRank: userRank || null, totalPlayers: users.length });
      return;
    }

    const userIds = topEntries.map(e => e.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, favouriteTeam: true },
    });
    const userMap = new Map(users.map(u => [u.id, u]));

    const leaderboard = topEntries.map((entry, i) => {
      const u = userMap.get(entry.userId);
      return {
        rank: (page - 1) * limit + i + 1,
        userId: entry.userId,
        name: maskName(u?.name || 'User'),
        avatar: (u?.name?.charAt(0) ?? 'U').toUpperCase(),
        favouriteTeam: u?.favouriteTeam ?? null,
        totalPoints: entry._sum.totalPoints ?? 0,
        coinsWon: entry._sum.coinsWon ?? 0,
        contestsPlayed: entry._count.id,
        isCurrentUser: entry.userId === userId,
      };
    });

    const userRank = leaderboard.findIndex(p => p.userId === userId) + 1;

    success(res, { leaderboard, userRank: userRank || null, totalPlayers: leaderboard.length });
  } catch (err) {
    logger.error('getGlobalLeaderboard error:', err);
    error(res, 'Failed to fetch leaderboard', 500);
  }
}
