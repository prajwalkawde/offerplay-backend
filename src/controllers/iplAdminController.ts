import { Request, Response } from 'express';
import { TransactionType } from '@prisma/client';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import { creditCoins } from '../services/coinService';
import { getTodayIPLMatches } from '../services/cricApiService';

// ─── Admin: List all matches with question + contest counts ───────────────────
export async function getAdminIPLMatches(_req: Request, res: Response): Promise<void> {
  const matches = await prisma.iplMatch.findMany({
    include: {
      questions: { select: { id: true } },
      contests: { select: { id: true, status: true } },
    },
    orderBy: { matchDate: 'asc' },
  });

  const result = matches.map(m => ({
    ...m,
    questionCount: m.questions.length,
    contestCount: m.contests.length,
    publishedContests: m.contests.filter(c => c.status === 'published' || c.status === 'live').length,
  }));

  success(res, result);
}

// ─── Admin: Create a match ─────────────────────────────────────────────────────
export async function createAdminIPLMatch(req: Request, res: Response): Promise<void> {
  const {
    team1, team2, matchDate, venue, matchNumber,
    youtubeUrl, matchStartTime, registrationCloseTime, resultDeclareTime,
  } = req.body as {
    team1: string; team2: string; matchDate: string; venue?: string;
    matchNumber?: number; youtubeUrl?: string;
    matchStartTime?: string; registrationCloseTime?: string; resultDeclareTime?: string;
  };

  if (!team1 || !team2 || !matchDate) { error(res, 'team1, team2, matchDate required', 400); return; }
  if (team1 === team2) { error(res, 'Teams must be different', 400); return; }

  const match = await prisma.iplMatch.create({
    data: {
      team1, team2,
      matchDate: new Date(matchDate),
      venue: venue || 'TBD',
      matchNumber: parseInt(String(matchNumber)) || 1,
      youtubeUrl: youtubeUrl || null,
      matchStartTime: matchStartTime ? new Date(matchStartTime) : null,
      registrationCloseTime: registrationCloseTime ? new Date(registrationCloseTime) : null,
      resultDeclareTime: resultDeclareTime ? new Date(resultDeclareTime) : null,
      status: 'upcoming',
    },
  });

  success(res, match, 'Match created!', 201);
}

// ─── Get all contests for a match ─────────────────────────────────────────────
export async function getMatchContests(req: Request, res: Response): Promise<void> {
  const { matchId } = req.params as { matchId: string };

  const contests = await prisma.iplContest.findMany({
    where: { matchId },
    include: { _count: { select: { entries: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const result = contests.map(c => ({
    ...c,
    currentPlayers: c._count.entries,
    _count: undefined,
  }));

  success(res, result);
}

// ─── Create a new contest for a match ─────────────────────────────────────────
export async function createIPLContest(req: Request, res: Response): Promise<void> {
  const { matchId } = req.params as { matchId: string };

  console.log('=== CREATE CONTEST REQUEST ===');
  console.log('prizeTiersConfig received:', JSON.stringify(req.body.prizeTiersConfig));
  console.log('winnersConfig received:', JSON.stringify(req.body.winnersConfig));
  console.log('questionsLockAt:', req.body.questionsLockAt);
  console.log('questionsAvailableAt:', req.body.questionsAvailableAt);
  console.log('==============================');

  const {
    name,
    contestType,
    battleType,
    maxPlayers,
    minPlayers,
    entryFee,
    isFree,
    prizeType,
    prizeCoins,
    prizeGiftName,
    prizeGiftImage,
    prizeGiftValue,
    rewardImageUrl,
    rewardImageType,
    questionCount,
    youtubeUrl,
    entryType,
    ticketCost,
    winnersConfig,
    prizeTiersConfig,
    sponsorId,
    sponsorName,
    sponsorLogo,
    maxEntriesPerUser,
    customFields,
    prizeDistribution,
    regCloseTime,
    questionsAvailableAt,
    questionsLockAt,
  } = req.body as {
    name: string; contestType: string; battleType: string;
    maxPlayers?: number; minPlayers?: number; entryFee: number;
    isFree?: boolean; entryType?: string; ticketCost?: number;
    prizeType?: string; prizeCoins?: number; prizeGiftName?: string;
    prizeGiftImage?: string; prizeGiftValue?: number;
    rewardImageUrl?: string; rewardImageType?: string;
    questionCount?: number; youtubeUrl?: string;
    winnersConfig?: unknown[]; prizeTiersConfig?: unknown[];
    sponsorId?: string; sponsorName?: string; sponsorLogo?: string;
    maxEntriesPerUser?: number;
    customFields?: object; prizeDistribution?: object; regCloseTime?: string;
    questionsAvailableAt?: string; questionsLockAt?: string;
  };

  if (!contestType || !battleType || entryFee === undefined) {
    error(res, 'contestType, battleType, entryFee required', 400);
    return;
  }

  const match = await prisma.iplMatch.findUnique({ where: { id: matchId } });
  if (!match) { error(res, 'Match not found', 404); return; }

  const resolvedMax =
    battleType === '1V1' ? 2 :
    battleType === 'SMALL' ? 4 :
    (maxPlayers ?? 1000);

  const resolvedName = name || `${battleType} Contest`;

  const contest = await prisma.iplContest.create({
    data: {
      matchId,
      name: resolvedName,
      contestType,
      battleType,
      maxPlayers: resolvedMax,
      minPlayers: minPlayers ?? 2,
      entryFee,
      entryType: entryType ?? 'TICKET',
      ticketCost: ticketCost ?? 1,
      isFree: isFree ?? (entryFee === 0),
      prizeType: prizeType ?? 'COINS',
      prizeCoins: prizeCoins ?? null,
      prizeGiftName: prizeGiftName ?? null,
      prizeGiftImage: prizeGiftImage ?? null,
      prizeGiftValue: prizeGiftValue ?? null,
      rewardImageUrl: rewardImageUrl ?? null,
      rewardImageType: rewardImageType ?? null,
      questionCount: questionCount ? parseInt(String(questionCount)) : 10,
      youtubeUrl: youtubeUrl ?? null,
      winnersConfig: (winnersConfig ?? []) as object[],
      prizeTiersConfig: (prizeTiersConfig ?? []) as object[],
      sponsorId: sponsorId ?? null,
      sponsorName: sponsorName ?? null,
      sponsorLogo: sponsorLogo ?? null,
      maxEntriesPerUser: maxEntriesPerUser ?? 3,
      customFields: customFields ?? undefined,
      prizeDistribution: (prizeDistribution ?? { '1': 40, '2': 25, '3': 15, '4-10': 20 }) as object,
      regCloseTime: regCloseTime ? new Date(regCloseTime) : null,
      questionsAvailableAt: questionsAvailableAt ? new Date(questionsAvailableAt) : null,
      questionsLockAt: questionsLockAt ? new Date(questionsLockAt) : null,
      status: 'draft',
    },
  });

  console.log('Contest saved with tiers:', JSON.stringify(contest.prizeTiersConfig));
  console.log('questionsLockAt saved:', contest.questionsLockAt);

  success(res, contest, 'Contest created successfully!', 201);
}

// ─── Update contest ────────────────────────────────────────────────────────────
export async function updateIPLContest(req: Request, res: Response): Promise<void> {
  const { contestId } = req.params as { contestId: string };

  // Strip relational fields that Prisma won't accept
  const { entries: _entries, match: _match, ...safeData } = req.body as Record<string, unknown>;

  const contest = await prisma.iplContest.update({
    where: { id: contestId },
    data: safeData,
  });

  success(res, contest, 'Contest updated');
}

// ─── Delete contest ────────────────────────────────────────────────────────────
export async function deleteIPLContest(req: Request, res: Response): Promise<void> {
  const { contestId } = req.params as { contestId: string };

  const contest = await prisma.iplContest.findUnique({
    where: { id: contestId },
    include: {
      entries: { select: { userId: true, coinsDeducted: true } },
      match: { select: { team1: true, team2: true } },
    },
  });

  if (!contest) { error(res, 'Contest not found', 404); return; }

  const entries = contest.entries;
  const refundedUserIds: string[] = [];

  // Refund participants
  if (entries.length > 0) {
    await prisma.$transaction(async (tx) => {
      for (const entry of entries) {
        if (contest.entryType === 'COINS' && entry.coinsDeducted > 0) {
          // Refund coins
          await tx.user.update({
            where: { id: entry.userId },
            data: { coinBalance: { increment: entry.coinsDeducted } },
          });
          await tx.transaction.create({
            data: {
              userId: entry.userId,
              type: 'REFUND' as any,
              amount: entry.coinsDeducted,
              description: `Refund: ${contest.name} cancelled`,
            },
          });
        } else if (contest.entryType === 'TICKET' && contest.ticketCost > 0) {
          // Refund ticket
          await tx.user.update({
            where: { id: entry.userId },
            data: { ticketBalance: { increment: contest.ticketCost } },
          });
        }
        refundedUserIds.push(entry.userId);
      }
    });
  }

  // Delete entries then contest
  await prisma.iplContestEntry.deleteMany({ where: { contestId } });
  await prisma.iplContest.delete({ where: { id: contestId } });

  // Send cancellation notification
  if (refundedUserIds.length > 0) {
    const { sendBulkNotification } = await import('../services/notificationService');
    const refundMsg = contest.entryType === 'COINS'
      ? ` Your entry fee has been refunded.`
      : contest.entryType === 'TICKET'
      ? ` Your ticket has been refunded.`
      : '';
    await sendBulkNotification(
      refundedUserIds,
      '❌ Contest Cancelled',
      `${contest.match.team1} vs ${contest.match.team2} — "${contest.name}" has been cancelled.${refundMsg}`,
      'CONTEST_CANCELLED'
    ).catch(() => {});
  }

  logger.info(`IPL contest cancelled: ${contest.name} (${contestId}), refunded ${refundedUserIds.length} participants`);
  success(res, { refundedCount: refundedUserIds.length }, `Contest cancelled. ${refundedUserIds.length} participants refunded.`);
}

// ─── Delete all questions for a match ─────────────────────────────────────────
export async function deleteMatchAllQuestions(req: Request, res: Response): Promise<void> {
  const { matchId } = req.params as { matchId: string };
  const { language } = req.query as { language?: string };

  const where: any = { matchId };
  if (language) where.language = language;

  // Only delete questions not linked to predictions
  const questions = await prisma.iplQuestion.findMany({ where, select: { id: true } });
  const qIds = questions.map(q => q.id);
  if (qIds.length === 0) { success(res, { deleted: 0 }, 'No questions to delete'); return; }

  const linked = await prisma.iplPrediction.findMany({
    where: { questionId: { in: qIds } },
    select: { questionId: true },
  });
  const linkedSet = new Set(linked.map(p => p.questionId));
  const deletable = qIds.filter(id => !linkedSet.has(id));

  const result = await prisma.iplQuestion.deleteMany({ where: { id: { in: deletable } } });
  const skipped = qIds.length - deletable.length;
  success(res, { deleted: result.count, skipped }, `Deleted ${result.count} questions${skipped > 0 ? `, skipped ${skipped} (linked to predictions)` : ''}`);
}

// ─── Publish contest ───────────────────────────────────────────────────────────
export async function publishIPLContest(req: Request, res: Response): Promise<void> {
  const { contestId } = req.params as { contestId: string };

  const contest = await prisma.iplContest.update({
    where: { id: contestId },
    data: { status: 'published' },
    include: { match: true },
  });

  try {
    const { sendToAll } = await import('../services/notificationService');
    await sendToAll(
      '🏏 New IPL Contest Live!',
      `${contest.match.team1} vs ${contest.match.team2} — ${contest.name} is open!`,
      'ipl_contest_published'
    );
  } catch (notifErr) {
    logger.warn('Failed to send publish notification:', notifErr);
  }

  logger.info(`IPL contest published: ${contest.name} (${contestId})`);
  success(res, contest, '🚀 Contest published! Users notified.');
}

// ─── Process results for a specific contest ────────────────────────────────────
interface PrizeTier {
  rank?: number;
  rankFrom?: number;
  rankTo?: number;
  type: 'gift' | 'coins';
  name?: string;
  imageUrl?: string;
  value?: number;
  coins?: number;
  inventoryId?: string;
}

export async function processIPLContestResults(req: Request, res: Response): Promise<void> {
  const { contestId } = req.params as { contestId: string };

  const contest = await prisma.iplContest.findUnique({
    where: { id: contestId },
    include: { entries: true, match: true },
  });

  if (!contest) { error(res, 'Contest not found', 404); return; }
  if (contest.status === 'completed') { error(res, 'Contest already processed', 400); return; }

  const entryUserIds = contest.entries.map(e => e.userId);

  const [predictions, questions] = await Promise.all([
    prisma.iplPrediction.findMany({
      where: { matchId: contest.matchId, userId: { in: entryUserIds } },
    }),
    prisma.iplQuestion.findMany({ where: { matchId: contest.matchId } }),
  ]);

  // Score each user — compare answer to correctAnswer directly
  const userScores: Record<string, number> = {};
  for (const entry of contest.entries) userScores[entry.userId] = 0;

  for (const pred of predictions) {
    const question = questions.find(q => q.id === pred.questionId);
    if (!question?.correctAnswer) continue;
    if (pred.answer === question.correctAnswer) {
      userScores[pred.userId] = (userScores[pred.userId] ?? 0) + question.points;
    }
  }

  const rankings = Object.entries(userScores)
    .sort(([, a], [, b]) => b - a)
    .map(([userId, score], i) => ({ userId, score, rank: i + 1 }));

  // Use prizeTiersConfig (new) → prizeTiers (old) → fallback
  const prizeTiers = (
    (contest.prizeTiersConfig as unknown as PrizeTier[])?.length > 0
      ? (contest.prizeTiersConfig as unknown as PrizeTier[])
      : (contest.prizeTiers as unknown as PrizeTier[])
  ) || [];
  const hasPrizeTiers = prizeTiers.length > 0;

  const totalPool = contest.entries.length * contest.entryFee;
  const prizePool = Math.floor(totalPool * 0.85);
  const dist = contest.prizeDistribution as Record<string, number>;

  let coinsDistributed = 0;
  let giftClaimsCreated = 0;

  for (const { userId, rank } of rankings) {
    let coinsAward = 0;
    let giftTier: PrizeTier | undefined;

    if (hasPrizeTiers) {
      // Find matching tier from admin-configured prize tiers
      const tier = prizeTiers.find(t => {
        if (t.rankFrom !== undefined && t.rankTo !== undefined) {
          return rank >= t.rankFrom && rank <= t.rankTo;
        }
        return t.rank === rank;
      });

      if (tier) {
        if (tier.type === 'gift') {
          giftTier = tier;
        } else {
          coinsAward = tier.coins ?? 0;
        }
      }
    } else if (contest.prizeType === 'COINS' && contest.prizeCoins && rank === 1) {
      coinsAward = contest.prizeCoins;
    } else {
      // Default percentage distribution
      if (rank === 1)       coinsAward = Math.floor(prizePool * (dist['1']    ?? 40) / 100);
      else if (rank === 2)  coinsAward = Math.floor(prizePool * (dist['2']    ?? 25) / 100);
      else if (rank === 3)  coinsAward = Math.floor(prizePool * (dist['3']    ?? 15) / 100);
      else if (rank <= 10)  coinsAward = Math.floor(prizePool * (dist['4-10'] ?? 20) / 100 / 7);
    }

    // Award coins
    if (coinsAward > 0) {
      await creditCoins(
        userId, coinsAward, TransactionType.EARN_IPL_WIN, contestId,
        `IPL Contest Win — ${contest.name} — Rank #${rank}`
      );
      await prisma.iplContestEntry.updateMany({
        where: { contestId, userId },
        data: { rank, coinsWon: coinsAward, totalPoints: userScores[userId] ?? 0 },
      });
      coinsDistributed += coinsAward;
    }

    // Award gift prize — create an IplPrizeClaim
    if (giftTier) {
      await prisma.iplPrizeClaim.create({
        data: {
          userId,
          iplContestId: contestId,
          rank,
          prizeType: 'gift',
          prizeName: giftTier.name || 'Gift Prize',
          prizeValue: giftTier.value ?? 0,
          prizeImageUrl: giftTier.imageUrl || '',
          inventoryId: giftTier.inventoryId || null,
          status: 'pending',
        },
      });
      await prisma.iplContestEntry.updateMany({
        where: { contestId, userId },
        data: { rank, totalPoints: userScores[userId] ?? 0 },
      });
      giftClaimsCreated++;
    }

    // Update rank+points for non-winners
    if (coinsAward === 0 && !giftTier) {
      await prisma.iplContestEntry.updateMany({
        where: { contestId, userId },
        data: { rank, totalPoints: userScores[userId] ?? 0 },
      });
    }
  }

  await prisma.iplContest.update({
    where: { id: contestId },
    data: { status: 'completed' },
  });

  logger.info(`IPL contest processed: ${contest.name} — ${rankings.length} participants, ${coinsDistributed} coins, ${giftClaimsCreated} gift claims`);

  success(res, {
    totalParticipants: contest.entries.length,
    coinsDistributed,
    giftClaimsCreated,
    rankings: rankings.slice(0, 10),
  }, 'Results processed! Prizes distributed to winners.');
}

// ─── Get contest participants ──────────────────────────────────────────────────
export async function getContestParticipants(req: Request, res: Response): Promise<void> {
  const { contestId } = req.params as { contestId: string };

  const entries = await prisma.iplContestEntry.findMany({
    where: { contestId },
    include: {
      user: { select: { id: true, name: true, phone: true, coinBalance: true } },
    },
    orderBy: { totalPoints: 'desc' },
  });

  success(res, { participants: entries, total: entries.length });
}

// ─── Update IPL match ─────────────────────────────────────────────────────────
export async function updateIPLMatch(req: Request, res: Response): Promise<void> {
  const { id } = req.params as { id: string };
  const {
    youtubeUrl, status, venue, matchNumber,
    matchStartTime, registrationCloseTime, resultDeclareTime,
  } = req.body as {
    youtubeUrl?: string; status?: string; venue?: string; matchNumber?: number;
    matchStartTime?: string; registrationCloseTime?: string; resultDeclareTime?: string;
  };

  const match = await prisma.iplMatch.update({
    where: { id },
    data: {
      ...(youtubeUrl !== undefined && { youtubeUrl }),
      ...(status !== undefined && { status }),
      ...(venue !== undefined && { venue }),
      ...(matchNumber !== undefined && { matchNumber }),
      ...(matchStartTime !== undefined && { matchStartTime: matchStartTime ? new Date(matchStartTime) : null }),
      ...(registrationCloseTime !== undefined && { registrationCloseTime: registrationCloseTime ? new Date(registrationCloseTime) : null }),
      ...(resultDeclareTime !== undefined && { resultDeclareTime: resultDeclareTime ? new Date(resultDeclareTime) : null }),
    },
  });

  success(res, match, 'Match updated!');
}

// ─── Process results for all contests in a match (with smart answer auto-fill) ─
export async function processIPLResults(req: Request, res: Response): Promise<void> {
  const {
    matchId,
    winner,
    team1Score,
    team2Score,
    manOfMatch,
  } = req.body as {
    matchId: string; winner: string; team1Score?: string;
    team2Score?: string; manOfMatch?: string;
  };

  if (!matchId || !winner) {
    error(res, 'matchId and winner are required', 400);
    return;
  }

  // Step 1: Update match result
  await prisma.iplMatch.update({
    where: { id: matchId },
    data: {
      status: 'completed',
      contestStatus: 'processing',
      result: `${winner} won. ${team1Score || ''} vs ${team2Score || ''}`.trim(),
      winnerId: winner,
      ...(team1Score && { team1Score }),
      ...(team2Score && { team2Score }),
      ...(manOfMatch && { manOfMatch }),
    },
  });

  // Step 2: Auto-fill correct answers via smart keyword matching
  const questions = await prisma.iplQuestion.findMany({ where: { matchId } });

  for (const q of questions) {
    const qLower = q.question.toLowerCase();
    let correctAnswer = q.correctAnswer;

    if (!correctAnswer) {
      if (qLower.includes('who will win') || qLower.includes('winner') || qLower.includes('which team will win')) {
        correctAnswer = winner;
      } else if (
        qLower.includes('man of the match') || qLower.includes('motm') ||
        qLower.includes('player of the match') || qLower.includes('best player')
      ) {
        correctAnswer = manOfMatch || '';
      }
      // Toss and other questions remain empty — admin sets manually
    }

    if (correctAnswer && correctAnswer !== q.correctAnswer) {
      await prisma.iplQuestion.update({
        where: { id: q.id },
        data: { correctAnswer },
      });
    }
  }

  // Step 3: Process each contest for this match
  const contests = await prisma.iplContest.findMany({
    where: { matchId, status: { in: ['published', 'live'] } },
    include: { entries: true },
  });

  let totalCoinsDistributed = 0;
  let totalWinners = 0;

  for (const contest of contests) {
    const userIds = contest.entries.map(e => e.userId);

    const [predictions, updatedQuestions] = await Promise.all([
      prisma.iplPrediction.findMany({
        where: { matchId, userId: { in: userIds } },
      }),
      prisma.iplQuestion.findMany({ where: { matchId } }),
    ]);

    const userScores: Record<string, number> = {};
    for (const entry of contest.entries) userScores[entry.userId] = 0;

    for (const pred of predictions) {
      const q = updatedQuestions.find(q => q.id === pred.questionId);
      if (!q?.correctAnswer) continue;
      if (pred.answer === q.correctAnswer) {
        userScores[pred.userId] = (userScores[pred.userId] ?? 0) + q.points;
      }
    }

    const rankings = Object.entries(userScores)
      .sort(([, a], [, b]) => b - a)
      .map(([userId, score], i) => ({ userId, score, rank: i + 1 }));

    const winnersConfig = (contest.winnersConfig as unknown[]) || [];
    const totalPool = contest.entries.length * contest.entryFee;
    const prizePool = Math.floor(totalPool * 0.85);

    for (const { userId, rank } of rankings) {
      let coinsToAward = 0;

      if (winnersConfig.length > 0) {
        const winnerRule = (winnersConfig as Array<{ rankFrom?: number; rankTo?: number; rank?: number; coins: number }>)
          .find(w => {
            if (w.rankFrom !== undefined && w.rankTo !== undefined) {
              return rank >= w.rankFrom && rank <= w.rankTo;
            }
            return w.rank === rank;
          });
        coinsToAward = winnerRule?.coins || 0;
      } else {
        if (rank === 1)       coinsToAward = Math.floor(prizePool * 0.40);
        else if (rank === 2)  coinsToAward = Math.floor(prizePool * 0.25);
        else if (rank === 3)  coinsToAward = Math.floor(prizePool * 0.15);
        else if (rank <= 10)  coinsToAward = Math.floor(prizePool * 0.20 / 7);
      }

      if (coinsToAward > 0) {
        await creditCoins(
          userId, coinsToAward, TransactionType.EARN_IPL_WIN, contest.id,
          `IPL Contest Win - Rank #${rank} - ${contest.name}`
        );
        await prisma.iplContestEntry.updateMany({
          where: { contestId: contest.id, userId },
          data: { rank, coinsWon: coinsToAward, totalPoints: userScores[userId] ?? 0 },
        });
        totalCoinsDistributed += coinsToAward;
        totalWinners++;
      } else {
        await prisma.iplContestEntry.updateMany({
          where: { contestId: contest.id, userId },
          data: { rank, totalPoints: userScores[userId] ?? 0 },
        });
      }
    }

    await prisma.iplContest.update({
      where: { id: contest.id },
      data: { status: 'completed' },
    });
  }

  await prisma.iplMatch.update({
    where: { id: matchId },
    data: { contestStatus: 'completed' },
  });

  // Step 4: Send push notifications to all participants
  try {
    const match = await prisma.iplMatch.findUnique({ where: { id: matchId } });
    const allParticipantIds = [...new Set(
      contests.flatMap(c => c.entries.map(e => e.userId))
    )];

    if (allParticipantIds.length > 0 && match) {
      // Collect all rankings across contests for notification text
      const allRankings: Record<string, number> = {};
      for (const contest of contests) {
        const userIds = contest.entries.map(e => e.userId);
        const predictions = await prisma.iplPrediction.findMany({
          where: { matchId, userId: { in: userIds } },
        });
        const updatedQuestions = await prisma.iplQuestion.findMany({ where: { matchId } });
        const scores: Record<string, number> = {};
        for (const e of contest.entries) scores[e.userId] = 0;
        for (const pred of predictions) {
          const q = updatedQuestions.find(x => x.id === pred.questionId);
          if (q?.correctAnswer && pred.answer === q.correctAnswer) {
            scores[pred.userId] = (scores[pred.userId] ?? 0) + q.points;
          }
        }
        Object.entries(scores)
          .sort(([, a], [, b]) => b - a)
          .forEach(([uid], i) => { allRankings[uid] = Math.min(allRankings[uid] ?? 999, i + 1); });
      }

      await prisma.notification.createMany({
        data: allParticipantIds.map(userId => {
          const rank = allRankings[userId];
          const isWinner = rank !== undefined && rank <= 10;
          return {
            userId,
            title: `🏏 ${match.team1} vs ${match.team2} Results!`,
            body: isWinner
              ? `🎉 You won! Rank #${rank}. Coins credited to your account!`
              : `${winner} won the match! Check your results in the app.`,
            type: 'IPL_RESULT',
          };
        }),
        skipDuplicates: true,
      });

      logger.info(`processIPLResults: sent ${allParticipantIds.length} result notifications`);
    }
  } catch (notifErr) {
    logger.warn('Notification sending failed:', notifErr);
  }

  logger.info(`processIPLResults: match ${matchId}, ${contests.length} contests, ${totalWinners} winners, ${totalCoinsDistributed} coins`);

  success(res, {
    matchId,
    winner,
    totalContests: contests.length,
    totalWinners,
    totalCoinsDistributed,
  }, 'Results processed! Coins credited to winners.');
}

// ─── Save edited questions for a match ────────────────────────────────────────
// Also propagates correctAnswer to same questionNumber in all other languages.
export async function saveEditedQuestions(req: Request, res: Response): Promise<void> {
  const { matchId } = req.params as { matchId: string };
  const { questions } = req.body as {
    questions?: Array<{
      id?: string; question: string; options: string[];
      correctAnswer?: string; points?: number;
      category?: string; difficulty?: string;
      questionNumber?: number;
    }>;
  };

  if (!questions || !Array.isArray(questions)) {
    error(res, 'Questions array required', 400);
    return;
  }

  let saved = 0;
  let propagated = 0;

  for (const q of questions) {
    if (q.id) {
      // Get current question to know its questionNumber
      const existing = await prisma.iplQuestion.findUnique({
        where: { id: q.id },
        select: { questionNumber: true },
      }).catch(() => null);

      await prisma.iplQuestion.update({
        where: { id: q.id },
        data: {
          question: q.question,
          options: q.options,
          correctAnswer: q.correctAnswer || '',
          points: q.points ?? 100,
          status: 'active',
          ...(q.category && { category: q.category }),
          ...(q.difficulty && { difficulty: q.difficulty }),
        },
      }).catch(() => {});

      // Propagate correctAnswer to all other-language questions with the same questionNumber
      const qNum = q.questionNumber ?? existing?.questionNumber;
      if (q.correctAnswer && qNum) {
        const result = await prisma.iplQuestion.updateMany({
          where: {
            matchId,
            questionNumber: qNum,
            id: { not: q.id },
            status: 'active',
          },
          data: { correctAnswer: q.correctAnswer },
        }).catch(() => null);
        propagated += result?.count ?? 0;
      }
    } else {
      await prisma.iplQuestion.create({
        data: {
          matchId,
          question: q.question,
          options: q.options,
          correctAnswer: q.correctAnswer || '',
          points: q.points ?? 100,
          category: q.category ?? 'prediction',
          difficulty: q.difficulty ?? 'medium',
          status: 'active',
          isAutoGenerated: false,
        },
      }).catch(() => {});
    }
    saved++;
  }

  logger.info(`saveEditedQuestions: ${saved} English questions saved, ${propagated} other-language questions propagated`);
  success(res, { saved, propagated }, `${saved} questions saved! (${propagated} translations updated)`);
}

// ─── Generate AI result report (auto-detect correct answers with confidence) ───
export async function generateResultReport(req: Request, res: Response): Promise<void> {
  try {
    const { matchId, winner, team1Score, team2Score, manOfMatch } = req.body as {
      matchId: string; winner: string; team1Score?: string;
      team2Score?: string; manOfMatch?: string;
    };

    if (!matchId || !winner) { error(res, 'matchId and winner required', 400); return; }

    const match = await prisma.iplMatch.findUnique({ where: { id: matchId } });
    if (!match) { error(res, 'Match not found', 404); return; }

    // Always load questions fresh from DB (English only for answer matching)
    const dbQuestions = await prisma.iplQuestion.findMany({
      where: { matchId, status: 'active', language: 'en' },
      orderBy: { questionNumber: 'asc' },
    });

    if (dbQuestions.length === 0) {
      success(res, { winner, team1Score, team2Score, manOfMatch, updatedQuestions: [], autoAnsweredCount: 0 });
      return;
    }

    // Step 1: Apply keyword auto-fill first (fast, deterministic)
    const keywordFilled = dbQuestions.map(q => {
      if (q.correctAnswer) return { ...q, confidence: 1.0, autoSource: 'existing' };
      const qLower = q.question.toLowerCase();
      const opts = q.options as string[];

      if (qLower.includes('who will win') || qLower.includes('winner') || qLower.includes('which team will win')) {
        const match = opts.find(o => o.toLowerCase().includes(winner.toLowerCase()));
        if (match) return { ...q, correctAnswer: match, confidence: 1.0, autoSource: 'keyword' };
      }
      if (qLower.includes('man of') || qLower.includes('motm') || qLower.includes('player of the match')) {
        if (manOfMatch) {
          const firstName = manOfMatch.toLowerCase().split(' ')[0];
          const match = opts.find(o => o.toLowerCase().includes(firstName));
          if (match) return { ...q, correctAnswer: match, confidence: 0.95, autoSource: 'keyword' };
        }
      }
      return { ...q, correctAnswer: q.correctAnswer || '', confidence: 0, autoSource: 'needs_review' };
    });

    // Step 2: Use Claude Sonnet for remaining unanswered questions
    const unanswered = keywordFilled.filter(q => !q.correctAnswer);

    if (unanswered.length > 0) {
      try {
        const Anthropic = require('@anthropic-ai/sdk').default as typeof import('@anthropic-ai/sdk').default;
        const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

        const prompt = `You are verifying IPL T20 match prediction contest answers based on the actual match scorecard.

MATCH RESULT:
Match: ${match.team1} vs ${match.team2}
Winner: ${winner}
${match.team1} Score: ${team1Score || 'Not provided'}
${match.team2} Score: ${team2Score || 'Not provided'}
Man of the Match: ${manOfMatch || 'Not provided'}

QUESTIONS TO ANSWER (these are pre-match predictions):
${JSON.stringify(unanswered.map(q => ({ id: q.id, question: q.question, options: q.options as string[] })), null, 2)}

For each question, pick the correct answer from the given options based ONLY on the match result above.

RULES:
- correctAnswer MUST exactly match one of the provided options (copy it exactly)
- confidence: 0.95 = very sure, 0.80 = fairly sure, 0.60 = guessing
- If the match result doesn't have enough info to answer (e.g. powerplay scores not given), set correctAnswer to "" and confidence to 0
- For "winning margin" questions: use the scores provided to estimate
- For "total runs" questions: add both team scores if provided

Return ONLY a valid JSON array:
[{"id":"<id>","correctAnswer":"<exact option text or empty>","confidence":<0-1>,"reason":"<1 line why>"}]`;

        const response = await claude.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          messages: [{ role: 'user', content: prompt }],
        });

        const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const aiAnswers: Array<{ id: string; correctAnswer: string; confidence: number; reason: string }> =
            JSON.parse(jsonMatch[0]);

          // Merge AI answers back — cast to any[] to allow extra fields for admin UI
          const filled = keywordFilled as any[];
          for (const ai of aiAnswers) {
            const idx = filled.findIndex((q: any) => q.id === ai.id);
            if (idx !== -1 && ai.correctAnswer) {
              filled[idx] = {
                ...filled[idx],
                correctAnswer: ai.correctAnswer,
                confidence: ai.confidence,
                autoSource: 'ai',
                aiReason: ai.reason,
              };
            }
          }
        }
      } catch (aiErr) {
        logger.warn('Claude Sonnet AI answer detection failed:', aiErr);
      }
    }

    const answered = keywordFilled.filter(q => q.correctAnswer).length;
    const highConf  = keywordFilled.filter(q => (q.confidence as number) >= 0.85).length;
    const needsReview = keywordFilled.filter(q => !q.correctAnswer || (q.confidence as number) < 0.7).length;

    success(res, {
      winner, team1Score, team2Score, manOfMatch,
      updatedQuestions: keywordFilled,
      autoAnsweredCount: answered,
      highConfidenceCount: highConf,
      needsReviewCount: needsReview,
      totalQuestions: dbQuestions.length,
    }, `Auto-detected ${answered}/${dbQuestions.length} answers (${highConf} high confidence)`);

  } catch (err) {
    logger.error('generateResultReport error:', err);
    error(res, 'Failed to generate result report', 500);
  }
}

// ─── Fetch today's IPL matches from Cricbuzz and upsert into DB ───────────────
export async function fetchTodayMatches(req: Request, res: Response): Promise<void> {
  const matches = await getTodayIPLMatches();

  if (matches.length === 0) {
    success(res, [], 'No IPL matches today');
    return;
  }

  const savedMatches = [];

  for (const match of matches) {
    if (!match.team1 || !match.team2) continue;

    const cricApiId = match.id?.toString();

    const existing = cricApiId
      ? await prisma.iplMatch.findFirst({ where: { cricApiId } })
      : null;

    if (existing) {
      savedMatches.push(existing);
    } else {
      const saved: Awaited<ReturnType<typeof prisma.iplMatch.create>> = await prisma.iplMatch.create({
        data: {
          team1: match.team1,
          team2: match.team2,
          matchDate: match.startTime ? new Date(parseInt(match.startTime)) : new Date(),
          venue: match.venue || match.city || 'TBD',
          status: 'upcoming',
          cricApiId: cricApiId ?? null,
          matchNumber: savedMatches.length + 1,
        },
      });
      savedMatches.push(saved);
    }
  }

  logger.info(`fetchTodayMatches: ${savedMatches.length} IPL matches upserted`);
  success(res, savedMatches, `${savedMatches.length} IPL matches fetched`);
}

// ─── Generate AI questions for a match ────────────────────────────────────────
const ALL_LANGUAGES = ['en', 'hi', 'hinglish', 'ta', 'te', 'bn', 'mr'];

export async function generateIPLQuestions(req: Request, res: Response): Promise<void> {
  const { matchId, questionCount } = req.body as { matchId?: string; questionCount?: number };

  if (!matchId) { error(res, 'matchId required', 400); return; }

  const match = await prisma.iplMatch.findUnique({ where: { id: matchId } });
  if (!match) { error(res, 'Match not found', 404); return; }

  const count = questionCount || 30;
  const { generateQuestionsWithContext } = await import('../services/claudeAiService');

  const matchBase = {
    team1: match.team1, team2: match.team2,
    date: match.matchDate.toDateString(), venue: match.venue ?? 'TBD',
    team1Players: Array.isArray(match.team1Players) ? match.team1Players as string[] : undefined,
    team2Players: Array.isArray(match.team2Players) ? match.team2Players as string[] : undefined,
    questionCount: count,
  };

  // Respond immediately — generation runs in background (Nginx would timeout otherwise)
  success(res, { status: 'generating', matchId }, 'Question generation started! Check back in 30 seconds.');

  // Run generation in background
  (async () => {
    try {
      // Delete existing auto-generated questions that have no user predictions linked
      const existingQuestions = await prisma.iplQuestion.findMany({
        where: { matchId: match.id, isAutoGenerated: true },
        select: { id: true },
      });
      const existingIds = existingQuestions.map(q => q.id);
      if (existingIds.length > 0) {
        const linkedIds = await prisma.iplPrediction.findMany({
          where: { questionId: { in: existingIds } },
          select: { questionId: true },
          distinct: ['questionId'],
        });
        const linkedSet = new Set(linkedIds.map(p => p.questionId));
        const deletableIds = existingIds.filter(id => !linkedSet.has(id));
        if (deletableIds.length > 0) {
          await prisma.iplQuestion.deleteMany({ where: { id: { in: deletableIds } } });
        }
      }

      // Generate languages sequentially to avoid Claude rate limits (max 2 concurrent connections)
      logger.info(`Generating questions for ${ALL_LANGUAGES.length} languages for match ${match.id}`);

      let totalCreated = 0;
      for (const lang of ALL_LANGUAGES) {
        try {
          const questions = await generateQuestionsWithContext({ ...matchBase, language: lang });
          if (questions.length === 0) continue;

          await Promise.all(
            questions.map((q, i) =>
              prisma.iplQuestion.create({
                data: {
                  matchId: match.id, question: q.question, options: q.options,
                  correctAnswer: q.correctAnswer ?? '', points: q.points ?? 100,
                  category: q.category ?? 'prediction', difficulty: q.difficulty ?? 'medium',
                  status: 'active', isAutoGenerated: true, generatedBy: 'claude-ai', approved: false,
                  questionNumber: i + 1,
                  questionContext: (q as any).questionContext || null,
                  language: lang,
                },
              })
            )
          );
          totalCreated += questions.length;
          logger.info(`Saved ${questions.length} questions for language: ${lang}`);
        } catch (langErr) {
          logger.error(`Failed for language ${lang}:`, langErr);
        }
      }

      await prisma.iplMatch.update({
        where: { id: matchId },
        data: { questionsGenerated: true },
      });

      logger.info(`✅ Background generation complete: ${totalCreated} questions for match ${match.id}`);
    } catch (err) {
      logger.error('Background question generation failed:', err);
    }
  })();
}

// ─── IPL analytics ────────────────────────────────────────────────────────────
export async function deleteAdminIPLMatch(req: Request, res: Response): Promise<void> {
  const id = req.params.id as string;

  // Cascade delete in order: entries → predictions (via questions) → contests → questions → match
  await prisma.iplContestEntry.deleteMany({ where: { contest: { matchId: id } } });
  await prisma.iplPrediction.deleteMany({ where: { question: { matchId: id } } });
  await prisma.iplContest.deleteMany({ where: { matchId: id } });
  await prisma.iplQuestion.deleteMany({ where: { matchId: id } });
  await prisma.iplMatch.delete({ where: { id } });

  success(res, { message: 'Match deleted successfully' });
}

export async function getIPLAnalytics(_req: Request, res: Response): Promise<void> {
  const [matches, totalContestEntries, totalCoinsDistributed] = await Promise.all([
    prisma.iplMatch.findMany({
      include: {
        contests: { include: { _count: { select: { entries: true } } } },
        _count: { select: { predictions: true } },
      },
      orderBy: { matchDate: 'asc' },
    }),
    prisma.iplContestEntry.count(),
    prisma.transaction.aggregate({
      where: { type: 'EARN_IPL_WIN' },
      _sum: { amount: true },
    }),
  ]);

  const matchStats = matches.map(m => ({
    id: m.id,
    team1: m.team1,
    team2: m.team2,
    matchDate: m.matchDate,
    status: m.status,
    predictions: m._count.predictions,
    totalContests: m.contests.length,
    totalEntries: m.contests.reduce((sum, c) => sum + c._count.entries, 0),
  }));

  success(res, {
    totalMatches: matches.length,
    totalContestEntries,
    totalCoinsDistributed: totalCoinsDistributed._sum.amount ?? 0,
    matches: matchStats,
  });
}

// ─── Full IPL 2026 schedule ───────────────────────────────────────────────────
const IPL_2026_SCHEDULE = [
  // ── Week 1 (Mar 22–29) ──────────────────────────────────────────────────────
  { matchNumber: 1,  team1: 'KKR',  team2: 'RCB',  matchDate: new Date('2026-03-22T14:00:00Z'), venue: 'Eden Gardens, Kolkata' },
  { matchNumber: 2,  team1: 'SRH',  team2: 'RR',   matchDate: new Date('2026-03-23T10:00:00Z'), venue: 'Rajiv Gandhi Intl. Stadium, Hyderabad' },
  { matchNumber: 3,  team1: 'DC',   team2: 'LSG',  matchDate: new Date('2026-03-23T14:00:00Z'), venue: 'Arun Jaitley Stadium, Delhi' },
  { matchNumber: 4,  team1: 'GT',   team2: 'PBKS', matchDate: new Date('2026-03-24T14:00:00Z'), venue: 'Narendra Modi Stadium, Ahmedabad' },
  { matchNumber: 5,  team1: 'MI',   team2: 'CSK',  matchDate: new Date('2026-03-25T14:00:00Z'), venue: 'Wankhede Stadium, Mumbai' },
  { matchNumber: 6,  team1: 'RR',   team2: 'KKR',  matchDate: new Date('2026-03-26T14:00:00Z'), venue: 'Sawai Mansingh Stadium, Jaipur' },
  { matchNumber: 7,  team1: 'LSG',  team2: 'SRH',  matchDate: new Date('2026-03-27T14:00:00Z'), venue: 'BRSABV Ekana Cricket Stadium, Lucknow' },
  { matchNumber: 8,  team1: 'RCB',  team2: 'DC',   matchDate: new Date('2026-03-28T14:00:00Z'), venue: 'M Chinnaswamy Stadium, Bengaluru' },
  { matchNumber: 9,  team1: 'PBKS', team2: 'MI',   matchDate: new Date('2026-03-29T10:00:00Z'), venue: 'Maharaja Yadavindra Singh Cricket Stadium, Mullanpur' },
  { matchNumber: 10, team1: 'CSK',  team2: 'GT',   matchDate: new Date('2026-03-29T14:00:00Z'), venue: 'MA Chidambaram Stadium, Chennai' },
  // ── Week 2 (Mar 30–Apr 5) ───────────────────────────────────────────────────
  { matchNumber: 11, team1: 'KKR',  team2: 'SRH',  matchDate: new Date('2026-03-30T14:00:00Z'), venue: 'Eden Gardens, Kolkata' },
  { matchNumber: 12, team1: 'DC',   team2: 'RR',   matchDate: new Date('2026-03-31T14:00:00Z'), venue: 'Arun Jaitley Stadium, Delhi' },
  { matchNumber: 13, team1: 'RCB',  team2: 'LSG',  matchDate: new Date('2026-04-01T14:00:00Z'), venue: 'M Chinnaswamy Stadium, Bengaluru' },
  { matchNumber: 14, team1: 'MI',   team2: 'GT',   matchDate: new Date('2026-04-02T14:00:00Z'), venue: 'Wankhede Stadium, Mumbai' },
  { matchNumber: 15, team1: 'PBKS', team2: 'KKR',  matchDate: new Date('2026-04-03T14:00:00Z'), venue: 'Maharaja Yadavindra Singh Cricket Stadium, Mullanpur' },
  { matchNumber: 16, team1: 'CSK',  team2: 'SRH',  matchDate: new Date('2026-04-04T10:00:00Z'), venue: 'MA Chidambaram Stadium, Chennai' },
  { matchNumber: 17, team1: 'GT',   team2: 'DC',   matchDate: new Date('2026-04-04T14:00:00Z'), venue: 'Narendra Modi Stadium, Ahmedabad' },
  { matchNumber: 18, team1: 'RR',   team2: 'MI',   matchDate: new Date('2026-04-05T14:00:00Z'), venue: 'Sawai Mansingh Stadium, Jaipur' },
  // ── Week 3 (Apr 6–12) ───────────────────────────────────────────────────────
  { matchNumber: 19, team1: 'LSG',  team2: 'PBKS', matchDate: new Date('2026-04-06T14:00:00Z'), venue: 'BRSABV Ekana Cricket Stadium, Lucknow' },
  { matchNumber: 20, team1: 'KKR',  team2: 'CSK',  matchDate: new Date('2026-04-07T14:00:00Z'), venue: 'Eden Gardens, Kolkata' },
  { matchNumber: 21, team1: 'SRH',  team2: 'GT',   matchDate: new Date('2026-04-08T14:00:00Z'), venue: 'Rajiv Gandhi Intl. Stadium, Hyderabad' },
  { matchNumber: 22, team1: 'RCB',  team2: 'MI',   matchDate: new Date('2026-04-09T14:00:00Z'), venue: 'M Chinnaswamy Stadium, Bengaluru' },
  { matchNumber: 23, team1: 'DC',   team2: 'PBKS', matchDate: new Date('2026-04-10T14:00:00Z'), venue: 'Arun Jaitley Stadium, Delhi' },
  { matchNumber: 24, team1: 'RR',   team2: 'LSG',  matchDate: new Date('2026-04-11T10:00:00Z'), venue: 'Sawai Mansingh Stadium, Jaipur' },
  { matchNumber: 25, team1: 'CSK',  team2: 'KKR',  matchDate: new Date('2026-04-11T14:00:00Z'), venue: 'MA Chidambaram Stadium, Chennai' },
  { matchNumber: 26, team1: 'GT',   team2: 'RCB',  matchDate: new Date('2026-04-12T14:00:00Z'), venue: 'Narendra Modi Stadium, Ahmedabad' },
  // ── Week 4 (Apr 13–19) ──────────────────────────────────────────────────────
  { matchNumber: 27, team1: 'MI',   team2: 'SRH',  matchDate: new Date('2026-04-13T14:00:00Z'), venue: 'Wankhede Stadium, Mumbai' },
  { matchNumber: 28, team1: 'PBKS', team2: 'RR',   matchDate: new Date('2026-04-14T10:00:00Z'), venue: 'Maharaja Yadavindra Singh Cricket Stadium, Mullanpur' },
  { matchNumber: 29, team1: 'LSG',  team2: 'DC',   matchDate: new Date('2026-04-14T14:00:00Z'), venue: 'BRSABV Ekana Cricket Stadium, Lucknow' },
  { matchNumber: 30, team1: 'KKR',  team2: 'GT',   matchDate: new Date('2026-04-15T14:00:00Z'), venue: 'Eden Gardens, Kolkata' },
  { matchNumber: 31, team1: 'CSK',  team2: 'RCB',  matchDate: new Date('2026-04-16T14:00:00Z'), venue: 'MA Chidambaram Stadium, Chennai' },
  { matchNumber: 32, team1: 'SRH',  team2: 'PBKS', matchDate: new Date('2026-04-17T14:00:00Z'), venue: 'Rajiv Gandhi Intl. Stadium, Hyderabad' },
  { matchNumber: 33, team1: 'RR',   team2: 'GT',   matchDate: new Date('2026-04-18T10:00:00Z'), venue: 'Sawai Mansingh Stadium, Jaipur' },
  { matchNumber: 34, team1: 'MI',   team2: 'DC',   matchDate: new Date('2026-04-18T14:00:00Z'), venue: 'Wankhede Stadium, Mumbai' },
  { matchNumber: 35, team1: 'LSG',  team2: 'KKR',  matchDate: new Date('2026-04-19T14:00:00Z'), venue: 'BRSABV Ekana Cricket Stadium, Lucknow' },
  // ── Week 5 (Apr 20–26) ──────────────────────────────────────────────────────
  { matchNumber: 36, team1: 'RCB',  team2: 'SRH',  matchDate: new Date('2026-04-20T14:00:00Z'), venue: 'M Chinnaswamy Stadium, Bengaluru' },
  { matchNumber: 37, team1: 'PBKS', team2: 'CSK',  matchDate: new Date('2026-04-21T14:00:00Z'), venue: 'Maharaja Yadavindra Singh Cricket Stadium, Mullanpur' },
  { matchNumber: 38, team1: 'DC',   team2: 'KKR',  matchDate: new Date('2026-04-22T14:00:00Z'), venue: 'Arun Jaitley Stadium, Delhi' },
  { matchNumber: 39, team1: 'GT',   team2: 'MI',   matchDate: new Date('2026-04-23T14:00:00Z'), venue: 'Narendra Modi Stadium, Ahmedabad' },
  { matchNumber: 40, team1: 'RR',   team2: 'RCB',  matchDate: new Date('2026-04-24T14:00:00Z'), venue: 'Sawai Mansingh Stadium, Jaipur' },
  { matchNumber: 41, team1: 'SRH',  team2: 'LSG',  matchDate: new Date('2026-04-25T10:00:00Z'), venue: 'Rajiv Gandhi Intl. Stadium, Hyderabad' },
  { matchNumber: 42, team1: 'CSK',  team2: 'DC',   matchDate: new Date('2026-04-25T14:00:00Z'), venue: 'MA Chidambaram Stadium, Chennai' },
  { matchNumber: 43, team1: 'KKR',  team2: 'PBKS', matchDate: new Date('2026-04-26T14:00:00Z'), venue: 'Eden Gardens, Kolkata' },
  // ── Week 6 (Apr 27–May 3) ───────────────────────────────────────────────────
  { matchNumber: 44, team1: 'MI',   team2: 'RR',   matchDate: new Date('2026-04-27T14:00:00Z'), venue: 'Wankhede Stadium, Mumbai' },
  { matchNumber: 45, team1: 'GT',   team2: 'LSG',  matchDate: new Date('2026-04-28T14:00:00Z'), venue: 'Narendra Modi Stadium, Ahmedabad' },
  { matchNumber: 46, team1: 'RCB',  team2: 'CSK',  matchDate: new Date('2026-04-29T14:00:00Z'), venue: 'M Chinnaswamy Stadium, Bengaluru' },
  { matchNumber: 47, team1: 'DC',   team2: 'SRH',  matchDate: new Date('2026-04-30T14:00:00Z'), venue: 'Arun Jaitley Stadium, Delhi' },
  { matchNumber: 48, team1: 'PBKS', team2: 'GT',   matchDate: new Date('2026-05-01T14:00:00Z'), venue: 'Maharaja Yadavindra Singh Cricket Stadium, Mullanpur' },
  { matchNumber: 49, team1: 'KKR',  team2: 'MI',   matchDate: new Date('2026-05-02T10:00:00Z'), venue: 'Eden Gardens, Kolkata' },
  { matchNumber: 50, team1: 'RR',   team2: 'CSK',  matchDate: new Date('2026-05-02T14:00:00Z'), venue: 'Sawai Mansingh Stadium, Jaipur' },
  { matchNumber: 51, team1: 'LSG',  team2: 'RCB',  matchDate: new Date('2026-05-03T14:00:00Z'), venue: 'BRSABV Ekana Cricket Stadium, Lucknow' },
  // ── Week 7 (May 4–10) ───────────────────────────────────────────────────────
  { matchNumber: 52, team1: 'SRH',  team2: 'KKR',  matchDate: new Date('2026-05-04T14:00:00Z'), venue: 'Rajiv Gandhi Intl. Stadium, Hyderabad' },
  { matchNumber: 53, team1: 'GT',   team2: 'RR',   matchDate: new Date('2026-05-05T14:00:00Z'), venue: 'Narendra Modi Stadium, Ahmedabad' },
  { matchNumber: 54, team1: 'MI',   team2: 'PBKS', matchDate: new Date('2026-05-06T14:00:00Z'), venue: 'Wankhede Stadium, Mumbai' },
  { matchNumber: 55, team1: 'CSK',  team2: 'LSG',  matchDate: new Date('2026-05-07T14:00:00Z'), venue: 'MA Chidambaram Stadium, Chennai' },
  { matchNumber: 56, team1: 'DC',   team2: 'GT',   matchDate: new Date('2026-05-08T14:00:00Z'), venue: 'Arun Jaitley Stadium, Delhi' },
  { matchNumber: 57, team1: 'RCB',  team2: 'KKR',  matchDate: new Date('2026-05-09T10:00:00Z'), venue: 'M Chinnaswamy Stadium, Bengaluru' },
  { matchNumber: 58, team1: 'RR',   team2: 'SRH',  matchDate: new Date('2026-05-09T14:00:00Z'), venue: 'Sawai Mansingh Stadium, Jaipur' },
  { matchNumber: 59, team1: 'PBKS', team2: 'LSG',  matchDate: new Date('2026-05-10T14:00:00Z'), venue: 'Maharaja Yadavindra Singh Cricket Stadium, Mullanpur' },
  // ── Week 8 (May 11–17) ──────────────────────────────────────────────────────
  { matchNumber: 60, team1: 'MI',   team2: 'RCB',  matchDate: new Date('2026-05-11T14:00:00Z'), venue: 'Wankhede Stadium, Mumbai' },
  { matchNumber: 61, team1: 'CSK',  team2: 'PBKS', matchDate: new Date('2026-05-12T14:00:00Z'), venue: 'MA Chidambaram Stadium, Chennai' },
  { matchNumber: 62, team1: 'GT',   team2: 'SRH',  matchDate: new Date('2026-05-13T14:00:00Z'), venue: 'Narendra Modi Stadium, Ahmedabad' },
  { matchNumber: 63, team1: 'KKR',  team2: 'DC',   matchDate: new Date('2026-05-14T14:00:00Z'), venue: 'Eden Gardens, Kolkata' },
  { matchNumber: 64, team1: 'RR',   team2: 'PBKS', matchDate: new Date('2026-05-15T14:00:00Z'), venue: 'Sawai Mansingh Stadium, Jaipur' },
  { matchNumber: 65, team1: 'LSG',  team2: 'MI',   matchDate: new Date('2026-05-16T10:00:00Z'), venue: 'BRSABV Ekana Cricket Stadium, Lucknow' },
  { matchNumber: 66, team1: 'RCB',  team2: 'GT',   matchDate: new Date('2026-05-16T14:00:00Z'), venue: 'M Chinnaswamy Stadium, Bengaluru' },
  { matchNumber: 67, team1: 'SRH',  team2: 'CSK',  matchDate: new Date('2026-05-17T10:00:00Z'), venue: 'Rajiv Gandhi Intl. Stadium, Hyderabad' },
  { matchNumber: 68, team1: 'DC',   team2: 'RR',   matchDate: new Date('2026-05-17T14:00:00Z'), venue: 'Arun Jaitley Stadium, Delhi' },
  // ── Week 9 — Final league round (May 18–21) ─────────────────────────────────
  { matchNumber: 69, team1: 'PBKS', team2: 'RCB',  matchDate: new Date('2026-05-18T14:00:00Z'), venue: 'Maharaja Yadavindra Singh Cricket Stadium, Mullanpur' },
  { matchNumber: 70, team1: 'KKR',  team2: 'LSG',  matchDate: new Date('2026-05-19T14:00:00Z'), venue: 'Eden Gardens, Kolkata' },
  { matchNumber: 71, team1: 'MI',   team2: 'GT',   matchDate: new Date('2026-05-20T10:00:00Z'), venue: 'Wankhede Stadium, Mumbai' },
  { matchNumber: 72, team1: 'CSK',  team2: 'RR',   matchDate: new Date('2026-05-20T14:00:00Z'), venue: 'MA Chidambaram Stadium, Chennai' },
  // ── Playoffs ─────────────────────────────────────────────────────────────────
  { matchNumber: 73, team1: 'TBD',  team2: 'TBD',  matchDate: new Date('2026-05-27T14:00:00Z'), venue: 'Narendra Modi Stadium, Ahmedabad' },  // Qualifier 1
  { matchNumber: 74, team1: 'TBD',  team2: 'TBD',  matchDate: new Date('2026-05-28T14:00:00Z'), venue: 'Narendra Modi Stadium, Ahmedabad' },  // Eliminator
  { matchNumber: 75, team1: 'TBD',  team2: 'TBD',  matchDate: new Date('2026-05-30T14:00:00Z'), venue: 'Eden Gardens, Kolkata' },              // Qualifier 2
  { matchNumber: 76, team1: 'TBD',  team2: 'TBD',  matchDate: new Date('2026-06-01T14:00:00Z'), venue: 'Eden Gardens, Kolkata' },              // Final
];

// ─── Fetch / sync IPL 2026 schedule ──────────────────────────────────────────
// Body params:
//   fromDate  (optional) – ISO date string, e.g. "2026-04-09"  → only sync matches on/after this date
//   toDate    (optional) – ISO date string, e.g. "2026-05-31"  → only sync matches on/before this date
//   If neither is provided, defaults to today onwards.
export async function fetchIPLSchedule(req: Request, res: Response): Promise<void> {
  try {
    const { fromDate, toDate } = (req.body || {}) as { fromDate?: string; toDate?: string };

    // ── Build date window ────────────────────────────────────────────────────
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const nowIst = new Date(Date.now() + istOffsetMs);
    nowIst.setHours(0, 0, 0, 0);
    const defaultFrom = new Date(nowIst.getTime() - istOffsetMs); // today midnight UTC

    const from: Date = fromDate ? new Date(fromDate) : defaultFrom;
    const to:   Date = toDate   ? new Date(toDate)   : new Date('2026-12-31T23:59:59Z');

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      error(res, 'Invalid fromDate or toDate. Use ISO format e.g. "2026-04-09"', 400);
      return;
    }
    if (from > to) {
      error(res, 'fromDate must be before toDate', 400);
      return;
    }

    // ── Filter schedule to requested window ──────────────────────────────────
    const matchesToSync = IPL_2026_SCHEDULE.filter(
      m => m.matchDate >= from && m.matchDate <= to,
    );

    if (matchesToSync.length === 0) {
      success(res, { created: 0, updated: 0, skipped: 0, total: 0, from: from.toISOString(), to: to.toISOString() },
        'No matches found in the specified date range');
      return;
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const m of matchesToSync) {
      const cricApiId = `ipl2026-match-${m.matchNumber}`;

      let existing = await prisma.iplMatch.findUnique({ where: { cricApiId } });
      if (!existing) {
        existing = await prisma.iplMatch.findFirst({ where: { matchNumber: m.matchNumber } }) ?? null;
      }

      if (existing) {
        // Never overwrite a live/completed match's status
        if (existing.status === 'completed' || existing.status === 'live') {
          skipped++;
          continue;
        }
        await prisma.iplMatch.update({
          where: { id: existing.id },
          data: {
            cricApiId,
            team1: m.team1, team2: m.team2,
            matchDate: m.matchDate,
            matchStartTime: m.matchDate,
            venue: m.venue,
            matchNumber: m.matchNumber,
          },
        });
        updated++;
      } else {
        await prisma.iplMatch.create({
          data: {
            cricApiId,
            matchNumber: m.matchNumber,
            team1: m.team1,
            team2: m.team2,
            matchDate: m.matchDate,
            matchStartTime: m.matchDate,
            venue: m.venue,
            status: 'upcoming',
          },
        });
        created++;
      }
    }

    success(res, {
      created, updated, skipped,
      total: matchesToSync.length,
      from: from.toISOString(),
      to:   to.toISOString(),
    }, `Synced ${matchesToSync.length} matches (${created} created, ${updated} updated, ${skipped} skipped)`);

  } catch (err) {
    logger.error('fetchIPLSchedule error:', err);
    error(res, 'Failed to fetch schedule', 500);
  }
}

// ─── Team code/name → logo URL mapping (official IPL CDN) ────────────────────
const TEAM_LOGO_MAP: Record<string, string> = {
  // Short codes (how they're stored in DB)
  'mi':   'https://scores.iplt20.com/ipl/teamlogos/MI.png',
  'csk':  'https://scores.iplt20.com/ipl/teamlogos/CSK.png',
  'rcb':  'https://scores.iplt20.com/ipl/teamlogos/RCB.png',
  'kkr':  'https://scores.iplt20.com/ipl/teamlogos/KKR.png',
  'srh':  'https://scores.iplt20.com/ipl/teamlogos/SRH.png',
  'dc':   'https://scores.iplt20.com/ipl/teamlogos/DC.png',
  'pbks': 'https://scores.iplt20.com/ipl/teamlogos/PBKS.png',
  'rr':   'https://scores.iplt20.com/ipl/teamlogos/RR.png',
  'gt':   'https://scores.iplt20.com/ipl/teamlogos/GT.png',
  'lsg':  'https://scores.iplt20.com/ipl/teamlogos/LSG.png',
  // Full names (fallback)
  'mumbai indians':               'https://scores.iplt20.com/ipl/teamlogos/MI.png',
  'chennai super kings':          'https://scores.iplt20.com/ipl/teamlogos/CSK.png',
  'royal challengers bangalore':  'https://scores.iplt20.com/ipl/teamlogos/RCB.png',
  'royal challengers bengaluru':  'https://scores.iplt20.com/ipl/teamlogos/RCB.png',
  'kolkata knight riders':        'https://scores.iplt20.com/ipl/teamlogos/KKR.png',
  'sunrisers hyderabad':          'https://scores.iplt20.com/ipl/teamlogos/SRH.png',
  'delhi capitals':               'https://scores.iplt20.com/ipl/teamlogos/DC.png',
  'punjab kings':                 'https://scores.iplt20.com/ipl/teamlogos/PBKS.png',
  'rajasthan royals':             'https://scores.iplt20.com/ipl/teamlogos/RR.png',
  'gujarat titans':               'https://scores.iplt20.com/ipl/teamlogos/GT.png',
  'lucknow super giants':         'https://scores.iplt20.com/ipl/teamlogos/LSG.png',
};

function getTeamLogo(teamName: string): string | null {
  return TEAM_LOGO_MAP[teamName.trim().toLowerCase()] ?? null;
}

// ─── Admin: Sync team logos for all matches ───────────────────────────────────
export async function syncTeamLogos(_req: Request, res: Response): Promise<void> {
  try {
    const matches = await prisma.iplMatch.findMany({
      select: { id: true, team1: true, team2: true },
    });

    let updated = 0;
    let skipped = 0;

    for (const m of matches) {
      const logo1 = getTeamLogo(m.team1);
      const logo2 = getTeamLogo(m.team2);

      if (logo1 || logo2) {
        await prisma.iplMatch.update({
          where: { id: m.id },
          data: {
            team1Logo: logo1 ?? undefined,
            team2Logo: logo2 ?? undefined,
          },
        });
        updated++;
      } else {
        skipped++;
      }
    }

    success(res, { total: matches.length, updated, skipped },
      `Team logos synced: ${updated} updated, ${skipped} skipped`);
  } catch (err) {
    logger.error('syncTeamLogos error:', err);
    error(res, 'Failed to sync team logos', 500);
  }
}
