import { Request, Response } from 'express';
import { TransactionType } from '@prisma/client';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import { getTeam } from '../config/iplTeams';

// ─── Fake display names assigned to bots per-contest (resets each contest) ───
const BOT_DISPLAY_NAMES = [
  'Arjun K.', 'Priya S.', 'Rahul M.', 'Sneha T.', 'Vikram P.',
  'Ananya R.', 'Kiran B.', 'Deepak V.', 'Meera J.', 'Suresh N.',
  'Kavita L.', 'Ravi G.', 'Pooja D.', 'Amit H.', 'Neha C.',
  'Aakash Y.', 'Divya F.', 'Sanjay W.', 'Lata Q.', 'Nikhil Z.',
];
function getBotDisplayName(botIndexInContest: number): string {
  return BOT_DISPLAY_NAMES[botIndexInContest % BOT_DISPLAY_NAMES.length];
}

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
    tickets: rank1.tickets || null,
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

// ─── GET /api/ipl/results ─────────────────────────────────────────────────────
// Returns completed matches (last 45 days) with announced results — public
export async function getResultMatchesForApp(req: Request, res: Response): Promise<void> {
  try {
    const logoUrls = await getTeamLogoUrls();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 45);

    const matches = await prisma.iplMatch.findMany({
      where: {
        status: { in: ['completed', 'COMPLETED'] },
        matchDate: { gte: cutoff },
      },
      include: {
        contests: {
          where: { status: 'completed' },
          include: { _count: { select: { entries: true } } },
          orderBy: [{ battleType: 'asc' }, { entryFee: 'desc' }],
        },
      },
      orderBy: { matchDate: 'desc' },
    });

    const result = matches.map(match => {
      const enriched = enrichMatch(match, logoUrls);
      return {
        ...enriched,
        matchDate: match.matchDate,
        status: match.status,
        result: (match as any).result || null,
        venue: match.venue || null,
        totalPlayers: match.contests.reduce((sum, c) => sum + c._count.entries, 0),
        contests: match.contests.map(c => {
          const parsedTiers = typeof c.prizeTiersConfig === 'string'
            ? JSON.parse(c.prizeTiersConfig as string)
            : c.prizeTiersConfig;
          const rawTiers: any[] = Array.isArray(parsedTiers) ? parsedTiers as any[] : [];
          return {
            id: c.id,
            name: c.name,
            battleType: c.battleType,
            entryFee: c.entryFee,
            currentPlayers: c._count.entries,
            rank1Prize: getRank1Prize({ prizeTiersConfig: rawTiers }),
            totalPrizePool: calcTotalPrizePool(rawTiers),
          };
        }),
      };
    });

    success(res, result);
  } catch (err) {
    logger.error('getResultMatchesForApp error:', err);
    error(res, 'Failed to fetch results', 500);
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
    // Fall back to match start time if no explicit regCloseTime is set
    const deadline =
      contest.regCloseTime ||
      contest.match.regCloseTime ||
      contest.match.registrationCloseTime ||
      contest.match.matchDate;
    if (deadline && new Date() > new Date(deadline)) {
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

    // Validate balance before touching money
    if (entryType === 'TICKET') {
      const ticketCost = contest.ticketCost || 1;
      const { getTicketBalance } = await import('../services/ticketService');
      const bal = await getTicketBalance(userId);
      if (bal < ticketCost) { error(res, 'Insufficient tickets!', 400); return; }
    } else if (entryType === 'COINS') {
      const entryFee = contest.entryFee || 0;
      if (entryFee > 0) {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { coinBalance: true } });
        if (!user || user.coinBalance < entryFee) { error(res, 'Insufficient coins!', 400); return; }
      }
    }

    // Atomic: create entry + increment counter, then deduct payment
    // Entry creation is inside $transaction so it either fully succeeds or rolls back
    await prisma.$transaction([
      prisma.iplContestEntry.create({
        data: { userId, contestId, matchId: contest.matchId, coinsDeducted: entryType === 'COINS' ? (contest.entryFee || 0) : 0 },
      }),
      prisma.iplContest.update({
        where: { id: contestId },
        data: { currentPlayers: { increment: 1 } },
      }),
      ...(entryType === 'COINS' && (contest.entryFee || 0) > 0 ? [
        prisma.user.update({ where: { id: userId }, data: { coinBalance: { decrement: contest.entryFee! } } }),
        prisma.transaction.create({
          data: { userId, type: TransactionType.SPEND_IPL_ENTRY, amount: contest.entryFee!, refId: contestId, description: `Joined: ${contest.name}`, status: 'completed' },
        }),
      ] : []),
    ]);

    // Ticket deduction (outside DB transaction — uses separate service)
    if (entryType === 'TICKET') {
      const ticketCost = contest.ticketCost || 1;
      const { spendTickets } = await import('../services/ticketService');
      const result = await spendTickets(userId, ticketCost, `Contest entry: ${contest.name}`, contestId);
      if (!result.success) {
        // Rollback the entry we just created
        await prisma.iplContestEntry.deleteMany({ where: { userId, contestId } });
        await prisma.iplContest.update({ where: { id: contestId }, data: { currentPlayers: { decrement: 1 } } });
        error(res, result.error || 'Failed to deduct tickets — join cancelled', 400); return;
      }
    }

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
          include: {
            match: {
              select: { id: true, regCloseTime: true, registrationCloseTime: true, matchDate: true, status: true },
            },
          },
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

    // Use same fallback chain as savePredictions — questionsLockAt → contest.regCloseTime → match times
    const effectiveLockTime =
      contest.questionsLockAt ||
      contest.regCloseTime ||
      contest.match?.regCloseTime ||
      contest.match?.registrationCloseTime ||
      contest.match?.matchDate;

    const predictionsLocked =
      (!!effectiveLockTime && new Date(effectiveLockTime) <= now) ||
      contest.match?.status === 'LIVE' ||
      contest.match?.status === 'completed';

    const matchId = contest.match?.id;
    if (!matchId) {
      success(res, { questionsAvailable: true, questionsLocked: predictionsLocked, questionsLockAt: effectiveLockTime || null, questions: [], message: 'No questions available' });
      return;
    }

    // Fetch questions in user's language, limited to contest.questionCount
    const questionLimit = contest.questionCount || 10;
    logger.info(`[getContestQuestions] contestId=${contestId} lang=${userLang} questionCount=${contest.questionCount} limit=${questionLimit}`);
    let questions = await prisma.iplQuestion.findMany({
      where: { matchId, status: 'active', language: userLang },
      orderBy: { questionNumber: 'asc' },
      take: questionLimit,
    });

    if (questions.length === 0 && userLang !== 'en') {
      questions = await prisma.iplQuestion.findMany({
        where: { matchId, status: 'active', language: 'en' },
        orderBy: { questionNumber: 'asc' },
        take: questionLimit,
      });
    }

    if (questions.length === 0) {
      success(res, {
        questionsAvailable: true,
        questionsLocked: predictionsLocked,
        questionsLockAt: effectiveLockTime || null,
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
      questionsLockAt: effectiveLockTime || null,
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
      questionLimit,
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
      include: {
        contest: {
          select: {
            matchId: true, questionsLockAt: true, regCloseTime: true,
            match: { select: { matchDate: true, registrationCloseTime: true, regCloseTime: true, status: true } },
          },
        },
      },
    });
    if (!entry) { error(res, 'Join the contest first', 400); return; }

    // Server-side lock check — use questionsLockAt, then fall back to match start time
    const lockTime =
      entry.contest.questionsLockAt ||
      entry.contest.regCloseTime ||
      entry.contest.match.regCloseTime ||
      entry.contest.match.registrationCloseTime ||
      entry.contest.match.matchDate;
    if (lockTime && new Date() >= new Date(lockTime)) {
      error(res, 'Predictions are locked for this contest', 400); return;
    }
    if (entry.contest.match.status === 'LIVE' || entry.contest.match.status === 'completed') {
      error(res, 'Predictions are locked — match has started', 400); return;
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
      include: { user: { select: { id: true, name: true, phone: true, isBot: true } } },
      orderBy: [{ totalPoints: 'desc' }, { joinedAt: 'asc' }],
      take: 100,
    });

    // Build prize lookup by rank from prizeTiersConfig
    const allTiers: any[] = Array.isArray(contest.prizeTiersConfig) ? contest.prizeTiersConfig as any[] : [];
    const getPrizeTier = (rank: number) => allTiers.find((t: any) => {
      const from = t.rank ?? t.rankFrom ?? 1;
      const to = t.rankTo ?? t.rank ?? from;
      return rank >= from && rank <= to;
    }) ?? null;

    const getPrizeLabel = (tier: any): string | null => {
      if (!tier) return null;
      if (tier.type === 'TICKETS') return `🎟️ ${tier.tickets || 1} Ticket${(tier.tickets || 1) > 1 ? 's' : ''}`;
      if (tier.type === 'INVENTORY') return `🎁 ${tier.itemName || 'Prize'}`;
      if (tier.type === 'XOXODAY') return `🎫 ₹${tier.denominationValue} Gift Card`;
      if (tier.type === 'COINS' && tier.coins) return `🪙 ${tier.coins} Coins`;
      return null;
    };

    let botIndexInContest = 0;
    const leaderboard = entries.map((entry, i) => {
      const displayRank = i + 1;
      const prizeTier = getPrizeTier(displayRank);
      const isBot = entry.user.isBot ?? false;

      // Bots get a sequential fake name that resets per-contest so no two bots
      // in the same contest share a name, and real bot usernames are never exposed.
      let displayName: string;
      let displayAvatar: string;
      if (isBot) {
        displayName = getBotDisplayName(botIndexInContest++);
        displayAvatar = displayName.charAt(0).toUpperCase();
      } else {
        displayName = entry.user.name?.split(' ')[0] ?? `User${entry.userId.slice(0, 4)}`;
        displayAvatar = (entry.user.name?.charAt(0) ?? 'U').toUpperCase();
      }

      return {
        rank: displayRank,
        userId: entry.userId,
        name: displayName,
        fullName: isBot ? displayName : (entry.user.name ?? 'Unknown'),
        avatar: displayAvatar,
        totalPoints: entry.totalPoints,
        coinsWon: entry.coinsWon,
        isCurrentUser: entry.userId === userId,
        prizeLabel: getPrizeLabel(prizeTier),
        prizeTier: prizeTier ? {
          type: prizeTier.type,
          coins: prizeTier.coins ?? null,
          tickets: prizeTier.tickets ?? null,
          itemName: prizeTier.itemName ?? null,
          itemImage: prizeTier.itemImage ?? null,
          itemValue: prizeTier.itemValue ?? null,
          denominationValue: prizeTier.denominationValue ?? null,
        } : null,
      };
    });

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
                regCloseTime: true,
                registrationCloseTime: true,
              },
            },
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
      take: 50,
    });

    const now = new Date();

    // Fetch gift/inventory prize claims for this user in bulk.
    // We keep only the latest claim per contest (orderBy createdAt desc → first wins in the Map).
    const contestIds = entries.map(e => e.contestId);
    const prizeClaims = contestIds.length > 0
      ? await prisma.iplPrizeClaim.findMany({
          where: { userId, iplContestId: { in: contestIds } },
          select: { iplContestId: true, rank: true, prizeType: true, prizeName: true, prizeImageUrl: true, status: true },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    // Keep only the first (latest) claim per contest
    const prizeClaimMap = new Map<string, typeof prizeClaims[0]>();
    for (const c of prizeClaims) {
      if (!prizeClaimMap.has(c.iplContestId)) prizeClaimMap.set(c.iplContestId, c);
    }

    // Prizes are assigned by display rank (entry.rank) — no separate prizeRank needed.
    // Bots occupy their earned ranks and consume those prize tiers; real users get
    // whatever prize corresponds to their actual position in the full leaderboard.

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

      // Same fallback chain as getContestQuestions and savePredictions
      const effectiveLockTime =
        contest.questionsLockAt ||
        contest.regCloseTime ||
        contest.match.regCloseTime ||
        contest.match.registrationCloseTime ||
        contest.match.matchDate;
      const matchDone =
        contest.match.status === 'live' || contest.match.status === 'LIVE' ||
        contest.match.status === 'completed' || contest.match.status === 'COMPLETED';
      const predictionsLocked =
        matchDone || (!!effectiveLockTime && new Date(effectiveLockTime) <= now);

      const predictionCount = predCountMap.get(contest.matchId) || 0;

      let contestState = 'JOINED';
      if (!questionsAvailable) {
        contestState = 'WAITING_QUESTIONS';
      } else if (predictionsLocked) {
        // Registration/prediction time has passed — always go to leaderboard view
        contestState = 'WAITING_RESULT';
      } else if (predictionCount === 0) {
        contestState = 'PREDICT_NOW';
      } else {
        contestState = 'PREDICTED_CAN_EDIT';
      }
      // Detect non-coin prizes:
      // - INVENTORY/GIFT/XOXODAY: check iplPrizeClaim (accurate regardless of rank)
      // - TICKETS: still rank-based since tickets are credited directly with no claim record
      let ticketsWon = 0;
      let hasInventoryPrize = false;
      let wonPrizeName: string | null = null;
      let wonPrizeImage: string | null = null;
      let claimStatus: string | null = null; // pending/claimed/verified/shipped/delivered

      // Prize lookup by display rank — entry.rank is the actual rank (bots included)
      // which is the same rank used during prize distribution.
      const tiers: any[] = Array.isArray(contest.prizeTiersConfig) ? contest.prizeTiersConfig as any[] : [];
      const wonTier = entry.rank !== null
        ? tiers.find((t: any) => {
            const from = t.rank ?? t.rankFrom ?? 1;
            const to = t.rankTo ?? t.rank ?? from;
            return entry.rank! >= from && entry.rank! <= to;
          })
        : null;

      const claim = prizeClaimMap.get(contest.id);
      const claimablePrizeTypes = ['INVENTORY', 'GIFT', 'XOXODAY'];

      if (wonTier && claimablePrizeTypes.includes((wonTier.type ?? '').toUpperCase()) && claim) {
        // Display rank earns a claimable prize AND a claim record exists for this user
        hasInventoryPrize = true;
        wonPrizeName = claim.prizeName || (wonTier as any).itemName || null;
        wonPrizeImage = claim.prizeImageUrl || (wonTier as any).itemImage || null;
        claimStatus = claim.status || 'pending';
      } else if ((wonTier?.type ?? '').toUpperCase() === 'TICKETS') {
        ticketsWon = (wonTier as any).tickets || 0;
      }

      // Contest fully done (results processed) OR match completed
      if (contest.status === 'completed' || matchDone) {
        contestState = (entry.coinsWon > 0 || ticketsWon > 0 || hasInventoryPrize)
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
        ticketsWon,
        wonPrizeName,
        wonPrizeImage,
        claimStatus,
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

    // Fetch rank-1 (top winner) for all completed contests in one query
    const completedContestIdsForWinner = result
      .filter(e => e.displayStatus === 'COMPLETED' || e.status === 'completed')
      .map(e => e.contestId);

    const topWinnerMap = new Map<string, any>();
    if (completedContestIdsForWinner.length > 0) {
      const rank1Entries = await prisma.iplContestEntry.findMany({
        where: { contestId: { in: completedContestIdsForWinner }, rank: 1 },
        include: { user: { select: { name: true, isBot: true } } },
      });
      for (const w of rank1Entries) {
        // If rank-1 is a bot, show a fake name so real bot usernames aren't exposed
        const isBot = w.user.isBot ?? false;
        const winnerName = isBot
          ? getBotDisplayName(0)   // rank-1 bot is always the "first" bot in contest
          : (w.user.name?.split(' ')[0] ?? 'Winner');
        topWinnerMap.set(w.contestId, {
          name: winnerName,
          coinsWon: w.coinsWon,
          rank: 1,
        });
      }
    }

    // Attach topWinner and compute rank-1 prize label for each completed entry
    const resultWithWinner = result.map(e => {
      if (e.displayStatus !== 'COMPLETED' && e.status !== 'completed') return e;
      const winner = topWinnerMap.get(e.contestId) || null;
      // Compute rank-1 prize from prizeTiersConfig
      const tiers: any[] = Array.isArray((entries.find(en => en.contest.id === e.contestId)?.contest as any)?.prizeTiersConfig)
        ? (entries.find(en => en.contest.id === e.contestId)?.contest as any).prizeTiersConfig
        : [];
      const rank1Tier = tiers.find((t: any) => (t.rank ?? t.rankFrom ?? 1) === 1) ?? tiers[0];
      const rank1Prize = rank1Tier
        ? rank1Tier.type === 'TICKETS'
          ? `🎟️ ${rank1Tier.tickets || 1} Ticket${(rank1Tier.tickets || 1) > 1 ? 's' : ''}`
          : rank1Tier.type === 'INVENTORY'
          ? `🎁 ${rank1Tier.itemName || 'Prize'}`
          : rank1Tier.type === 'XOXODAY'
          ? `🎫 ₹${rank1Tier.denominationValue} Gift Card`
          : `🪙 ${rank1Tier.coins || 0} Coins`
        : null;
      return { ...e, topWinner: winner ? { ...winner, prize: rank1Prize } : null };
    });

    const active = resultWithWinner.filter(e => e.displayStatus === 'OPEN');
    const pending = resultWithWinner.filter(e => e.displayStatus === 'LOCKED');
    const completed = resultWithWinner.filter(e => e.displayStatus === 'COMPLETED' || e.status === 'completed');

    success(res, {
      all: resultWithWinner,
      active,
      pending,
      completed,
      totalJoined: resultWithWinner.length,
    });
  } catch (err) {
    logger.error('getMyContests error:', err);
    error(res, 'Failed to fetch contests', 500);
  }
}

// ─── Helper: find a valid prize claim for a user in a contest ────────────────
// Prizes are assigned by actual display rank (bots included). entry.rank = display rank.
// Returns the claim only if the user's display rank earns a claimable
// (INVENTORY / GIFT / XOXODAY) prize tier.
async function findValidPrizeClaim(userId: string, contestId: string) {
  // 1. Get user's actual rank (display rank — same rank used for prize distribution)
  const entry = await prisma.iplContestEntry.findFirst({
    where: { userId, contestId },
    select: { rank: true },
  });
  if (!entry || entry.rank === null) return null;

  const displayRank = entry.rank;

  // 2. Load contest prize tiers
  const contest = await prisma.iplContest.findUnique({
    where: { id: contestId },
    select: { prizeTiersConfig: true },
  });
  if (!contest) return null;

  const rawTiers = typeof contest.prizeTiersConfig === 'string'
    ? JSON.parse(contest.prizeTiersConfig as string)
    : contest.prizeTiersConfig;
  const tiers: any[] = Array.isArray(rawTiers) ? rawTiers : [];

  // 3. Verify display rank earns a claimable prize tier
  const matchingTier = tiers.find((t: any) => {
    const from = t.rank ?? t.rankFrom ?? 1;
    const to = t.rankTo ?? t.rank ?? from;
    return displayRank >= from && displayRank <= to;
  });

  const claimableTypes = ['INVENTORY', 'GIFT', 'XOXODAY'];
  if (!matchingTier || !claimableTypes.includes((matchingTier.type ?? '').toUpperCase())) return null;

  // 4. Find the claim record matching this user's display rank (latest if duplicates)
  const claim = await prisma.iplPrizeClaim.findFirst({
    where: { userId, iplContestId: contestId, rank: displayRank },
    orderBy: { createdAt: 'desc' },
  });

  return claim ?? null;
}

// ─── GET /api/ipl/contests/:contestId/my-prize ───────────────────────────────
export async function getMyPrize(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { contestId } = req.params as { contestId: string };

  try {
    const claim = await findValidPrizeClaim(userId, contestId);

    if (!claim) {
      // No claimable prize for this user in this contest
      success(res, { claim: null });
      return;
    }

    let inventory: any = null;
    if (claim.inventoryId) {
      inventory = await prisma.prizeInventory.findUnique({
        where: { id: claim.inventoryId },
        select: {
          id: true,
          name: true,
          description: true,
          imageUrl: true,
          category: true,
          marketValue: true,
          provider: true,
        },
      });
    }

    success(res, {
      claim: {
        id: claim.id,
        rank: claim.rank,
        prizeType: claim.prizeType,
        prizeName: claim.prizeName,
        prizeValue: claim.prizeValue,
        prizeImageUrl: claim.prizeImageUrl,
        status: claim.status,
        deliveryDetails: claim.deliveryDetails,
        claimedAt: claim.claimedAt,
        inventory,
      },
    });
  } catch (err) {
    logger.error('getMyPrize error:', err);
    error(res, 'Failed to fetch prize info', 500);
  }
}

// ─── POST /api/ipl/contests/:contestId/claim-prize ───────────────────────────
export async function claimPrize(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { contestId } = req.params as { contestId: string };
  const { name, phone, address, email } = req.body;

  try {
    const claim = await findValidPrizeClaim(userId, contestId);

    if (!claim) {
      error(res, 'No prize claim found for this contest', 404);
      return;
    }

    if (claim.status === 'claimed') {
      success(res, { message: 'Prize already claimed', alreadyClaimed: true });
      return;
    }

    const deliveryDetails: Record<string, string> = {};
    if (name) deliveryDetails.name = name;
    if (phone) deliveryDetails.phone = phone;
    if (address) deliveryDetails.address = address;
    if (email) deliveryDetails.email = email;

    await prisma.iplPrizeClaim.update({
      where: { id: claim.id },
      data: {
        status: 'claimed',
        deliveryDetails,
        claimedAt: new Date(),
      },
    });

    success(res, { message: 'Prize claim submitted! Our team will contact you shortly.' });
  } catch (err) {
    logger.error('claimPrize error:', err);
    error(res, 'Failed to submit claim', 500);
  }
}

// ─── GET /api/ipl/my-prizes ───────────────────────────────────────────────────
export async function getMyPrizeHistory(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  try {
    const claims = await prisma.iplPrizeClaim.findMany({
      where: { userId },
      include: {
        contest: {
          select: {
            id: true,
            name: true,
            match: { select: { team1: true, team2: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const result = claims.map(c => ({
      id: c.id,
      contestId: c.iplContestId,
      contestName: c.contest.name,
      matchTeam1: c.contest.match.team1,
      matchTeam2: c.contest.match.team2,
      rank: c.rank,
      prizeType: c.prizeType,
      prizeName: c.prizeName,
      prizeValue: c.prizeValue,
      prizeImageUrl: c.prizeImageUrl,
      status: c.status,
      deliveryDetails: c.deliveryDetails,
      claimedAt: c.claimedAt,
      createdAt: c.createdAt,
    }));

    success(res, { prizes: result, total: result.length });
  } catch (err) {
    logger.error('getMyPrizeHistory error:', err);
    error(res, 'Failed to fetch prize history', 500);
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
  const page   = parseInt(String(req.query.page)) || 1;
  const period = String(req.query.period || 'all'); // all | month | week | today
  const limit  = 50;
  const offset = (page - 1) * limit;

  try {
    // ── Period-based: sum coins earned from transactions in the time window ──
    if (period !== 'all') {
      const now = new Date();
      let since: Date;
      if (period === 'today') {
        since = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      } else if (period === 'week') {
        since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      } else { // month
        since = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      }

      // Sum positive transactions (earnings) per user in the period
      const txGroups = await prisma.transaction.groupBy({
        by: ['userId'],
        where: { amount: { gt: 0 }, createdAt: { gte: since } },
        _sum: { amount: true },
        orderBy: { _sum: { amount: 'desc' } },
        take: limit,
        skip: offset,
      });

      if (txGroups.length === 0) {
        success(res, { leaderboard: [], userRank: null, totalPlayers: 0 });
        return;
      }

      const userIds = txGroups.map(g => g.userId);
      const users = await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, favouriteTeam: true },
      });
      const userMap = new Map(users.map(u => [u.id, u]));

      const leaderboard = txGroups.map((g, i) => {
        const u = userMap.get(g.userId);
        const coinsEarned = g._sum.amount ?? 0;
        return {
          rank: offset + i + 1,
          userId: g.userId,
          name: maskName(u?.name || 'User'),
          avatar: (u?.name?.charAt(0) ?? 'U').toUpperCase(),
          favouriteTeam: u?.favouriteTeam ?? null,
          totalPoints: coinsEarned,
          coinsWon: coinsEarned,
          contestsPlayed: 0,
          isCurrentUser: g.userId === userId,
        };
      });

      const userRank = leaderboard.findIndex(p => p.userId === userId) + 1;
      const totalPlayers = await prisma.transaction.groupBy({
        by: ['userId'],
        where: { amount: { gt: 0 }, createdAt: { gte: since } },
      }).then(r => r.length);

      success(res, { leaderboard, userRank: userRank || null, totalPlayers });
      return;
    }

    // ── All Time: rank by current coin balance ────────────────────────────────
    const users = await prisma.user.findMany({
      where: { status: 'ACTIVE', coinBalance: { gt: 0 } },
      select: { id: true, name: true, coinBalance: true, favouriteTeam: true },
      orderBy: { coinBalance: 'desc' },
      take: limit,
      skip: offset,
    });

    const totalPlayers = await prisma.user.count({
      where: { status: 'ACTIVE', coinBalance: { gt: 0 } },
    });

    const leaderboard = users.map((u, i) => ({
      rank: offset + i + 1,
      userId: u.id,
      name: maskName(u.name || 'User'),
      avatar: (u.name?.charAt(0) ?? 'U').toUpperCase(),
      favouriteTeam: u.favouriteTeam,
      totalPoints: u.coinBalance,
      coinsWon: u.coinBalance,
      contestsPlayed: 0,
      isCurrentUser: u.id === userId,
    }));

    const userRank = leaderboard.findIndex(p => p.userId === userId) + 1;
    success(res, { leaderboard, userRank: userRank || null, totalPlayers });
  } catch (err) {
    logger.error('getGlobalLeaderboard error:', err);
    error(res, 'Failed to fetch leaderboard', 500);
  }
}
