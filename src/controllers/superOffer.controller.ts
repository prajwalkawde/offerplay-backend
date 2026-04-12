import { Request, Response } from 'express';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import * as superOfferService from '../services/superOffer.service';
import { getGemHistory, getGemTotals } from '../services/gems.service';
import { prisma } from '../config/database';
import { sendFCMToUsers } from '../services/fcmService';

// ─── GET /api/superoffers/status ──────────────────────────────────────────────

export async function getSuperOfferStatus(req: Request, res: Response): Promise<void> {
  try {
    const status = await superOfferService.getStatus(req.userId!);
    success(res, status);
  } catch (err) {
    logger.error('getSuperOfferStatus error', { err, uid: req.userId });
    error(res, 'Failed to get Super Offer status', 500);
  }
}

// ─── POST /api/superoffers/enter ──────────────────────────────────────────────

export async function enterSuperOffer(req: Request, res: Response): Promise<void> {
  try {
    const attempt = await superOfferService.enterOffer(req.userId!);
    const { balance: gemBalanceAfter } = await import('../services/gems.service').then(m => m.getGemTotals(req.userId!));

    success(res, {
      error: 'false',
      attempt_id: attempt.id,
      attempt_number: attempt.attemptNumber,
      gems_cost: (attempt as any).gemsCost,
      coin_reward: attempt.coinReward,
      reward_type: (attempt as any).rewardType ?? 'COINS',
      quiz_gem_reward: (attempt as any).quizGemReward ?? 0,
      has_app_install_step: attempt.hasAppInstallStep,
      required_usage_minutes: attempt.requiredUsageMinutes,
      gem_balance_after: gemBalanceAfter,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to enter Super Offer';
    logger.error('enterSuperOffer error', { err, uid: req.userId });
    error(res, message, 400);
  }
}

// ─── POST /api/superoffers/ad-complete ───────────────────────────────────────

export async function adComplete(req: Request, res: Response): Promise<void> {
  try {
    const { attempt_id } = req.body as { attempt_id: number };
    if (!attempt_id) { error(res, 'attempt_id is required', 400); return; }

    const result = await superOfferService.markAdWatched(req.userId!, Number(attempt_id));
    success(res, {
      error: 'false',
      next_step: result.nextStep,
      attempt_id: Number(attempt_id),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to process ad completion';
    logger.error('adComplete error', { err, uid: req.userId });
    error(res, message, 400);
  }
}

// ─── POST /api/superoffers/install-detected ───────────────────────────────────

export async function installDetected(req: Request, res: Response): Promise<void> {
  try {
    const { attempt_id, app_package, app_name } = req.body as {
      attempt_id: number;
      app_package: string;
      app_name: string;
    };

    if (!attempt_id || !app_package || !app_name) {
      error(res, 'attempt_id, app_package and app_name are required', 400);
      return;
    }

    const installResult = await superOfferService.reportInstall(req.userId!, Number(attempt_id), app_package, app_name);
    success(res, {
      error: 'false',
      next_step: 'use_app',
      detected_app_name: app_name,
      app_installed_at: installResult.appInstalledAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to report install';
    logger.error('installDetected error', { err, uid: req.userId });
    error(res, message, 400);
  }
}

// ─── POST /api/superoffers/verify-usage ───────────────────────────────────────

export async function verifyUsage(req: Request, res: Response): Promise<void> {
  try {
    const { attempt_id, usage_minutes } = req.body as {
      attempt_id: number;
      usage_minutes: number;
    };

    if (!attempt_id || usage_minutes === undefined) {
      error(res, 'attempt_id and usage_minutes are required', 400);
      return;
    }

    await superOfferService.verifyUsage(req.userId!, Number(attempt_id), Number(usage_minutes));
    success(res, { error: 'false', next_step: 'claim_reward' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to verify usage';
    logger.error('verifyUsage error', { err, uid: req.userId });
    error(res, message, 400);
  }
}

// ─── POST /api/superoffers/complete ───────────────────────────────────────────

export async function completeSuperOffer(req: Request, res: Response): Promise<void> {
  try {
    const { attempt_id, spend_id } = req.body as { attempt_id: number; spend_id: string };

    if (!attempt_id || !spend_id) {
      error(res, 'attempt_id and spend_id are required', 400);
      return;
    }

    const result = await superOfferService.completeOffer(
      req.userId!,
      Number(attempt_id),
      spend_id
    );

    const settings = await superOfferService.getSettings();

    // FCM is NOT sent here — the superOfferNotification.job sends a push
    // exactly when the cooldown ends (next offer becomes available), using
    // cooldownEndsAt which is calculated from the admin's cooldownHours setting.

    success(res, {
      error: 'false',
      coins_awarded: result.coinsAwarded,
      new_coin_balance: result.newCoinBalance,
      tickets_awarded: result.ticketsAwarded,
      new_ticket_balance: result.newTicketBalance,
      reward_type: result.rewardType,
      cooldown_hours: settings.cooldownHours,
      cooldown_ends_at: result.cooldownEndsAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to complete Super Offer';
    logger.error('completeSuperOffer error', { err, uid: req.userId });
    error(res, message, 400);
  }
}

// ─── POST /api/superoffers/fail ───────────────────────────────────────────────

export async function failSuperOffer(req: Request, res: Response): Promise<void> {
  try {
    const { attempt_id, reason } = req.body as { attempt_id: number; reason?: string };

    if (!attempt_id) { error(res, 'attempt_id is required', 400); return; }

    await superOfferService.failAttempt(req.userId!, Number(attempt_id), reason);

    sendFCMToUsers([req.userId!], '😔 Super Offer Failed', 'Your Super Offer attempt was unsuccessful. Try again soon!', {
      type: 'super_offer_failed',
    }).catch(e => logger.error('FCM superOffer fail error:', e));

    success(res, { error: 'false' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fail attempt';
    logger.error('failSuperOffer error', { err, uid: req.userId });
    error(res, message, 400);
  }
}

// ─── POST /api/superoffers/quiz-start ────────────────────────────────────────

export async function superOfferQuizStart(req: Request, res: Response): Promise<void> {
  try {
    const { attempt_id } = req.body as { attempt_id: number };
    if (!attempt_id) { error(res, 'attempt_id is required', 400); return; }

    const result = await superOfferService.quizStart(req.userId!, Number(attempt_id));
    success(res, { error: 'false', questions: result.questions });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to start quiz';
    logger.error('superOfferQuizStart error', { err, uid: req.userId });
    error(res, message, 400);
  }
}

// ─── POST /api/superoffers/quiz-complete ──────────────────────────────────────

export async function superOfferQuizComplete(req: Request, res: Response): Promise<void> {
  try {
    const { attempt_id, answers } = req.body as {
      attempt_id: number;
      answers: Array<{ questionId: number; selectedOption: string }>;
    };
    if (!attempt_id || !Array.isArray(answers)) {
      error(res, 'attempt_id and answers are required', 400);
      return;
    }

    const result = await superOfferService.quizComplete(req.userId!, Number(attempt_id), answers);
    success(res, {
      error: 'false',
      correct_answers: result.correctAnswers,
      total_questions: result.totalQuestions,
      passed: result.passed,
      gems_earned: result.gemsEarned,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to complete quiz';
    logger.error('superOfferQuizComplete error', { err, uid: req.userId });
    error(res, message, 400);
  }
}

// ─── GET /api/superoffers/gems ────────────────────────────────────────────────

export async function getMyGems(req: Request, res: Response): Promise<void> {
  try {
    const uid = req.userId!;
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(50, parseInt(String(req.query.limit || '20'), 10));

    const { balance, totalEarned, totalSpent } = await getGemTotals(uid);
    const { transactions, total } = await getGemHistory(uid, page, limit);

    success(res, {
      error: 'false',
      balance,
      total_earned: totalEarned,
      total_spent: totalSpent,
      recent_transactions: transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error('getMyGems error', { err, uid: req.userId });
    error(res, 'Failed to get gem balance', 500);
  }
}

// ─── GET /api/superoffers/tickets (legacy, kept for compatibility) ────────────

export async function getMyTickets(req: Request, res: Response): Promise<void> {
  try {
    const uid = req.userId!;
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(50, parseInt(String(req.query.limit || '20'), 10));

    const user = await prisma.user.findUnique({
      where: { id: uid },
      select: { ticketBalance: true },
    });

    const { getTicketHistory } = await import('../services/ticket.service');
    const { transactions, total } = await getTicketHistory(uid, page, limit);

    const [earnedAgg, spentAgg] = await Promise.all([
      prisma.ticketTransaction.aggregate({
        where: { userId: uid, amount: { gt: 0 } },
        _sum: { amount: true },
      }),
      prisma.ticketTransaction.aggregate({
        where: { userId: uid, amount: { lt: 0 } },
        _sum: { amount: true },
      }),
    ]);

    success(res, {
      error: 'false',
      balance: user?.ticketBalance ?? 0,
      total_earned: earnedAgg._sum.amount ?? 0,
      total_spent: Math.abs(spentAgg._sum.amount ?? 0),
      recent_transactions: transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error('getMyTickets error', { err, uid: req.userId });
    error(res, 'Failed to get ticket balance', 500);
  }
}
