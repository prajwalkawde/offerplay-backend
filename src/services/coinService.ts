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

export async function awardPrizes(contestId: string): Promise<void> {
  const contest = await prisma.contest.findUnique({
    where: { id: contestId },
    include: { participants: { orderBy: { score: 'desc' } } },
  });

  if (!contest) throw new Error('Contest not found');

  const distribution = contest.prizeDistribution as Record<string, number>;
  const txns: ReturnType<typeof prisma.transaction.create>[] = [];
  const updates: ReturnType<typeof prisma.participant.update>[] = [];

  contest.participants.forEach((p, idx) => {
    const rank = idx + 1;
    const prizeCoins = distribution[String(rank)] ?? 0;

    updates.push(
      prisma.participant.update({
        where: { id: p.id },
        data: { rank },
      })
    );

    if (prizeCoins > 0) {
      txns.push(
        prisma.transaction.create({
          data: {
            userId: p.userId,
            type: TransactionType.EARN_CONTEST_WIN,
            amount: prizeCoins,
            refId: contestId,
            description: `Contest win — rank ${rank}`,
            status: 'completed',
          },
        })
      );
    }
  });

  // Credit prize coins to winners
  const winnerUpdates = contest.participants
    .map((p, idx) => {
      const rank = idx + 1;
      const prizeCoins = distribution[String(rank)] ?? 0;
      if (prizeCoins <= 0) return null;
      return prisma.user.update({
        where: { id: p.userId },
        data: { coinBalance: { increment: prizeCoins } },
      });
    })
    .filter(Boolean) as ReturnType<typeof prisma.user.update>[];

  await prisma.$transaction([...updates, ...txns, ...winnerUpdates]);
  logger.info('Prizes awarded', { contestId });
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

  return { transactions, total };
}
