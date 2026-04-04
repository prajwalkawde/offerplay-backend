import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';
  return 'Good Evening';
}

export async function getHomeData(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;

  const [
    userResult,
    bonusResult,
    recentTxResult,
    topPlayersResult,
    contestsResult,
  ] = await Promise.allSettled([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, name: true, coinBalance: true,
        ticketBalance: true, createdAt: true,
      },
    }),
    // Check if daily bonus claimed today
    prisma.transaction.findFirst({
      where: {
        userId,
        type: 'EARN_DAILY',
        createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
      select: { id: true, createdAt: true },
    }),
    // Recent 5 transactions for activity feed
    prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, type: true, amount: true, description: true, createdAt: true },
    }),
    // Top 5 users by coin balance for leaderboard
    prisma.user.findMany({
      orderBy: { coinBalance: 'desc' },
      take: 5,
      select: { id: true, name: true, coinBalance: true },
    }),
    // Active contests
    prisma.contest.findMany({
      where: { status: { in: ['REGISTRATION_OPEN', 'GAMEPLAY_ACTIVE'] } },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { id: true, name: true, totalPrizePool: true, entryFee: true, status: true, currentPlayers: true, maxPlayers: true },
    }).catch(() => [] as any[]),
  ]);

  const user = userResult.status === 'fulfilled' ? userResult.value : null;
  if (!user) { error(res, 'User not found', 404); return; }

  const bonusClaimed = bonusResult.status === 'fulfilled' ? !!bonusResult.value : false;
  const recentActivity = recentTxResult.status === 'fulfilled' ? recentTxResult.value : [];
  const topPlayers = topPlayersResult.status === 'fulfilled' ? topPlayersResult.value : [];
  const activeContests = contestsResult.status === 'fulfilled' ? contestsResult.value : [];

  // Calculate streak from consecutive daily bonus transactions
  let streak = 0;
  try {
    const bonusHistory = await prisma.transaction.findMany({
      where: { userId, type: { in: ['EARN_DAILY', 'EARN_STREAK'] } },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { createdAt: true },
    });
    if (bonusHistory.length > 0) {
      streak = 1;
      for (let i = 1; i < bonusHistory.length; i++) {
        const prev = new Date(bonusHistory[i - 1].createdAt);
        const curr = new Date(bonusHistory[i].createdAt);
        const dayDiff = Math.floor((prev.getTime() - curr.getTime()) / 86400000);
        if (dayDiff === 1) streak++;
        else break;
      }
    }
  } catch { /* streak stays 0 */ }

  success(res, {
    user: {
      id: user.id,
      name: user.name,
      coinBalance: user.coinBalance,
      inrValue: Math.floor(user.coinBalance / 100),
      ticketBalance: user.ticketBalance,
    },
    bonusClaimed,
    streak,
    greeting: getGreeting(),
    recentActivity,
    topPlayers,
    activeContests,
  });
}
