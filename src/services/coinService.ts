import { TransactionType } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

export async function creditCoins(
  userId: string,
  amount: number,
  type: TransactionType,
  refId?: string,
  description?: string
): Promise<void> {
  if (amount <= 0) throw new Error('Amount must be positive');

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { coinBalance: { increment: amount } },
    }),
    prisma.transaction.create({
      data: { userId, type, amount, refId, description, status: 'completed' },
    }),
  ]);

  logger.debug('Coins credited', { userId, amount, type });
}

export async function debitCoins(
  userId: string,
  amount: number,
  type: TransactionType,
  refId?: string,
  description?: string
): Promise<void> {
  if (amount <= 0) throw new Error('Amount must be positive');

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { coinBalance: true } });
  if (!user) throw new Error('User not found');
  if (user.coinBalance < amount) throw new Error('Insufficient coin balance');

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { coinBalance: { decrement: amount } },
    }),
    prisma.transaction.create({
      data: { userId, type, amount: -amount, refId, description, status: 'completed' },
    }),
  ]);

  logger.debug('Coins debited', { userId, amount, type });
}

export async function escrowCoins(
  userId: string,
  amount: number,
  contestId: string
): Promise<void> {
  if (amount <= 0) throw new Error('Amount must be positive');

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { coinBalance: true } });
  if (!user) throw new Error('User not found');
  if (user.coinBalance < amount) throw new Error('Insufficient coin balance');

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { coinBalance: { decrement: amount } },
    }),
    prisma.participant.update({
      where: { contestId_userId: { contestId, userId } },
      data: { coinsEscrowed: { increment: amount } },
    }),
    prisma.transaction.create({
      data: {
        userId,
        type: TransactionType.SPEND_CONTEST_ENTRY,
        amount: -amount,
        refId: contestId,
        description: 'Contest entry fee',
        status: 'completed',
      },
    }),
  ]);
}

export async function refundEscrow(contestId: string): Promise<void> {
  const participants = await prisma.participant.findMany({
    where: { contestId, coinsEscrowed: { gt: 0 } },
  });

  await prisma.$transaction(
    participants.flatMap((p) => [
      prisma.user.update({
        where: { id: p.userId },
        data: { coinBalance: { increment: p.coinsEscrowed } },
      }),
      prisma.transaction.create({
        data: {
          userId: p.userId,
          type: TransactionType.REFUND,
          amount: p.coinsEscrowed,
          refId: contestId,
          description: 'Contest cancelled — refund',
          status: 'completed',
        },
      }),
      prisma.participant.update({
        where: { id: p.id },
        data: { coinsEscrowed: 0 },
      }),
    ])
  );

  logger.info('Escrow refunded', { contestId, count: participants.length });
}

// Assign ranks with tie support. Players with equal scores share the same rank.
// The prize for tied players = floor(sum of prizes for the covered ranks / tie count).
// Tiebreaker: among equal scores, whoever achieved the score first (lastScoreAt ASC) is ordered first
// but still shares the same rank as the others with the same score.
export async function awardPrizes(contestId: string): Promise<void> {
  const contest = await prisma.contest.findUnique({
    where: { id: contestId },
    include: {
      participants: {
        orderBy: [
          { score: 'desc' },
          { lastScoreAt: 'asc' },   // tiebreaker: fastest scorer first
        ],
      },
    },
  });

  if (!contest) throw new Error('Contest not found');

  const distribution = contest.prizeDistribution as Record<string, number>;
  const ticketDistribution = (contest.ticketPrizeDistribution ?? {}) as Record<string, number>;

  // ── Assign ranks with tie grouping ────────────────────────────────────────
  // participants is already sorted: score DESC, lastScoreAt ASC
  const ranked: { p: typeof contest.participants[0]; rank: number; coins: number; tickets: number }[] = [];
  let i = 0;
  while (i < contest.participants.length) {
    // Find the tie group: all players with the same score
    const tieScore = contest.participants[i].score;
    let j = i;
    while (j < contest.participants.length && contest.participants[j].score === tieScore) j++;

    const tieSize = j - i;          // number of tied players
    const rankStart = i + 1;        // lowest rank in the group (1-indexed)
    const rankEnd = j;              // highest rank in the group

    // Sum coin prizes for ranks rankStart..rankEnd, split equally (floored)
    let coinSum = 0;
    let ticketSum = 0;
    for (let r = rankStart; r <= rankEnd; r++) {
      coinSum += distribution[String(r)] ?? 0;
      ticketSum += ticketDistribution[String(r)] ?? 0;
    }
    const coinsEach = Math.floor(coinSum / tieSize);
    const ticketsEach = Math.floor(ticketSum / tieSize);

    for (let k = i; k < j; k++) {
      ranked.push({
        p: contest.participants[k],
        rank: rankStart,            // all tied players get the SAME rank
        coins: coinsEach,
        tickets: ticketsEach,
      });
    }

    i = j;
  }

  // ── Build DB operations ────────────────────────────────────────────────────
  const updates: ReturnType<typeof prisma.participant.update>[] = [];
  const txns: ReturnType<typeof prisma.transaction.create>[] = [];
  const coinUpdates: ReturnType<typeof prisma.user.update>[] = [];

  for (const { p, rank, coins } of ranked) {
    updates.push(prisma.participant.update({
      where: { id: p.id },
      data: { rank },
    }));

    if (coins > 0) {
      txns.push(prisma.transaction.create({
        data: {
          userId: p.userId,
          type: TransactionType.EARN_CONTEST_WIN,
          amount: coins,
          refId: contestId,
          description: `Contest win — rank ${rank}`,
          status: 'completed',
        },
      }));
      coinUpdates.push(prisma.user.update({
        where: { id: p.userId },
        data: { coinBalance: { increment: coins } },
      }));
    }
  }

  await prisma.$transaction([...updates, ...txns, ...coinUpdates]);

  // ── Credit tickets (outside main tx — has its own audit log) ──────────────
  const { creditTickets } = await import('./ticket.service');
  for (const { p, rank, tickets } of ranked) {
    if (tickets > 0) {
      try {
        await creditTickets(p.userId, tickets, 'contest_win', `Contest win — rank ${rank}`, contestId);
      } catch (err) {
        logger.error('Failed to credit ticket prize', { contestId, userId: p.userId, rank, tickets, err });
      }
    }
  }

  logger.info('Prizes awarded', { contestId, players: ranked.length });
}

export async function getBalance(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { coinBalance: true },
  });
  return user?.coinBalance ?? 0;
}

export async function getLedger(
  userId: string,
  type?: TransactionType,
  limit = 20,
  page = 1
): Promise<{ transactions: unknown[]; total: number }> {
  const skip = (page - 1) * limit;
  const where = { userId, ...(type && { type }) };

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.transaction.count({ where }),
  ]);

  // Enrich REDEEM transactions with voucher details from RedemptionRequest (linked via refId)
  const redeemRefIds = transactions
    .filter(tx => tx.type.toString().toUpperCase().includes('REDEEM') && tx.refId)
    .map(tx => tx.refId as string);

  let redemptionMap: Record<string, any> = {};
  if (redeemRefIds.length > 0) {
    const redemptions = await prisma.redemptionRequest.findMany({
      where: { id: { in: redeemRefIds } },
      select: {
        id: true,
        voucherCode: true,
        voucherLink: true,
        productName: true,
        customFieldValues: true,
        status: true,
        failureReason: true,
        redeemUrl: true,
        amountInr: true,
        type: true,
        mobileNumber: true,
        operator: true,
        gamePlayerId: true,
        upiId: true,
        accountNumber: true,
      },
    });
    redemptionMap = Object.fromEntries(redemptions.map(r => [r.id, r]));
  }

  const enriched = transactions.map(tx => {
    if (!tx.type.toString().toUpperCase().includes('REDEEM') || !tx.refId) return tx;
    const r = redemptionMap[tx.refId];
    if (!r) return tx;

    const cfv = (r.customFieldValues as any) || {};
    // Only expose voucherLink / redeemUrl when there is no direct code
    const hasCode = !!r.voucherCode;
    return {
      ...tx,
      voucherCode:        r.voucherCode        || undefined,
      voucherPin:         cfv.pin              || undefined,
      voucherValidity:    cfv.validity         || undefined,
      voucherLink:        !hasCode ? (r.voucherLink || undefined) : undefined,
      redeemUrl:          !hasCode ? (r.redeemUrl  || undefined) : undefined,
      productName:        r.productName        || undefined,
      redemptionStatus:   r.status             || undefined,
      failureReason:      r.failureReason      || undefined,
      amountInr:          r.amountInr          || undefined,
      redemptionType:     r.type               || undefined,
      mobileNumber:       r.mobileNumber       || undefined,
      operator:           r.operator           || undefined,
      gamePlayerId:       r.gamePlayerId        || undefined,
      upiId:              r.upiId              || undefined,
      accountNumber:      r.accountNumber      || undefined,
      redemptionId:       r.id,
    };
  });

  return { transactions: enriched, total };
}
