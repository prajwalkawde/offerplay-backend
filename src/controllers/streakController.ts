import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import { TransactionType, Prisma } from '@prisma/client';
import { creditTickets } from '../services/ticketService';

// ─── GET /api/earn/daily-streak ───────────────────────────────────────────────
export const getStreakData = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;

    let streak = await prisma.userStreak.findUnique({ where: { userId } });
    if (!streak) {
      streak = await prisma.userStreak.create({ data: { userId } });
    }

    const config = await prisma.dailyStreakConfig.findMany({ orderBy: { day: 'asc' } });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let canClaimToday = true;
    let isStreakBroken = false;

    if (streak.lastClaimDate) {
      const lastClaimDay = new Date(streak.lastClaimDate);
      lastClaimDay.setHours(0, 0, 0, 0);
      const daysDiff = Math.floor((today.getTime() - lastClaimDay.getTime()) / 86400000);

      if (daysDiff === 0) {
        canClaimToday = false;
      } else if (daysDiff > 1) {
        isStreakBroken = true;
      }
    }

    const currentStreak = isStreakBroken ? 0 : streak.currentStreak;
    const currentDay = ((currentStreak % 7) || (currentStreak === 0 ? 1 : 7));
    const todayConfig = config.find((c) => c.day === currentDay) ?? config[0];

    let nextClaimAt: Date | null = null;
    if (!canClaimToday && streak.lastClaimDate) {
      nextClaimAt = new Date(streak.lastClaimDate);
      nextClaimAt.setDate(nextClaimAt.getDate() + 1);
      nextClaimAt.setHours(0, 0, 0, 0);
    }

    success(res, {
      currentStreak,
      longestStreak: streak.longestStreak,
      lastClaimDate: streak.lastClaimDate,
      totalDaysClaimed: streak.totalDaysClaimed,
      totalCoinsEarned: streak.totalCoinsFromStreak,
      canClaimToday,
      isStreakBroken,
      currentDay,
      nextClaimAt,
      todayReward: todayConfig?.coins ?? 10,
      todayTickets: todayConfig?.tickets ?? 0,
      todayIcon: todayConfig?.icon ?? '🪙',
      isSpecialDay: todayConfig?.isSpecial ?? false,
      config,
    });
  } catch (err) {
    logger.error('getStreakData error:', err);
    error(res, 'Failed to get streak data', 500);
  }
};

// ─── POST /api/earn/daily-streak/claim ───────────────────────────────────────
export const claimDailyStreak = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;

    let streak = await prisma.userStreak.findUnique({ where: { userId } });
    if (!streak) {
      streak = await prisma.userStreak.create({ data: { userId } });
    }

    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    if (streak.lastClaimDate) {
      const lastClaimDay = new Date(streak.lastClaimDate);
      lastClaimDay.setHours(0, 0, 0, 0);
      const daysDiff = Math.floor((today.getTime() - lastClaimDay.getTime()) / 86400000);

      if (daysDiff === 0) {
        error(res, 'Already claimed today! Come back tomorrow 🌅', 400);
        return;
      }

      if (daysDiff > 1) {
        // Streak broken — reset before incrementing
        streak = await prisma.userStreak.update({
          where: { userId },
          data: { currentStreak: 0 },
        });
      }
    }

    const newStreak = streak.currentStreak + 1;
    const dayInCycle = ((newStreak - 1) % 7) + 1;

    const config = await prisma.dailyStreakConfig.findUnique({ where: { day: dayInCycle } });
    const coinsToAward  = config?.coins   ?? 10;
    const ticketsToAward = config?.tickets ?? 0;   // only what admin configured — no fallback
    const isSpecial = config?.isSpecial ?? false;

    // Build transaction ops — only include coin ops if coins > 0
    const txOps: Prisma.PrismaPromise<any>[] = [
      prisma.userStreak.update({
        where: { userId },
        data: {
          currentStreak: newStreak,
          longestStreak: Math.max(streak.longestStreak, newStreak),
          lastClaimDate: now,
          totalDaysClaimed: { increment: 1 },
          totalCoinsFromStreak: { increment: coinsToAward },
        },
      }),
    ];

    if (coinsToAward > 0) {
      txOps.push(
        prisma.user.update({
          where: { id: userId },
          data: { coinBalance: { increment: coinsToAward } },
        }),
        prisma.transaction.create({
          data: {
            userId,
            type: TransactionType.EARN_STREAK,
            amount: coinsToAward,
            description: `Day ${dayInCycle} streak bonus${isSpecial ? ' 👑 SPECIAL!' : ''}`,
            status: 'completed',
          },
        }),
      );
    }

    await prisma.$transaction(txOps);

    // Credit tickets only if configured > 0
    let newTicketBalance = 0;
    if (ticketsToAward > 0) {
      try {
        newTicketBalance = await creditTickets(
          userId,
          ticketsToAward,
          `Daily bonus day ${dayInCycle} tickets`,
          `daily_bonus_${userId}_${today.toISOString().slice(0, 10)}`
        );
      } catch { /* non-critical */ }
    }

    // Build reward summary string for notification
    const rewardSummary =
      coinsToAward > 0 && ticketsToAward > 0
        ? `+${coinsToAward} coins & +${ticketsToAward} tickets`
        : ticketsToAward > 0
        ? `+${ticketsToAward} tickets`
        : `+${coinsToAward} coins`;

    try {
      await prisma.notification.create({
        data: {
          userId,
          title: isSpecial ? '👑 SPECIAL Day 7 Bonus!' : `🔥 Day ${newStreak} Streak!`,
          body: `${rewardSummary} added to your wallet!`,
          type: 'DAILY_STREAK',
        },
      });
    } catch { /* non-critical */ }

    success(
      res,
      {
        coinsAwarded:  coinsToAward,
        ticketsEarned: ticketsToAward,
        ticketBalance: newTicketBalance,
        newStreak,
        dayInCycle,
        isSpecial,
        message: isSpecial
          ? `🎉 Special Day 7 Bonus! ${rewardSummary}!`
          : `${rewardSummary} added! Day ${newStreak} streak! 🔥`,
      },
      isSpecial ? '👑 SPECIAL bonus claimed!' : '🎉 Daily bonus claimed!'
    );
  } catch (err) {
    logger.error('claimDailyStreak error:', err);
    error(res, 'Failed to claim', 500);
  }
};

// ─── Admin: GET /api/admin/streak-config ─────────────────────────────────────
export const getStreakConfig = async (_req: Request, res: Response): Promise<void> => {
  try {
    let config = await prisma.dailyStreakConfig.findMany({ orderBy: { day: 'asc' } });

    if (config.length === 0) {
      const defaults = [
        { day: 1, coins: 10, label: 'Day 1', icon: '🪙', isSpecial: false },
        { day: 2, coins: 15, label: 'Day 2', icon: '🪙', isSpecial: false },
        { day: 3, coins: 20, label: 'Day 3', icon: '💫', isSpecial: false },
        { day: 4, coins: 25, label: 'Day 4', icon: '⭐', isSpecial: false },
        { day: 5, coins: 30, label: 'Day 5', icon: '🌟', isSpecial: false },
        { day: 6, coins: 35, label: 'Day 6', icon: '✨', isSpecial: false },
        { day: 7, coins: 100, label: 'Day 7 🎉', icon: '👑', isSpecial: true },
      ];
      for (const d of defaults) {
        await prisma.dailyStreakConfig.upsert({
          where: { day: d.day },
          update: {},
          create: d,
        });
      }
      config = await prisma.dailyStreakConfig.findMany({ orderBy: { day: 'asc' } });
    }

    success(res, config);
  } catch (err) {
    error(res, 'Failed to get streak config', 500);
  }
};

// ─── Admin: PUT /api/admin/streak-config/:day ─────────────────────────────────
export const updateStreakConfig = async (req: Request, res: Response): Promise<void> => {
  try {
    const day = parseInt(req.params.day as string, 10);
    const { coins, tickets, label, icon, isSpecial } = req.body as {
      coins: number; tickets: number; label: string; icon: string; isSpecial: boolean;
    };

    const updated = await prisma.dailyStreakConfig.update({
      where: { day },
      data: { coins: Number(coins), tickets: Number(tickets ?? 0), label, icon, isSpecial: isSpecial === true },
    });

    success(res, updated, 'Day updated!');
  } catch (err) {
    error(res, 'Failed to update streak config', 500);
  }
};

// ─── Admin: GET /api/admin/streak-stats ──────────────────────────────────────
export const getStreakStats = async (_req: Request, res: Response): Promise<void> => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalClaimsToday, coinsToday, usersOnStreak, avgStreak] = await Promise.all([
      prisma.transaction.count({
        where: { type: TransactionType.EARN_STREAK, createdAt: { gte: today } },
      }),
      prisma.transaction.aggregate({
        where: { type: TransactionType.EARN_STREAK, createdAt: { gte: today } },
        _sum: { amount: true },
      }),
      prisma.userStreak.count({ where: { currentStreak: { gt: 0 } } }),
      prisma.userStreak.aggregate({ _avg: { currentStreak: true } }),
    ]);

    success(res, {
      totalClaimsToday,
      totalCoinsToday: coinsToday._sum.amount ?? 0,
      usersOnStreak,
      avgStreak: Math.round(avgStreak._avg.currentStreak ?? 0),
    });
  } catch (err) {
    error(res, 'Failed to get streak stats', 500);
  }
};
