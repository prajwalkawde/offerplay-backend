import { Request, Response } from 'express';
import { TransactionType } from '@prisma/client';
import { success, error, paginated } from '../utils/response';
import { logger } from '../utils/logger';
import { prisma } from '../config/database';
import * as superOfferService from '../services/superOffer.service';
import { creditTickets, debitTickets, getTicketTotals } from '../services/ticket.service';

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function adminGetSettings(req: Request, res: Response): Promise<void> {
  try {
    const settings = await superOfferService.getSettings();
    success(res, settings);
  } catch (err) {
    logger.error('adminGetSettings error', { err });
    error(res, 'Failed to get settings', 500);
  }
}

export async function adminUpdateSettings(req: Request, res: Response): Promise<void> {
  try {
    const { isActive, cooldownHours, tiers } = req.body as {
      isActive: boolean;
      cooldownHours: number;
      tiers: Array<{
        attemptNumber: number;
        gemsCost: number;
        coinReward: number;
        rewardType: string;
        quizGemReward: number;
        hasAppInstallStep: boolean;
        requiredUsageMinutes: number;
        isDefault: boolean;
      }>;
    };

    if (typeof isActive !== 'boolean' || !cooldownHours || !Array.isArray(tiers) || tiers.length === 0) {
      error(res, 'isActive, cooldownHours and at least one tier are required', 400);
      return;
    }

    // Ensure exactly one default tier
    const defaultTiers = tiers.filter((t) => t.isDefault);
    if (defaultTiers.length !== 1) {
      error(res, 'Exactly one tier must be marked as default (for attempt 3+)', 400);
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.superOfferSettings.upsert({
        where: { id: 1 },
        update: { isActive, cooldownHours },
        create: { id: 1, isActive, cooldownHours },
      });

      await tx.superOfferTier.deleteMany({ where: { superOfferSettingsId: 1 } });

      await tx.superOfferTier.createMany({
        data: tiers.map((t) => ({
          superOfferSettingsId: 1,
          attemptNumber: t.isDefault ? 0 : t.attemptNumber,
          gemsCost: t.gemsCost ?? 20,
          coinReward: t.coinReward ?? 100,
          rewardType: t.rewardType ?? 'COINS',
          quizGemReward: t.quizGemReward ?? 5,
          hasAppInstallStep: t.hasAppInstallStep ?? false,
          requiredUsageMinutes: t.requiredUsageMinutes ?? 2,
          isDefault: t.isDefault ?? false,
        })),
      });
    });

    logger.info('Admin updated Super Offer settings', { adminId: req.adminId });
    const updated = await superOfferService.getSettings();
    success(res, updated, 'Settings updated');
  } catch (err) {
    logger.error('adminUpdateSettings error', { err });
    error(res, 'Failed to update settings', 500);
  }
}

// ─── Attempts ─────────────────────────────────────────────────────────────────

export async function adminGetAttempts(req: Request, res: Response): Promise<void> {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(100, parseInt(String(req.query.limit || '50'), 10));
    const statusFilter = req.query.status ? String(req.query.status) : undefined;
    const uidFilter = req.query.uid ? String(req.query.uid) : undefined;
    const dateFrom = req.query.dateFrom ? new Date(String(req.query.dateFrom)) : undefined;
    const dateTo = req.query.dateTo ? new Date(String(req.query.dateTo)) : undefined;

    const where: Record<string, unknown> = {};
    if (statusFilter) where.status = statusFilter;
    if (uidFilter) where.uid = { contains: uidFilter };
    if (dateFrom || dateTo) {
      where.createdAt = {
        ...(dateFrom ? { gte: dateFrom } : {}),
        ...(dateTo ? { lte: dateTo } : {}),
      };
    }

    const [attempts, total] = await Promise.all([
      prisma.superOfferAttempt.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.superOfferAttempt.count({ where }),
    ]);

    paginated(res, attempts, total, page, limit);
  } catch (err) {
    logger.error('adminGetAttempts error', { err });
    error(res, 'Failed to get attempts', 500);
  }
}

// ─── Analytics ────────────────────────────────────────────────────────────────

export async function adminGetAnalytics(_req: Request, res: Response): Promise<void> {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalAttempts,
      completedCount,
      failedCount,
      inProgressCount,
      coinsAgg,
      ticketsAgg,
      funnel,
      attemptsPerDay,
      coinsPerDay,
      completedWithTime,
    ] = await Promise.all([
      prisma.superOfferAttempt.count(),
      prisma.superOfferAttempt.count({ where: { status: 'completed' } }),
      prisma.superOfferAttempt.count({ where: { status: 'failed' } }),
      prisma.superOfferAttempt.count({ where: { status: { in: ['pending', 'ad_watched', 'installed', 'verifying'] } } }),
      prisma.superOfferAttempt.aggregate({ where: { status: 'completed' }, _sum: { coinsAwarded: true } }),
      prisma.superOfferAttempt.aggregate({ _sum: { gemsCost: true } }),
      prisma.superOfferAttempt.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.superOfferAttempt.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.superOfferAttempt.findMany({
        where: { status: 'completed', completedAt: { gte: thirtyDaysAgo } },
        select: { completedAt: true, coinsAwarded: true },
        orderBy: { completedAt: 'asc' },
      }),
      prisma.superOfferAttempt.findMany({
        where: { status: 'completed', startedAt: { not: undefined }, completedAt: { not: null } },
        select: { startedAt: true, completedAt: true },
      }),
    ]);

    // Build funnel map
    const funnelMap: Record<string, number> = {
      pending: 0, ad_watched: 0, installed: 0, verifying: 0, completed: 0, failed: 0,
    };
    for (const group of funnel) {
      funnelMap[group.status] = group._count.id;
    }

    // Build attempts per day
    const attemptsDateMap: Record<string, number> = {};
    for (const a of attemptsPerDay) {
      const d = a.createdAt.toISOString().slice(0, 10);
      attemptsDateMap[d] = (attemptsDateMap[d] ?? 0) + 1;
    }

    // Build coins per day
    const coinsDateMap: Record<string, number> = {};
    for (const a of coinsPerDay) {
      if (!a.completedAt) continue;
      const d = a.completedAt.toISOString().slice(0, 10);
      coinsDateMap[d] = (coinsDateMap[d] ?? 0) + a.coinsAwarded;
    }

    // Avg completion time
    let avgCompletionHours = 0;
    if (completedWithTime.length > 0) {
      const total = completedWithTime.reduce((sum, a) => {
        if (!a.completedAt) return sum;
        return sum + (a.completedAt.getTime() - a.startedAt.getTime());
      }, 0);
      avgCompletionHours = total / completedWithTime.length / (1000 * 60 * 60);
    }

    const completionRate = totalAttempts > 0 ? (completedCount / totalAttempts) * 100 : 0;

    success(res, {
      total_attempts: totalAttempts,
      completed: completedCount,
      failed: failedCount,
      in_progress: inProgressCount,
      total_coins_awarded: coinsAgg._sum.coinsAwarded ?? 0,
      total_gems_spent: ticketsAgg._sum.gemsCost ?? 0,
      completion_rate_percent: Math.round(completionRate * 10) / 10,
      avg_completion_time_hours: Math.round(avgCompletionHours * 10) / 10,
      funnel: funnelMap,
      attempts_per_day: Object.entries(attemptsDateMap).map(([date, count]) => ({ date, count })),
      coins_per_day: Object.entries(coinsDateMap).map(([date, coins]) => ({ date, coins })),
    });
  } catch (err) {
    logger.error('adminGetAnalytics error', { err });
    error(res, 'Failed to get analytics', 500);
  }
}

// ─── Manual Complete ──────────────────────────────────────────────────────────

export async function adminCompleteAttempt(req: Request, res: Response): Promise<void> {
  try {
    const attemptId = parseInt(String(req.params.id), 10);
    const { reason } = req.body as { reason: string };

    if (!reason) { error(res, 'reason is required', 400); return; }

    const attempt = await prisma.superOfferAttempt.findFirst({
      where: { id: attemptId, status: { notIn: ['completed', 'failed'] } },
    });

    if (!attempt) { error(res, 'Attempt not found or already in terminal state', 404); return; }

    const spendId = `ADMIN_${attemptId}_${req.adminId}_${Date.now()}`;

    const result = await prisma.$transaction(async (tx) => {
      await tx.superOfferAttempt.update({
        where: { id: attemptId },
        data: { spendId },
      });

      const updatedUser = await tx.user.update({
        where: { id: attempt.uid },
        data: { coinBalance: { increment: attempt.coinReward } },
        select: { coinBalance: true },
      });

      await tx.transaction.create({
        data: {
          userId: attempt.uid,
          type: TransactionType.ADMIN_CREDIT,
          amount: attempt.coinReward,
          refId: String(attemptId),
          description: `Admin manual complete Super Offer #${attempt.attemptNumber} — ${reason}`,
          status: 'completed',
        },
      });

      const settings = await superOfferService.getSettings();
      const cooldownEndsAt = new Date(Date.now() + settings.cooldownHours * 60 * 60 * 1000);

      await tx.superOfferAttempt.update({
        where: { id: attemptId },
        data: {
          status: 'completed',
          completedAt: new Date(),
          coinsAwarded: attempt.coinReward,
          cooldownEndsAt,
        },
      });

      return { newCoinBalance: updatedUser.coinBalance };
    });

    logger.info('Admin manually completed Super Offer attempt', {
      adminId: req.adminId,
      attemptId,
      uid: attempt.uid,
      reason,
      coinsAwarded: attempt.coinReward,
    });

    success(res, { coinsAwarded: attempt.coinReward, newCoinBalance: result.newCoinBalance }, 'Attempt completed');
  } catch (err) {
    logger.error('adminCompleteAttempt error', { err });
    error(res, 'Failed to complete attempt', 500);
  }
}

// ─── Manual Fail ─────────────────────────────────────────────────────────────

export async function adminFailAttempt(req: Request, res: Response): Promise<void> {
  try {
    const attemptId = parseInt(String(req.params.id), 10);
    const { reason } = req.body as { reason: string };

    if (!reason) { error(res, 'reason is required', 400); return; }

    const attempt = await prisma.superOfferAttempt.findFirst({
      where: { id: attemptId, status: { notIn: ['completed', 'failed'] } },
    });

    if (!attempt) { error(res, 'Attempt not found or already in terminal state', 404); return; }

    await superOfferService.failAttempt(attempt.uid, attemptId, `[Admin: ${reason}]`);

    logger.info('Admin manually failed Super Offer attempt', {
      adminId: req.adminId,
      attemptId,
      uid: attempt.uid,
      reason,
    });

    success(res, null, 'Attempt failed and tickets refunded');
  } catch (err) {
    logger.error('adminFailAttempt error', { err });
    error(res, 'Failed to fail attempt', 500);
  }
}

// ─── Ticket Management ────────────────────────────────────────────────────────

export async function adminGetTicketBalance(req: Request, res: Response): Promise<void> {
  try {
    const { uid } = req.params as { uid: string };
    const user = await prisma.user.findUnique({ where: { id: uid }, select: { id: true } });
    if (!user) { error(res, 'User not found', 404); return; }

    const totals = await getTicketTotals(uid);
    success(res, { uid, ...totals });
  } catch (err) {
    logger.error('adminGetTicketBalance error', { err });
    error(res, 'Failed to get ticket balance', 500);
  }
}

export async function adminCreditTickets(req: Request, res: Response): Promise<void> {
  try {
    const { uid, amount, reason } = req.body as { uid: string; amount: number; reason: string };

    if (!uid || !amount || !reason) {
      error(res, 'uid, amount and reason are required', 400);
      return;
    }

    if (amount <= 0) { error(res, 'Amount must be positive', 400); return; }

    const user = await prisma.user.findUnique({ where: { id: uid }, select: { id: true } });
    if (!user) { error(res, 'User not found', 404); return; }

    const newBalance = await creditTickets(
      uid,
      Number(amount),
      'admin_credit',
      reason,
      `admin_${req.adminId}`
    );

    logger.info('Admin credited tickets', { adminId: req.adminId, uid, amount, reason });
    success(res, { error: 'false', new_balance: newBalance }, 'Tickets credited');
  } catch (err) {
    logger.error('adminCreditTickets error', { err });
    error(res, 'Failed to credit tickets', 500);
  }
}

export async function adminDebitTickets(req: Request, res: Response): Promise<void> {
  try {
    const { uid, amount, reason } = req.body as { uid: string; amount: number; reason: string };

    if (!uid || !amount || !reason) {
      error(res, 'uid, amount and reason are required', 400);
      return;
    }

    if (amount <= 0) { error(res, 'Amount must be positive', 400); return; }

    const user = await prisma.user.findUnique({ where: { id: uid }, select: { id: true } });
    if (!user) { error(res, 'User not found', 404); return; }

    const newBalance = await debitTickets(
      uid,
      Number(amount),
      'admin_debit',
      reason,
      `admin_${req.adminId}`
    );

    logger.info('Admin debited tickets', { adminId: req.adminId, uid, amount, reason });
    success(res, { error: 'false', new_balance: newBalance }, 'Tickets debited');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to debit tickets';
    logger.error('adminDebitTickets error', { err });
    error(res, message, 400);
  }
}

export async function adminGetTicketTransactions(req: Request, res: Response): Promise<void> {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(100, parseInt(String(req.query.limit || '50'), 10));
    const uidFilter = req.query.uid ? String(req.query.uid) : undefined;
    const typeFilter = req.query.type ? String(req.query.type) : undefined;
    const dateFrom = req.query.dateFrom ? new Date(String(req.query.dateFrom)) : undefined;
    const dateTo = req.query.dateTo ? new Date(String(req.query.dateTo)) : undefined;

    const where: Record<string, unknown> = {};
    if (uidFilter) where.userId = { contains: uidFilter };
    if (typeFilter) where.type = typeFilter;
    if (dateFrom || dateTo) {
      where.createdAt = {
        ...(dateFrom ? { gte: dateFrom } : {}),
        ...(dateTo ? { lte: dateTo } : {}),
      };
    }

    const [transactions, total] = await Promise.all([
      prisma.ticketTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.ticketTransaction.count({ where }),
    ]);

    paginated(res, transactions, total, page, limit);
  } catch (err) {
    logger.error('adminGetTicketTransactions error', { err });
    error(res, 'Failed to get transactions', 500);
  }
}
