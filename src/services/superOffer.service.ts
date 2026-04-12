/**
 * Super Offer Service
 *
 * COINS = withdrawable reward currency (awarded on completion when rewardType=COINS)
 * TICKETS = non-withdrawable loyalty points (awarded on completion when rewardType=TICKETS)
 * GEMS = engagement currency (spent to enter, earned by passing quiz)
 * Never mix these currencies.
 */

import { TransactionType, SuperOfferAttempt } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { creditTickets } from './ticket.service';
import { creditGems, debitGems, getGemBalance } from './gems.service';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SuperOfferTier {
  id: number;
  attemptNumber: number;
  gemsCost: number;
  coinReward: number;
  rewardType: string;
  quizGemReward: number;
  hasAppInstallStep: boolean;
  requiredUsageMinutes: number;
  isDefault: boolean;
}

interface SuperOfferSettings {
  id: number;
  isActive: boolean;
  cooldownHours: number;
  tiers: SuperOfferTier[];
}

export interface SuperOfferStatusResult {
  isActive: boolean;
  attemptNumber: number;
  gemsCost: number;
  coinReward: number;
  rewardType: string;
  quizGemReward: number;
  hasAppInstallStep: boolean;
  requiredUsageMinutes: number;
  canEnter: boolean;
  cooldownRemainingHours: number;
  cooldownEndsAt: string | null;
  currentGemBalance: number;
  hasEnoughGems: boolean;
  inProgressAttempt: {
    id: number;
    status: string;
    hasAppInstallStep: boolean;
    coinReward: number;
    rewardType: string;
    gemsFromQuiz: number;
    requiredUsageMinutes: number;
    detectedAppPackage: string | null;
    detectedAppName: string | null;
    appInstalledAt: string | null;
  } | null;
}

const IN_PROGRESS_STATUSES = ['pending', 'game_done', 'ad_watched', 'installed', 'verifying'];
const TERMINAL_STATUSES = ['completed', 'failed'];

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getSettings(): Promise<SuperOfferSettings> {
  // Auto-create default settings + tiers if they don't exist yet
  const existing = await prisma.superOfferSettings.findUnique({
    where: { id: 1 },
    include: { tiers: { orderBy: { attemptNumber: 'asc' } } },
  });

  if (existing) return existing as unknown as SuperOfferSettings;

  // First-time setup: create defaults so the admin panel works before seed runs
  await prisma.superOfferSettings.create({
    data: {
      id: 1,
      isActive: true,
      cooldownHours: 24,
      tiers: {
        create: [
          { attemptNumber: 1, gemsCost: 20, coinReward: 100, rewardType: 'COINS', quizGemReward: 5, hasAppInstallStep: false, isDefault: false },
          { attemptNumber: 2, gemsCost: 18, coinReward: 200, rewardType: 'COINS', quizGemReward: 10, hasAppInstallStep: true,  requiredUsageMinutes: 2, isDefault: false },
          { attemptNumber: 0, gemsCost: 15, coinReward: 200, rewardType: 'COINS', quizGemReward: 10, hasAppInstallStep: true,  requiredUsageMinutes: 2, isDefault: true  },
        ],
      },
    },
  });

  const result = await prisma.superOfferSettings.findUniqueOrThrow({
    where: { id: 1 },
    include: { tiers: { orderBy: { attemptNumber: 'asc' } } },
  });
  return result as unknown as SuperOfferSettings;
}

// ─── Tier Resolution ──────────────────────────────────────────────────────────

export function getTierForAttempt(
  settings: SuperOfferSettings,
  attemptNumber: number
): SuperOfferTier {
  // First try exact match
  const exact = settings.tiers.find((t) => t.attemptNumber === attemptNumber);
  if (exact) return exact;

  // Fall back to default tier (attempt 3 and beyond)
  const defaultTier = settings.tiers.find((t) => t.isDefault);
  if (!defaultTier) throw new Error('No default Super Offer tier configured');
  return defaultTier;
}

// ─── Status ───────────────────────────────────────────────────────────────────

export async function getStatus(uid: string): Promise<SuperOfferStatusResult> {
  const [settings, completedCount, inProgressAttempt, activeCooldown, gemBalance] =
    await Promise.all([
      getSettings(),
      prisma.superOfferAttempt.count({ where: { uid, status: 'completed' } }),
      prisma.superOfferAttempt.findFirst({
        where: { uid, status: { in: IN_PROGRESS_STATUSES } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          hasAppInstallStep: true,
          coinReward: true,
          rewardType: true,
          gemsFromQuiz: true,
          requiredUsageMinutes: true,
          detectedAppPackage: true,
          detectedAppName: true,
          appInstalledAt: true,
        },
      }),
      prisma.superOfferAttempt.findFirst({
        where: {
          uid,
          status: 'completed',
          cooldownEndsAt: { gt: new Date() },
        },
        orderBy: { completedAt: 'desc' },
        select: { cooldownEndsAt: true },
      }),
      getGemBalance(uid),
    ]);

  const nextAttemptNumber = completedCount + 1;
  const tier = getTierForAttempt(settings, nextAttemptNumber);

  const onCooldown = activeCooldown !== null;
  let cooldownRemainingHours = 0;
  let cooldownEndsAt: string | null = null;

  if (onCooldown && activeCooldown.cooldownEndsAt) {
    cooldownEndsAt = activeCooldown.cooldownEndsAt.toISOString();
    const msRemaining = activeCooldown.cooldownEndsAt.getTime() - Date.now();
    cooldownRemainingHours = Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60)));
  }

  const canEnter =
    settings.isActive &&
    inProgressAttempt === null &&
    !onCooldown;

  return {
    isActive: settings.isActive,
    attemptNumber: nextAttemptNumber,
    gemsCost: tier.gemsCost,
    coinReward: tier.coinReward,
    rewardType: tier.rewardType,
    quizGemReward: tier.quizGemReward,
    hasAppInstallStep: tier.hasAppInstallStep,
    requiredUsageMinutes: tier.requiredUsageMinutes,
    canEnter,
    cooldownRemainingHours,
    cooldownEndsAt,
    currentGemBalance: gemBalance,
    hasEnoughGems: gemBalance >= tier.gemsCost,
    inProgressAttempt: inProgressAttempt
      ? {
          id: inProgressAttempt.id,
          status: inProgressAttempt.status,
          hasAppInstallStep: inProgressAttempt.hasAppInstallStep,
          coinReward: inProgressAttempt.coinReward,
          rewardType: (inProgressAttempt as any).rewardType ?? 'COINS',
          gemsFromQuiz: (inProgressAttempt as any).gemsFromQuiz ?? 0,
          requiredUsageMinutes: inProgressAttempt.requiredUsageMinutes,
          detectedAppPackage: inProgressAttempt.detectedAppPackage ?? null,
          detectedAppName: inProgressAttempt.detectedAppName ?? null,
          appInstalledAt: inProgressAttempt.appInstalledAt?.toISOString() ?? null,
        }
      : null,
  };
}

// ─── Enter ────────────────────────────────────────────────────────────────────

export async function enterOffer(
  uid: string
): Promise<SuperOfferAttempt> {
  const status = await getStatus(uid);

  if (!status.isActive) throw new Error('Super Offer is not active');
  if (status.inProgressAttempt) throw new Error('You already have an active Super Offer attempt');
  if (status.cooldownRemainingHours > 0) {
    throw new Error(`Super Offer is on cooldown for ${status.cooldownRemainingHours} more hour(s)`);
  }
  if (!status.hasEnoughGems) {
    throw new Error(
      `Insufficient gems — required: ${status.gemsCost}, available: ${status.currentGemBalance}`
    );
  }

  const settings = await getSettings();
  const tier = getTierForAttempt(settings, status.attemptNumber);

  const attempt = await prisma.$transaction(async (tx) => {
    // Debit gems — this will throw if balance is insufficient (double-check)
    await debitGems(
      uid,
      tier.gemsCost,
      'spent_offer',
      `Super Offer attempt #${status.attemptNumber}`,
      undefined,
      tx
    );

    return tx.superOfferAttempt.create({
      data: {
        uid,
        attemptNumber: status.attemptNumber,
        gemsCost: tier.gemsCost,
        coinReward: tier.coinReward,
        rewardType: tier.rewardType,
        gemsFromQuiz: 0,
        hasAppInstallStep: tier.hasAppInstallStep,
        requiredUsageMinutes: tier.requiredUsageMinutes,
        status: 'pending',
      },
    });
  });

  logger.info('Super Offer entered', { uid, attemptId: attempt.id, attemptNumber: attempt.attemptNumber });
  return attempt;
}

// ─── Ad Watched ───────────────────────────────────────────────────────────────

export async function markAdWatched(
  uid: string,
  attemptId: number
): Promise<{ nextStep: string }> {
  const attempt = await prisma.superOfferAttempt.findFirst({
    where: { id: attemptId, uid, status: 'game_done' },
  });

  if (!attempt) throw new Error('Attempt not found or not in game_done state');

  const nextStatus = attempt.hasAppInstallStep ? 'ad_watched' : 'verifying';

  await prisma.superOfferAttempt.update({
    where: { id: attemptId },
    data: { status: nextStatus },
  });

  return { nextStep: attempt.hasAppInstallStep ? 'install_app' : 'claim_reward' };
}

// ─── Install Detected ─────────────────────────────────────────────────────────

export async function reportInstall(
  uid: string,
  attemptId: number,
  appPackage: string,
  appName: string
): Promise<{ appInstalledAt: string }> {
  const attempt = await prisma.superOfferAttempt.findFirst({
    where: { id: attemptId, uid, status: 'ad_watched' },
  });

  if (!attempt) throw new Error('Attempt not found or not in ad_watched state');

  const updated = await prisma.superOfferAttempt.update({
    where: { id: attemptId },
    data: {
      detectedAppPackage: appPackage,
      detectedAppName: appName,
      appInstalledAt: new Date(),
      status: 'installed',
    },
    select: { appInstalledAt: true },
  });

  return { appInstalledAt: updated.appInstalledAt!.toISOString() };
}

// ─── Verify Usage ─────────────────────────────────────────────────────────────

export async function verifyUsage(
  uid: string,
  attemptId: number,
  _usageMinutes: number   // kept for API compatibility but NOT trusted
): Promise<void> {
  const attempt = await prisma.superOfferAttempt.findFirst({
    where: { id: attemptId, uid, status: 'installed' },
  });

  if (!attempt) throw new Error('Attempt not found or not in installed state');

  if (!attempt.appInstalledAt) {
    throw new Error('Install time not recorded — cannot verify usage');
  }

  const elapsedMs = Date.now() - attempt.appInstalledAt.getTime();
  const elapsedMinutes = elapsedMs / 60000;

  if (elapsedMinutes < attempt.requiredUsageMinutes) {
    const remaining = Math.ceil(attempt.requiredUsageMinutes - elapsedMinutes);
    throw new Error(
      `Not enough time has passed since install — need ${remaining} more minute(s)`
    );
  }

  await prisma.superOfferAttempt.update({
    where: { id: attemptId },
    data: {
      usageVerifiedAt: new Date(),
      status: 'verifying',
    },
  });
}

// ─── Complete ─────────────────────────────────────────────────────────────────

export async function completeOffer(
  uid: string,
  attemptId: number,
  spendId: string
): Promise<{ coinsAwarded: number; newCoinBalance: number; ticketsAwarded: number; newTicketBalance: number; rewardType: string; cooldownEndsAt: string }> {
  const attempt = await prisma.superOfferAttempt.findFirst({
    where: { id: attemptId, uid, status: 'verifying' },
  });

  if (!attempt) throw new Error('Attempt not found or not in verifying state');

  // Idempotency — already completed
  if (attempt.spendId !== null) {
    const user = await prisma.user.findUnique({
      where: { id: uid },
      select: { coinBalance: true, ticketBalance: true },
    });
    const rewardType = (attempt as any).rewardType ?? 'COINS';
    return {
      coinsAwarded: rewardType === 'COINS' ? attempt.coinsAwarded : 0,
      newCoinBalance: user?.coinBalance ?? 0,
      ticketsAwarded: rewardType === 'TICKETS' ? attempt.coinsAwarded : 0,
      newTicketBalance: user?.ticketBalance ?? 0,
      rewardType,
      cooldownEndsAt: attempt.cooldownEndsAt?.toISOString() ?? new Date().toISOString(),
    };
  }

  const settings = await getSettings();
  const cooldownEndsAt = new Date(Date.now() + settings.cooldownHours * 60 * 60 * 1000);
  const rewardType = (attempt as any).rewardType ?? 'COINS';
  const rewardAmount = attempt.coinReward;

  const result = await prisma.$transaction(async (tx) => {
    // Lock with spendId first to prevent double-claim
    await tx.superOfferAttempt.update({
      where: { id: attemptId },
      data: { spendId },
    });

    let newCoinBalance = 0;
    let newTicketBalance = 0;

    if (rewardType === 'TICKETS') {
      // Award tickets
      const updatedUser = await tx.user.update({
        where: { id: uid },
        data: { ticketBalance: { increment: rewardAmount } },
        select: { coinBalance: true, ticketBalance: true },
      });
      newCoinBalance = updatedUser.coinBalance;
      newTicketBalance = updatedUser.ticketBalance;

      await tx.ticketTransaction.create({
        data: {
          userId: uid,
          amount: rewardAmount,
          type: 'super_offer_reward',
          description: `Super Offer attempt #${attempt.attemptNumber} reward`,
          refId: String(attemptId),
        },
      });
    } else {
      // Award coins (default)
      const updatedUser = await tx.user.update({
        where: { id: uid },
        data: { coinBalance: { increment: rewardAmount } },
        select: { coinBalance: true, ticketBalance: true },
      });
      newCoinBalance = updatedUser.coinBalance;
      newTicketBalance = updatedUser.ticketBalance;

      await tx.transaction.create({
        data: {
          userId: uid,
          type: TransactionType.EARN_TASK,
          amount: rewardAmount,
          refId: String(attemptId),
          description: `Super Offer attempt #${attempt.attemptNumber} reward`,
          status: 'completed',
        },
      });
    }

    await tx.superOfferAttempt.update({
      where: { id: attemptId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        coinsAwarded: rewardAmount,
        cooldownEndsAt,
      },
    });

    return { newCoinBalance, newTicketBalance };
  });

  logger.info('Super Offer completed', {
    uid,
    attemptId,
    rewardType,
    rewardAmount,
    spendId,
  });

  return {
    coinsAwarded: rewardType === 'COINS' ? rewardAmount : 0,
    newCoinBalance: result.newCoinBalance,
    ticketsAwarded: rewardType === 'TICKETS' ? rewardAmount : 0,
    newTicketBalance: result.newTicketBalance,
    rewardType,
    cooldownEndsAt: cooldownEndsAt.toISOString(),
  };
}

// ─── Fail ─────────────────────────────────────────────────────────────────────

export async function failAttempt(
  uid: string,
  attemptId: number,
  reason?: string
): Promise<void> {
  const attempt = await prisma.superOfferAttempt.findFirst({
    where: {
      id: attemptId,
      uid,
      status: { notIn: TERMINAL_STATUSES },
    },
  });

  if (!attempt) throw new Error('Attempt not found or already in a terminal state');

  await prisma.superOfferAttempt.update({
    where: { id: attemptId },
    data: { status: 'failed' },
  });

  // Refund gems if any were spent
  const gemsCost = (attempt as any).gemsCost ?? 0;
  if (gemsCost > 0) {
    await creditGems(
      uid,
      gemsCost,
      'refund',
      `Refund for failed Super Offer attempt #${attempt.attemptNumber}${reason ? ': ' + reason : ''}`,
      String(attemptId)
    );

    logger.info('Gems refunded for failed Super Offer attempt', {
      uid,
      attemptId,
      gemsRefunded: gemsCost,
    });
  }
}

// ─── Quiz Start ───────────────────────────────────────────────────────────────

export async function quizStart(
  uid: string,
  attemptId: number
): Promise<{ questions: Array<{ id: number; question: string; optionA: string; optionB: string; optionC: string; optionD: string; sport: string; difficulty: string }> }> {
  const attempt = await prisma.superOfferAttempt.findFirst({
    where: { id: attemptId, uid, status: 'pending' },
  });
  if (!attempt) throw Object.assign(new Error('Attempt not found or not in pending state'), { code: 'INVALID_STATUS' });

  // Fetch a diverse pool and pick 5
  const pool = await prisma.sportsQuestion.findMany({
    where: { isActive: true },
    orderBy: { usageCount: 'asc' },
    take: 30,
    select: { id: true, question: true, optionA: true, optionB: true, optionC: true, optionD: true, sport: true, difficulty: true },
  });

  const shuffled = pool.sort(() => Math.random() - 0.5).slice(0, 5);
  const questionIds = shuffled.map((q) => q.id);

  await prisma.superOfferAttempt.update({
    where: { id: attemptId },
    data: { quizQuestionIdsJson: JSON.stringify(questionIds) },
  });

  // Increment usageCount
  await prisma.sportsQuestion.updateMany({
    where: { id: { in: questionIds } },
    data: { usageCount: { increment: 1 } },
  });

  logger.info('Super Offer quiz started', { uid, attemptId, questionCount: shuffled.length });
  return { questions: shuffled };
}

// ─── Quiz Complete ────────────────────────────────────────────────────────────

export async function quizComplete(
  uid: string,
  attemptId: number,
  answers: Array<{ questionId: number; selectedOption: string }>
): Promise<{ correctAnswers: number; totalQuestions: number; passed: boolean; gemsEarned: number }> {
  const attempt = await prisma.superOfferAttempt.findFirst({
    where: { id: attemptId, uid, status: 'pending' },
  });
  if (!attempt) throw Object.assign(new Error('Attempt not found or not in pending state'), { code: 'INVALID_STATUS' });
  if (!attempt.quizQuestionIdsJson) throw Object.assign(new Error('Quiz not started yet'), { code: 'NOT_STARTED' });

  const questionIds: number[] = JSON.parse(attempt.quizQuestionIdsJson);
  const questions = await prisma.sportsQuestion.findMany({
    where: { id: { in: questionIds } },
    select: { id: true, correctOption: true },
  });
  const qMap = new Map(questions.map((q) => [q.id, q.correctOption]));

  let correctAnswers = 0;
  for (const ans of answers) {
    const correct = qMap.get(ans.questionId);
    if (correct && ans.selectedOption.toUpperCase() === correct) correctAnswers++;
  }

  const totalQuestions = questionIds.length;
  const passed = correctAnswers >= 3;
  const quizGemReward = (attempt as any).quizGemReward ?? 0;
  let gemsEarned = 0;

  if (passed) {
    await prisma.superOfferAttempt.update({
      where: { id: attemptId },
      data: { status: 'game_done', quizGameDoneAt: new Date(), gemsFromQuiz: quizGemReward },
    });

    // Credit gems for passing quiz
    if (quizGemReward > 0) {
      await creditGems(
        uid,
        quizGemReward,
        'quiz_reward',
        `Super Offer quiz reward (attempt #${attempt.attemptNumber})`,
        String(attemptId)
      );
      gemsEarned = quizGemReward;
    }

    logger.info('Super Offer quiz passed', { uid, attemptId, correctAnswers, gemsEarned });
  } else {
    logger.info('Super Offer quiz failed', { uid, attemptId, correctAnswers });
  }

  return { correctAnswers, totalQuestions, passed, gemsEarned };
}
