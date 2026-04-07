import { TransactionType } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface FraudSignal {
  code:        string;
  weight:      number;   // positive = bad, negative = good
  description: string;
}

export interface FraudCheckResult {
  score:         number;                       // 0–100 (higher = more suspicious)
  riskLevel:     'low' | 'medium' | 'high';
  requiresReview: boolean;                     // true if score >= REVIEW_THRESHOLD
  signals:       FraudSignal[];
  earnBreakdown: Record<string, number>;       // type → coin count
  accountAgeDays: number;
}

// ─── Configuration ─────────────────────────────────────────────────────────────

const REVIEW_THRESHOLD = 50;   // score >= this → hold for admin review

// Earn types considered "skill/game" (harder to fake)
const GAME_EARN_TYPES: TransactionType[] = [
  TransactionType.EARN_CONTEST_WIN,
  TransactionType.EARN_IPL_WIN,
  TransactionType.EARN_COIN_CONTEST,
  TransactionType.WIN_PRIZE,
  TransactionType.QUEST_REWARD,
];

// Earn types considered "offerwall/passive" (easier for bots to fake)
const OFFERWALL_EARN_TYPES: TransactionType[] = [
  TransactionType.EARN_TASK,
  TransactionType.EARN_SURVEY,
  TransactionType.EARN_OFFERWALL,
  TransactionType.ADJOE_BONUS,
];

// All earning types (excludes redeems, spends, admin)
const ALL_EARN_TYPES: TransactionType[] = [
  TransactionType.EARN_TASK,
  TransactionType.EARN_SURVEY,
  TransactionType.EARN_OFFERWALL,
  TransactionType.EARN_REFERRAL,
  TransactionType.EARN_BONUS,
  TransactionType.EARN_DAILY,
  TransactionType.EARN_STREAK,
  TransactionType.EARN_CONTEST_WIN,
  TransactionType.EARN_IPL_WIN,
  TransactionType.EARN_TICKET,
  TransactionType.EARN_COIN_CONTEST,
  TransactionType.WIN_PRIZE,
  TransactionType.QUEST_REWARD,
  TransactionType.ADJOE_BONUS,
  TransactionType.DAILY_QUEST_BONUS,
  TransactionType.REFERRAL_MILESTONE,
];

// ─── Main fraud check ──────────────────────────────────────────────────────────

export async function checkRedemptionFraud(
  userId:        string,
  coinsToRedeem: number,
  amountInr:     number,
): Promise<FraudCheckResult> {
  const signals: FraudSignal[] = [];
  const add = (code: string, weight: number, description: string) => {
    signals.push({ code, weight, description });
  };

  // ── Fetch data in parallel ────────────────────────────────────────────────

  const [user, earnTxs, completedRedemptions, todayRedemptionCount, pendingRedemptionCount] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { createdAt: true, coinBalance: true },
      }),
      prisma.transaction.findMany({
        where: { userId, type: { in: ALL_EARN_TYPES } },
        orderBy: { createdAt: 'asc' },
        select: { type: true, amount: true, createdAt: true },
      }),
      prisma.redemptionRequest.findMany({
        where: { userId, status: 'completed' },
        select: { id: true, createdAt: true, coinsRedeemed: true },
      }),
      prisma.redemptionRequest.count({
        where: {
          userId,
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
      prisma.redemptionRequest.count({
        where: { userId, status: 'pending' },
      }),
    ]);

  // ── Derived metrics ───────────────────────────────────────────────────────

  const accountAgeDays = user
    ? (Date.now() - user.createdAt.getTime()) / 86400000
    : 0;

  const totalEarned = earnTxs.reduce((s, t) => s + t.amount, 0);

  // Earn breakdown by type
  const earnBreakdown: Record<string, number> = {};
  for (const tx of earnTxs) {
    earnBreakdown[tx.type] = (earnBreakdown[tx.type] || 0) + tx.amount;
  }

  const uniqueSources  = new Set(earnTxs.map(t => t.type)).size;
  const offerwallCoins = earnTxs.filter(t => OFFERWALL_EARN_TYPES.includes(t.type)).reduce((s, t) => s + t.amount, 0);
  const gameCoins      = earnTxs.filter(t => GAME_EARN_TYPES.includes(t.type)).reduce((s, t) => s + t.amount, 0);

  // Earning burst: how quickly were the coins being redeemed accumulated?
  // Look only at the most recent transactions that sum up to coinsToRedeem
  let burstCoins = 0;
  let burstStart: Date | null = null;
  for (let i = earnTxs.length - 1; i >= 0 && burstCoins < coinsToRedeem; i--) {
    burstCoins += earnTxs[i].amount;
    burstStart  = earnTxs[i].createdAt;
  }
  const burstHours = burstStart
    ? (Date.now() - burstStart.getTime()) / 3600000
    : Infinity;

  // ── Signal evaluation ─────────────────────────────────────────────────────

  // 1. Account age
  if (accountAgeDays < 1) {
    add('NEW_ACCOUNT_24H', 35, 'Account created less than 24 hours ago');
  } else if (accountAgeDays < 3) {
    add('NEW_ACCOUNT_3D', 25, 'Account created less than 3 days ago');
  } else if (accountAgeDays < 7) {
    add('NEW_ACCOUNT_7D', 15, 'Account created less than 7 days ago');
  } else if (accountAgeDays >= 60) {
    add('VETERAN_ACCOUNT', -15, 'Account over 60 days old — established user');
  } else if (accountAgeDays >= 30) {
    add('MATURE_ACCOUNT', -10, 'Account over 30 days old');
  }

  // 2. No earning history at all
  if (earnTxs.length === 0) {
    add('NO_EARNINGS', 45, 'No earning transactions found — coins may be admin-credited');
  } else {
    // 3. Earning source diversity
    if (uniqueSources === 1) {
      add('SINGLE_SOURCE', 20, `All coins from a single earning type: ${[...new Set(earnTxs.map(t => t.type))][0]}`);
    } else if (uniqueSources >= 4) {
      add('DIVERSE_SOURCES', -15, `Coins earned from ${uniqueSources} different activity types`);
    }

    // 4. Earning burst — all redeemable coins accumulated very quickly
    if (burstHours < 2 && earnTxs.length >= 3) {
      add('BURST_2H', 30, `Coins being redeemed were all earned within ${burstHours.toFixed(1)} hours`);
    } else if (burstHours < 12 && earnTxs.length >= 5) {
      add('BURST_12H', 15, `Coins being redeemed were accumulated within ${burstHours.toFixed(1)} hours`);
    }

    // 5. Offerwall-only user (no game/skill activity)
    if (gameCoins === 0 && offerwallCoins > 0) {
      add('OFFERWALL_ONLY', 15, 'All coins from offerwall/tasks — no quiz or game contest activity');
    } else if (gameCoins > 0) {
      add('HAS_GAME_ACTIVITY', -10, 'User has genuine quiz/contest earnings');
    }

    // 6. Offerwall ratio
    if (totalEarned > 0 && offerwallCoins / totalEarned > 0.9) {
      add('HIGH_OFFERWALL_RATIO', 10, `${Math.round(offerwallCoins / totalEarned * 100)}% of coins are from passive offers`);
    }
  }

  // 7. Redemption today frequency
  if (todayRedemptionCount >= 5) {
    add('MANY_REDEEMS_TODAY', 35, `${todayRedemptionCount} redemption requests today`);
  } else if (todayRedemptionCount >= 3) {
    add('MULTIPLE_REDEEMS_TODAY', 15, `${todayRedemptionCount} redemption requests today`);
  }

  // 8. Already has pending redemptions (stacking)
  if (pendingRedemptionCount >= 2) {
    add('STACKED_PENDING', 20, `${pendingRedemptionCount} existing pending redemptions`);
  }

  // 9. Trusted redeemer history
  if (completedRedemptions.length >= 5) {
    add('TRUSTED_REDEEMER', -25, `${completedRedemptions.length} previous completed redemptions`);
  } else if (completedRedemptions.length >= 2) {
    add('RETURNING_REDEEMER', -15, `${completedRedemptions.length} previous successful redemptions`);
  } else if (completedRedemptions.length === 0 && amountInr >= 100) {
    add('FIRST_HIGH_VALUE', 15, `First ever redemption for ₹${amountInr}`);
  }

  // 10. Redeeming nearly all lifetime earnings at once
  if (totalEarned > 0) {
    const redeemRatio = coinsToRedeem / totalEarned;
    if (redeemRatio > 0.95 && totalEarned > 500) {
      add('REDEEM_ALL_COINS', 10, `Redeeming ${Math.round(redeemRatio * 100)}% of all ever-earned coins at once`);
    }
  }

  // ── Final score ───────────────────────────────────────────────────────────

  const rawScore = signals.reduce((sum, s) => sum + s.weight, 0);
  const score    = Math.max(0, Math.min(100, rawScore));

  const riskLevel: 'low' | 'medium' | 'high' =
    score >= 60 ? 'high' : score >= 35 ? 'medium' : 'low';

  const requiresReview = score >= REVIEW_THRESHOLD;

  logger.info(
    `[FraudCheck] user=${userId} score=${score} risk=${riskLevel} ` +
    `signals=[${signals.map(s => s.code).join(',')}]`
  );

  return { score, riskLevel, requiresReview, signals, earnBreakdown, accountAgeDays };
}
