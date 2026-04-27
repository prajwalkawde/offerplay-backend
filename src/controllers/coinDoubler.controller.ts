// Coin Doubler — "Watch ad → 2× your last earned reward (capped)"
//
// AdMob policy compliance:
//   - Opt-in (user explicitly taps to watch)
//   - Reward amount disclosed before ad
//   - Bounded reward (admin-configured `coinDoublerMaxBonus`, default 50 coins)
//   - Daily limit (`coinDoublerMaxPerDay`, default 3) keeps the coin economy
//     sustainable and prevents abuse
//   - Server-side validation: client cannot fake the doubling — server looks up
//     the actual last earned amount from Transaction history
//
// Flow:
//   1. Mobile calls /eligibility — server returns { eligible, lastReward, todaysCount, ... }
//   2. Mobile shows widget with "Watch ad → 2× X coins"
//   3. User taps + watches ad (rewardedAd.show() resolves earned=true)
//   4. Mobile calls /claim — server credits the doubled-and-capped amount

import { Request, Response } from 'express';
import { TransactionType } from '@prisma/client';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import { creditCoins } from '../services/coinService';
import { loadAdSettings } from '../services/adSettings.service';

// Earn types eligible for doubling — only "real" earnings, not bonuses or
// referral commissions (would create runaway loops otherwise).
const DOUBLER_ELIGIBLE_TYPES: TransactionType[] = [
  TransactionType.EARN_TASK,
  TransactionType.EARN_SURVEY,
  TransactionType.EARN_OFFERWALL,
  TransactionType.EARN_DAILY,
  TransactionType.EARN_STREAK,
];

// Window during which a "last reward" is still doubleable. Beyond this, the
// user has to earn something fresh first.
const ELIGIBILITY_WINDOW_HOURS = 24;

interface EligibilityResult {
  eligible: boolean;
  reason?: string;
  lastReward: number;       // raw last reward (before doubling)
  bonus: number;            // what the user will actually receive (after cap)
  todaysCount: number;
  dailyLimit: number;
  maxBonus: number;
}

async function computeEligibility(uid: string): Promise<EligibilityResult> {
  const settings = await loadAdSettings();
  const dailyLimit = settings.coinDoublerMaxPerDay;
  const maxBonus = settings.coinDoublerMaxBonus;

  // Count today's doublings (UTC midnight reset)
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const todaysCount = await prisma.transaction.count({
    where: {
      userId: uid,
      type: TransactionType.EARN_BONUS,
      description: { contains: 'Coin Doubler' },
      createdAt: { gte: todayUtc },
    },
  });

  if (!settings.enableCoinDoubler) {
    return { eligible: false, reason: 'feature_disabled', lastReward: 0, bonus: 0, todaysCount, dailyLimit, maxBonus };
  }
  if (todaysCount >= dailyLimit) {
    return { eligible: false, reason: 'daily_limit_reached', lastReward: 0, bonus: 0, todaysCount, dailyLimit, maxBonus };
  }

  // Find last eligible earn within window
  const cutoff = new Date(Date.now() - ELIGIBILITY_WINDOW_HOURS * 60 * 60 * 1000);
  const lastEarn = await prisma.transaction.findFirst({
    where: {
      userId: uid,
      type: { in: DOUBLER_ELIGIBLE_TYPES },
      amount: { gt: 0 },
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, amount: true, type: true, createdAt: true },
  });
  if (!lastEarn) {
    return { eligible: false, reason: 'no_recent_earn', lastReward: 0, bonus: 0, todaysCount, dailyLimit, maxBonus };
  }

  // Make sure THIS particular reward hasn't already been doubled
  const alreadyDoubled = await prisma.transaction.findFirst({
    where: {
      userId: uid,
      type: TransactionType.EARN_BONUS,
      refId: lastEarn.id,
      description: { contains: 'Coin Doubler' },
    },
  });
  if (alreadyDoubled) {
    return { eligible: false, reason: 'already_doubled', lastReward: lastEarn.amount, bonus: 0, todaysCount, dailyLimit, maxBonus };
  }

  // Server-validated bonus = min(lastReward, maxBonus)
  const bonus = Math.min(lastEarn.amount, maxBonus);
  return { eligible: true, lastReward: lastEarn.amount, bonus, todaysCount, dailyLimit, maxBonus };
}

// ─── GET /api/earn/coin-doubler/eligibility ──────────────────────────────────

export async function getEligibility(req: Request, res: Response): Promise<void> {
  try {
    const result = await computeEligibility(req.userId!);
    success(res, result);
  } catch (err) {
    logger.error('[CoinDoubler] eligibility error', err);
    error(res, 'Failed to check eligibility', 500);
  }
}

// ─── POST /api/earn/coin-doubler/claim ───────────────────────────────────────
// Mobile calls this AFTER a successful rewardedAd.show() resolves with earned=true.
// Server independently re-validates eligibility (anti-cheat) and re-computes the
// bonus from authoritative DB data.

export async function claimDoubler(req: Request, res: Response): Promise<void> {
  try {
    const uid = req.userId!;
    const result = await computeEligibility(uid);
    if (!result.eligible) {
      error(res, `Coin doubler unavailable: ${result.reason}`, 400);
      return;
    }

    // Look up the source transaction id again so we can refId-link the bonus
    const cutoff = new Date(Date.now() - ELIGIBILITY_WINDOW_HOURS * 60 * 60 * 1000);
    const lastEarn = await prisma.transaction.findFirst({
      where: {
        userId: uid,
        type: { in: DOUBLER_ELIGIBLE_TYPES },
        amount: { gt: 0 },
        createdAt: { gte: cutoff },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, amount: true },
    });
    if (!lastEarn) {
      error(res, 'Last earn not found', 400);
      return;
    }

    const bonus = Math.min(lastEarn.amount, result.maxBonus);
    await creditCoins(
      uid,
      bonus,
      TransactionType.EARN_BONUS,
      lastEarn.id,
      `Coin Doubler 2× — bonus on ${bonus} coins`,
    );

    const newBalance = (await prisma.user.findUniqueOrThrow({
      where: { id: uid },
      select: { coinBalance: true },
    })).coinBalance;

    success(res, {
      credited: bonus,
      newBalance,
      todaysCount: result.todaysCount + 1,
      dailyLimit: result.dailyLimit,
    }, `+${bonus} coins from Coin Doubler!`);
  } catch (err) {
    logger.error('[CoinDoubler] claim error', err);
    error(res, 'Failed to claim coin doubler', 500);
  }
}
