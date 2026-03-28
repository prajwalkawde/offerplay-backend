import { prisma } from '../config/database';

export async function getUserStats(userId: string): Promise<{
  coinBalance: number;
  totalEarned: number;
  totalSpent: number;
  contestsPlayed: number;
  contestsWon: number;
  iplPredictions: number;
  iplCorrect: number;
}> {
  const [user, earnAgg, spendAgg, contestsPlayed, contestsWon, iplTotal, iplCorrect] =
    await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { coinBalance: true } }),
      prisma.transaction.aggregate({
        where: { userId, amount: { gt: 0 } },
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        where: { userId, amount: { lt: 0 } },
        _sum: { amount: true },
      }),
      prisma.participant.count({ where: { userId } }),
      prisma.participant.count({ where: { userId, rank: 1 } }),
      prisma.iplPrediction.count({ where: { userId } }),
      prisma.iplPrediction.count({ where: { userId, isCorrect: true } }),
    ]);

  return {
    coinBalance: user?.coinBalance ?? 0,
    totalEarned: earnAgg._sum.amount ?? 0,
    totalSpent: Math.abs(spendAgg._sum.amount ?? 0),
    contestsPlayed,
    contestsWon,
    iplPredictions: iplTotal,
    iplCorrect,
  };
}
