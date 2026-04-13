import { Request, Response } from 'express';
import { TransactionType } from '@prisma/client';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import { creditCoins } from '../services/coinService';
import { getTodayIPLMatches } from '../services/cricApiService';
import { sendFCMToUsers } from '../services/fcmService';

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
    botCount,
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
    maxEntriesPerUser?: number; botCount?: number;
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
      botCount: botCount ?? 0,
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

  // If contest is already published and botCount was updated, sync bot entries
  if (contest.status === 'published' && contest.botCount > 0) {
    try {
      const existingBotEntries = await prisma.iplContestEntry.findMany({
        where: { contestId },
        include: { user: { select: { isBot: true } } },
      });
      const existingBotCount = existingBotEntries.filter((e: any) => e.user?.isBot).length;
      const needed = contest.botCount - existingBotCount;

      if (needed > 0) {
        const existingBotIds = existingBotEntries.filter((e: any) => e.user?.isBot).map((e: any) => e.userId);
        const bots = await prisma.user.findMany({
          where: { isBot: true, id: { notIn: existingBotIds } },
          select: { id: true },
          take: needed,
          orderBy: { updatedAt: 'asc' },
        });
        if (bots.length > 0) {
          await prisma.iplContestEntry.createMany({
            data: bots.map((b: { id: string }) => ({
              contestId,
              userId: b.id,
              matchId: contest.matchId,
              coinsDeducted: 0,
              totalPoints: 0,
              status: 'active',
            })),
            skipDuplicates: true,
          });
          await prisma.user.updateMany({
            where: { id: { in: bots.map((b: { id: string }) => b.id) } },
            data: { updatedAt: new Date() },
          });
          logger.info(`Bot sync on update: added ${bots.length} bots to contest ${contestId}`);
        }
      }
    } catch (botErr) {
      logger.warn('Bot sync on update failed:', botErr);
    }
  }

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

  // Auto-join bots if contest has botCount > 0
  let botsJoined = 0;
  if (contest.botCount > 0) {
    try {
      const bots = await prisma.user.findMany({
        where: { isBot: true },
        select: { id: true },
        take: contest.botCount,
        orderBy: { updatedAt: 'asc' }, // least-recently-used first
      });

      if (bots.length > 0) {
        await prisma.iplContestEntry.createMany({
          data: bots.map(b => ({
            contestId,
            userId: b.id,
            matchId: contest.matchId,
            coinsDeducted: 0,
            totalPoints: 0,
            status: 'active',
          })),
          skipDuplicates: true,
        });
        await prisma.user.updateMany({
          where: { id: { in: bots.map(b => b.id) } },
          data: { updatedAt: new Date() },
        });
        botsJoined = bots.length;
      }
    } catch (botErr) {
      logger.warn('Failed to add bots to contest:', botErr);
    }
  }

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

  logger.info(`IPL contest published: ${contest.name} (${contestId}), ${botsJoined} bots joined`);
  success(res, contest, `🚀 Contest published! ${botsJoined > 0 ? `${botsJoined} bots joined. ` : ''}Users notified.`);
}

// ─── Process results for a specific contest ────────────────────────────────────
interface PrizeTier {
  rank?: number;
  rankFrom?: number;
  rankTo?: number;
  type: 'gift' | 'coins' | 'COINS' | 'INVENTORY' | 'XOXODAY';
  name?: string;
  imageUrl?: string;
  value?: number;
  coins?: number;
  tickets?: number;
  inventoryId?: string;
  inventoryItemId?: string;
}

// ─── Core prize distribution logic (reusable) ────────────────────────────────
export async function distributeIPLContestPrizes(contestId: string, notifyOnComplete = true): Promise<{
  contestName: string;
  totalParticipants: number;
  botsCount: number;
  coinsDistributed: number;
  giftClaimsCreated: number;
  rankings: any[];
}> {
  const contest = await prisma.iplContest.findUnique({
    where: { id: contestId },
    include: {
      entries: { include: { user: { select: { isBot: true } } } },
      match: true,
    },
  });

  if (!contest) throw new Error(`Contest not found: ${contestId}`);
  if (contest.status === 'completed') {
    logger.info(`Contest ${contestId} already processed — skipping`);
    return { contestName: contest.name, totalParticipants: 0, botsCount: 0, coinsDistributed: 0, giftClaimsCreated: 0, rankings: [] };
  }

  const entryUserIds = contest.entries.map(e => e.userId);
  const botUserIds = new Set(contest.entries.filter(e => (e as any).user?.isBot).map(e => e.userId));

  const [predictions, questions] = await Promise.all([
    prisma.iplPrediction.findMany({
      where: { matchId: contest.matchId, userId: { in: entryUserIds } },
    }),
    prisma.iplQuestion.findMany({ where: { matchId: contest.matchId } }),
  ]);

  // ── Score all participants ─────────────────────────────────────────────────
  const userScores: Record<string, number> = {};

  // Step 1: Score real users from their actual predictions
  for (const entry of contest.entries) {
    if (!botUserIds.has(entry.userId)) {
      userScores[entry.userId] = 0;
    }
  }
  for (const pred of predictions) {
    if (botUserIds.has(pred.userId)) continue; // skip bots
    const question = questions.find(q => q.id === pred.questionId);
    if (!question?.correctAnswer) continue;
    if (pred.answer === question.correctAnswer) {
      userScores[pred.userId] = (userScores[pred.userId] ?? 0) + question.points;
    }
  }

  // Step 2: Score bots ABOVE the highest real user score so they always win
  const highestRealScore = Math.max(0, ...Object.values(userScores));
  const baseForBots = Math.max(
    highestRealScore,
    questions.reduce((s, q) => s + q.points, 0) * 0.7, // at least 70% of total possible
    (contest.questionCount || 10) * 100,                // fallback minimum
  );
  const botIds = [...botUserIds];
  for (let i = 0; i < botIds.length; i++) {
    // Each bot gets a slightly different score so they have distinct ranks
    // Bot 0 = highest, Bot 1 = slightly lower, etc.
    const gap = (i + 1) * 50;
    userScores[botIds[i]] = baseForBots + (botIds.length - i) * 100 - gap;
  }

  // ── Global ranking (bots + real) ──────────────────────────────────────────
  const sortedEntries = Object.entries(userScores).sort(([, a], [, b]) => b - a);
  const allRankings: { userId: string; score: number; displayRank: number }[] = [];
  let pos = 0;
  while (pos < sortedEntries.length) {
    const tieScore = sortedEntries[pos][1];
    let end = pos;
    while (end < sortedEntries.length && sortedEntries[end][1] === tieScore) end++;
    const sharedRank = pos + 1;
    for (let k = pos; k < end; k++) {
      allRankings.push({ userId: sortedEntries[k][0], score: tieScore, displayRank: sharedRank });
    }
    pos = end;
  }

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
  const { creditTickets } = await import('../services/ticket.service');

  const findTier = (r: number) => prizeTiers.find(t => {
    const lo = t.rankFrom ?? t.rank;
    const hi = t.rankTo ?? t.rank;
    if (lo !== undefined && hi !== undefined) return r >= lo && r <= hi;
    return false;
  });

  // ── Distribute prizes by actual (display) rank — bots + real users ranked together ──
  // Bots occupy their earned ranks (consuming those prize tiers) but receive no actual rewards.
  // Real users get the prize for their actual display rank.
  for (const { userId, score, displayRank } of allRankings) {
    const isBot = botUserIds.has(userId);
    let coinsAward = 0;
    let ticketsAward = 0;
    let giftTier: PrizeTier | undefined;

    if (!isBot) {
      // Determine what prize this display rank earns
      if (hasPrizeTiers) {
        const tier = findTier(displayRank);
        if (tier) {
          const tType = (tier.type ?? '').toUpperCase();
          if (tType === 'TICKETS') {
            ticketsAward = tier.tickets ?? 0;
          } else if (tType === 'GIFT' || tType === 'INVENTORY' || tType === 'XOXODAY') {
            giftTier = tier;
          } else {
            coinsAward = tier.coins ?? 0;
          }
        }
      } else if (contest.prizeType === 'COINS' && contest.prizeCoins && displayRank === 1) {
        coinsAward = contest.prizeCoins;
      } else {
        if (displayRank === 1)       coinsAward = Math.floor(prizePool * (dist['1']    ?? 40) / 100);
        else if (displayRank === 2)  coinsAward = Math.floor(prizePool * (dist['2']    ?? 25) / 100);
        else if (displayRank === 3)  coinsAward = Math.floor(prizePool * (dist['3']    ?? 15) / 100);
        else if (displayRank <= 10)  coinsAward = Math.floor(prizePool * (dist['4-10'] ?? 20) / 100 / 7);
      }
    }

    if (coinsAward > 0) {
      await creditCoins(userId, coinsAward, TransactionType.EARN_IPL_WIN, contestId,
        `IPL Contest Win — ${contest.name} — Rank #${displayRank}`);
      coinsDistributed += coinsAward;
    }

    if (ticketsAward > 0) {
      try {
        await creditTickets(userId, ticketsAward, 'ipl_contest_win',
          `IPL Contest Win — ${contest.name} — Rank #${displayRank}`, contestId);
      } catch (ticketErr) {
        logger.error('Failed to credit IPL contest tickets', { userId, displayRank, ticketsAward, ticketErr });
      }
    }

    if (giftTier) {
      // Idempotent: only create one claim per user per contest
      const existing = await prisma.iplPrizeClaim.findFirst({ where: { userId, iplContestId: contestId } });
      if (!existing) {
        const tierTypeRaw = (giftTier.type ?? '').toUpperCase();
        const claimPrizeType = tierTypeRaw === 'XOXODAY' ? 'XOXODAY' : 'INVENTORY';
        const itemCategory = (giftTier as any).itemCategory || '';
        // For XOXODAY tiers, store product/denomination so backend can auto-deliver on verify
        const xoxodayMeta: Record<string, string> = {};
        if (claimPrizeType === 'XOXODAY') {
          if ((giftTier as any).xoxodayProductId)  xoxodayMeta._xoxodayProductId  = String((giftTier as any).xoxodayProductId);
          if ((giftTier as any).denominationId)     xoxodayMeta._denominationId    = String((giftTier as any).denominationId);
          if ((giftTier as any).denominationValue)  xoxodayMeta._denominationValue = String((giftTier as any).denominationValue);
          if ((giftTier as any).productName)        xoxodayMeta._productName       = String((giftTier as any).productName);
        }
        const initialDeliveryDetails = {
          ...(itemCategory ? { _itemCategory: itemCategory } : {}),
          ...xoxodayMeta,
        };
        await prisma.iplPrizeClaim.create({
          data: {
            userId,
            iplContestId: contestId,
            rank: displayRank,            // display rank — same as entry.rank
            prizeType: claimPrizeType,
            prizeName: (giftTier as any).itemName || giftTier.name || (giftTier as any).productName || 'Gift Prize',
            prizeValue: (giftTier as any).denominationValue ?? giftTier.value ?? 0,
            prizeImageUrl: (giftTier as any).itemImage || giftTier.imageUrl || '',
            inventoryId: giftTier.inventoryId || giftTier.inventoryItemId || null,
            status: 'pending',
            deliveryDetails: Object.keys(initialDeliveryDetails).length > 0 ? initialDeliveryDetails : undefined,
          },
        });
        giftClaimsCreated++;
      }
    }

    // Store rank and score for everyone (bots + real)
    await prisma.iplContestEntry.updateMany({
      where: { contestId, userId },
      data: { rank: displayRank, coinsWon: coinsAward, totalPoints: score },
    });

    // Notify real winners only (when called from per-contest endpoint)
    if (!isBot && notifyOnComplete) {
      let notifTitle = '';
      let notifBody = '';
      const rankLabel = `Rank #${displayRank}`;
      if (giftTier) {
        const prizeName = (giftTier as any).itemName || giftTier.name || 'a gift prize';
        notifTitle = `🏆 You won ${prizeName}!`;
        notifBody = `Congratulations! You finished ${rankLabel} in ${contest.name}. Tap to claim your prize!`;
      } else if (coinsAward > 0) {
        notifTitle = `🎉 You won ${coinsAward} coins!`;
        notifBody = `You finished ${rankLabel} in ${contest.name}. Your winnings have been credited!`;
      } else if (ticketsAward > 0) {
        notifTitle = `🎟️ You won ${ticketsAward} ticket${ticketsAward > 1 ? 's' : ''}!`;
        notifBody = `You finished ${rankLabel} in ${contest.name}. Your tickets have been credited!`;
      }
      if (notifTitle) {
        sendFCMToUsers([userId], notifTitle, notifBody, {
          type: 'contest_win',
          contestId,
          rank: String(displayRank),
        }).catch(e => logger.error('Contest win FCM error:', e));
      }
    }
  }

  await prisma.iplContest.update({ where: { id: contestId }, data: { status: 'completed' } });

  const realParticipants = contest.entries.length - botUserIds.size;
  logger.info(`IPL contest processed: ${contest.name} — ${allRankings.length} total (${botUserIds.size} bots), ${coinsDistributed} coins, ${giftClaimsCreated} gift claims`);

  return {
    contestName: contest.name,
    totalParticipants: realParticipants,
    botsCount: botUserIds.size,
    coinsDistributed,
    giftClaimsCreated,
    rankings: allRankings
      .filter(r => !botUserIds.has(r.userId))
      .slice(0, 10)
      .map(r => ({ userId: r.userId, score: r.score, rank: r.displayRank })),
  };
}

// ─── Fix bot scores for already-completed contests ────────────────────────────
export async function fixBotScores(req: Request, res: Response): Promise<void> {
  const { contestId } = req.params as { contestId: string };
  try {
    const contest = await prisma.iplContest.findUnique({
      where: { id: contestId },
      include: { entries: { include: { user: { select: { id: true, name: true, isBot: true } } } }, match: true },
    });
    if (!contest) { error(res, 'Contest not found', 404); return; }

    const botEntries = contest.entries.filter((e: any) => e.user?.isBot);
    if (botEntries.length === 0) { error(res, 'No bot entries in this contest', 400); return; }

    const entryUserIds = contest.entries.map(e => e.userId);
    const botUserIds = new Set(botEntries.map(e => e.userId));

    const [predictions, questions] = await Promise.all([
      prisma.iplPrediction.findMany({ where: { matchId: contest.matchId, userId: { in: entryUserIds } } }),
      prisma.iplQuestion.findMany({ where: { matchId: contest.matchId } }),
    ]);

    // Compute real user scores
    const realScores: Record<string, number> = {};
    for (const entry of contest.entries) {
      if (!botUserIds.has(entry.userId)) realScores[entry.userId] = 0;
    }
    for (const pred of predictions) {
      if (botUserIds.has(pred.userId)) continue;
      const q = questions.find(q => q.id === pred.questionId);
      if (q?.correctAnswer && pred.answer === q.correctAnswer) {
        realScores[pred.userId] = (realScores[pred.userId] ?? 0) + q.points;
      }
    }

    const highestRealScore = Math.max(0, ...Object.values(realScores));
    const baseForBots = Math.max(
      highestRealScore,
      questions.reduce((s, q) => s + q.points, 0) * 0.7,
      (contest.questionCount || 10) * 100,
    );

    const botIds = [...botUserIds];
    const updates = [];
    for (let i = 0; i < botIds.length; i++) {
      const botScore = baseForBots + (botIds.length - i) * 100 - (i + 1) * 50;
      updates.push(prisma.iplContestEntry.updateMany({
        where: { contestId, userId: botIds[i] },
        data: { totalPoints: botScore },
      }));
    }
    await Promise.all(updates);

    // Re-rank everyone
    const allEntries = await prisma.iplContestEntry.findMany({ where: { contestId }, orderBy: { totalPoints: 'desc' } });
    for (let i = 0; i < allEntries.length; i++) {
      await prisma.iplContestEntry.update({
        where: { id: allEntries[i].id },
        data: { rank: i + 1 },
      });
    }

    success(res, {
      botsFixed: botIds.length,
      highestRealScore,
      botScores: botIds.map((id, i) => ({
        name: botEntries.find(e => e.userId === id)?.user?.name,
        score: baseForBots + (botIds.length - i) * 100 - (i + 1) * 50,
      })),
    }, `Fixed ${botIds.length} bot scores. Bots now rank above real users.`);
  } catch (err) {
    logger.error('fixBotScores error:', err);
    error(res, 'Failed to fix bot scores', 500);
  }
}

// ─── HTTP handler — POST /api/admin/ipl/contests/:contestId/process ───────────
export async function processIPLContestResults(req: Request, res: Response): Promise<void> {
  const { contestId } = req.params as { contestId: string };
  try {
    const result = await distributeIPLContestPrizes(contestId);
    success(res, result, 'Results processed! Prizes distributed to winners.');
  } catch (err: any) {
    if (err.message?.includes('already processed')) {
      error(res, 'Contest already processed', 400);
    } else if (err.message?.includes('not found')) {
      error(res, 'Contest not found', 404);
    } else {
      logger.error('processIPLContestResults error:', err);
      error(res, 'Failed to process contest results', 500);
    }
  }
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

// ─── Bot Management ───────────────────────────────────────────────────────────
// Combine first + last names for ~3,600 unique combinations
const BOT_FIRST_NAMES = [
  'Aarav', 'Aditya', 'Akash', 'Amit', 'Ananya', 'Ankita', 'Anjali', 'Arjun', 'Ayesha',
  'Bhavna', 'Chirag', 'Deepika', 'Dhruv', 'Divya', 'Gaurav', 'Hardik', 'Ishaan',
  'Karthik', 'Kavitha', 'Kavya', 'Kunal', 'Lakshmi', 'Manav', 'Meera', 'Mohan',
  'Nandini', 'Neha', 'Nikhil', 'Nisha', 'Pooja', 'Pratik', 'Preeti', 'Priya',
  'Rahul', 'Ravi', 'Ritika', 'Rohan', 'Santosh', 'Shreya', 'Shubham', 'Siddharth',
  'Simran', 'Sneha', 'Sonali', 'Suresh', 'Swati', 'Tanvi', 'Tejas', 'Varun', 'Vikram',
  'Vishal', 'Vivek', 'Yash', 'Zara', 'Abhinav', 'Aditi', 'Alok', 'Amrita', 'Ashish',
  'Bharat', 'Chetna', 'Dilip', 'Farhan', 'Girish', 'Harish', 'Jatin', 'Kriti', 'Lokesh',
  'Mahesh', 'Namrata', 'Omkar', 'Pallavi', 'Rajesh', 'Sanjay', 'Tanya', 'Uday', 'Vijay',
];

const BOT_LAST_NAMES = [
  'Agarwal', 'Banerjee', 'Bhatt', 'Bose', 'Chauhan', 'Chawla', 'Choudhury', 'Desai',
  'Dhaliwal', 'Dubey', 'Goyal', 'Gupta', 'Hegde', 'Iyer', 'Jha', 'Joshi', 'Kulkarni',
  'Kumar', 'Malhotra', 'Mehta', 'Mishra', 'Nair', 'Nambiar', 'Pandey', 'Parikh',
  'Patel', 'Pillai', 'Rao', 'Rastogi', 'Reddy', 'Saxena', 'Shah', 'Sharma', 'Singh',
  'Soni', 'Srivastava', 'Subramaniam', 'Tiwari', 'Tomar', 'Trivedi', 'Verma',
  'Krishnan', 'Lal', 'Bhat', 'Kaur', 'Dixit', 'Kapoor', 'Khanna', 'Bajaj', 'Mehra',
];

export async function getBotUsers(_req: Request, res: Response): Promise<void> {
  const bots = await prisma.user.findMany({
    where: { isBot: true },
    select: { id: true, name: true, phone: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  success(res, { bots, count: bots.length });
}

export async function createBotUsers(req: Request, res: Response): Promise<void> {
  const { count = 20 } = req.body as { count?: number };
  const n = Math.min(200, Math.max(1, Number(count)));

  const existingCount = await prisma.user.count({ where: { isBot: true } });
  const created = [];

  for (let i = 0; i < n; i++) {
    const idx = existingCount + i + 1;
    const first = BOT_FIRST_NAMES[Math.floor(Math.random() * BOT_FIRST_NAMES.length)];
    const last = BOT_LAST_NAMES[Math.floor(Math.random() * BOT_LAST_NAMES.length)];
    const name = `${first} ${last}`;
    const phone = `99${String(idx).padStart(9, '0')}`;
    const referralCode = `BOT${String(idx).padStart(6, '0')}`;

    try {
      const bot = await prisma.user.create({
        data: { name, phone, isBot: true, referralCode, coinBalance: 0, ticketBalance: 999, language: 'en', status: 'ACTIVE' },
      });
      created.push(bot);
    } catch {
      // skip duplicates
    }
  }

  success(res, { created: created.length }, `${created.length} bot users created`);
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

  // Step 3: Process each contest for this match using distributeIPLContestPrizes
  // This properly handles bots: bots are ranked above the highest real user automatically.
  const contestsToProcess = await prisma.iplContest.findMany({
    where: { matchId, status: { in: ['published', 'live'] } },
    select: { id: true },
  });

  let totalCoinsDistributed = 0;
  let totalWinners = 0;

  for (const c of contestsToProcess) {
    try {
      // notifyOnComplete=false: we send one consolidated notification in Step 4 below
      const result = await distributeIPLContestPrizes(c.id, false);
      totalCoinsDistributed += result.coinsDistributed;
      totalWinners += result.rankings.filter((r: any) => (r.coinsWon ?? 0) > 0).length;
    } catch (err: any) {
      logger.warn(`distributeIPLContestPrizes failed for contest ${c.id}: ${err.message}`);
    }
  }

  // Re-fetch contests with updated entries (now containing displayRank) for notifications
  const contests = await prisma.iplContest.findMany({
    where: { matchId },
    include: { entries: { include: { user: { select: { isBot: true } } } } },
  });

  await prisma.iplMatch.update({
    where: { id: matchId },
    data: { contestStatus: 'completed' },
  });

  // Step 4: Send personalized push + in-app notifications to all participants
  try {
    const match = await prisma.iplMatch.findUnique({ where: { id: matchId } });
    const { sendBulkNotification } = await import('../services/notificationService');

    // Build best rank + coins per REAL user across all contests in this match (skip bots)
    const bestRank: Record<string, number> = {};
    const coinsWon: Record<string, number> = {};
    for (const contest of contests) {
      for (const entry of (contest.entries as any[])) {
        if (entry.user?.isBot) continue;  // bots don't get result notifications
        const rank = entry.rank ?? 999;
        if (bestRank[entry.userId] === undefined || rank < bestRank[entry.userId]) {
          bestRank[entry.userId] = rank;
        }
        coinsWon[entry.userId] = (coinsWon[entry.userId] ?? 0) + (entry.coinsWon ?? 0);
      }
    }

    if (match) {
      const matchLabel = `${match.team1} vs ${match.team2}`;

      // Group users: rank 1 (champion), rank 2-3 (podium), rank 4-10 (winners), rest (participants)
      const rank1Users:    string[] = [];
      const podiumUsers:   string[] = [];
      const winnerUsers:   string[] = [];
      const otherUsers:    string[] = [];

      for (const [userId, rank] of Object.entries(bestRank)) {
        if (rank === 1)         rank1Users.push(userId);
        else if (rank <= 3)     podiumUsers.push(userId);
        else if (rank <= 10)    winnerUsers.push(userId);
        else                    otherUsers.push(userId);
      }

      // 🥇 Rank 1
      if (rank1Users.length > 0) {
        await sendBulkNotification(
          rank1Users,
          `🏆 You're the CHAMPION! ${matchLabel}`,
          `🥇 Rank #1 — ${(coinsWon[rank1Users[0]] ?? 0).toLocaleString()} coins credited! Collect your prize.`,
          'IPL_RESULT',
        );
      }
      // 🥈🥉 Rank 2-3
      for (const userId of podiumUsers) {
        await sendBulkNotification(
          [userId],
          `🎉 Podium Finish! ${matchLabel}`,
          `🏅 Rank #${bestRank[userId]} — ${(coinsWon[userId] ?? 0).toLocaleString()} coins credited to your wallet!`,
          'IPL_RESULT',
        );
      }
      // Top 10 winners
      if (winnerUsers.length > 0) {
        await sendBulkNotification(
          winnerUsers,
          `🎊 You Won! ${matchLabel}`,
          `You finished in the Top 10! Coins credited. Tap to see your results.`,
          'IPL_RESULT',
        );
      }
      // Everyone else — just the result
      if (otherUsers.length > 0) {
        await sendBulkNotification(
          otherUsers,
          `🏏 Match Result: ${matchLabel}`,
          `${winner} won the match! Check your rank & leaderboard in the app.`,
          'IPL_RESULT',
        );
      }

      logger.info(`processIPLResults: notifications — rank1=${rank1Users.length}, podium=${podiumUsers.length}, winners=${winnerUsers.length}, others=${otherUsers.length}`);
    }
  } catch (notifErr) {
    logger.warn('Result notification failed (non-critical):', notifErr);
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
const generationLocks = new Set<string>(); // matchId lock to prevent double generation

export async function generateIPLQuestions(req: Request, res: Response): Promise<void> {
  const { matchId, questionCount, language } = req.body as {
    matchId?: string;
    questionCount?: number;
    language?: string; // specific lang code OR 'all'/undefined = all 7 languages
  };

  if (!matchId) { error(res, 'matchId required', 400); return; }

  // Decide which languages to generate for
  const targetLanguages = (!language || language === 'all') ? ALL_LANGUAGES : [language];
  const isAllLangs = targetLanguages.length > 1;

  // Lock per scope: all-languages lock vs single-language lock
  const lockKey = isAllLangs ? `${matchId}:all` : `${matchId}:${language}`;

  if (generationLocks.has(lockKey)) {
    success(res, { status: 'already_running', matchId }, 'Generation already in progress. Please wait.');
    return;
  }

  const match = await prisma.iplMatch.findUnique({ where: { id: matchId } });
  if (!match) { error(res, 'Match not found', 404); return; }

  // count = questions per language (so 5 English = 5 questions; 5 all-langs = 5×7=35)
  const count = Math.max(1, Math.min(50, questionCount || 10));
  const { generateQuestionsWithContext } = await import('../services/claudeAiService');

  const matchBase = {
    team1: match.team1, team2: match.team2,
    date: match.matchDate.toDateString(), venue: match.venue ?? 'TBD',
    team1Players: Array.isArray(match.team1Players) ? match.team1Players as string[] : undefined,
    team2Players: Array.isArray(match.team2Players) ? match.team2Players as string[] : undefined,
    questionCount: count,
  };

  // Respond immediately
  success(res, { status: 'generating', matchId, languages: targetLanguages, countPerLang: count },
    `Generation started for ${targetLanguages.length} language(s), ${count} questions each.`);

  generationLocks.add(lockKey);

  (async () => {
    try {
      // Delete existing auto-generated questions for target language(s) that have no predictions
      const deleteFilter: any = { matchId: match.id, isAutoGenerated: true };
      if (!isAllLangs) deleteFilter.language = language; // only clear the specific language

      const existingQuestions = await prisma.iplQuestion.findMany({
        where: deleteFilter,
        select: { id: true },
      });
      if (existingQuestions.length > 0) {
        const existingIds = existingQuestions.map(q => q.id);
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

      logger.info(`Generating ${count} questions × ${targetLanguages.length} language(s) for match ${match.id}`);

      let totalCreated = 0;
      for (const lang of targetLanguages) {
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

      await prisma.iplMatch.update({ where: { id: matchId }, data: { questionsGenerated: true } });
      logger.info(`✅ Generation complete: ${totalCreated} questions created for match ${match.id}`);
    } catch (err) {
      logger.error('Background question generation failed:', err);
    } finally {
      generationLocks.delete(lockKey);
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
