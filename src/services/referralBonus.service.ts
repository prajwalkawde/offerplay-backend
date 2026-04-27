// Anti-fraud gate for referral signup bonuses.
//
// When ReferralSettings.minWithdrawForBonus > 0, the signup bonuses (referee's
// welcome bonus + referrer's "friend joined" bonus) are HELD as pending on the
// Referral row at signup time. They only convert into real coin credits once
// the referee has earned that many coins from real activity (offerwall, survey,
// daily bonus, etc. — but NOT from the welcome bonus or referral commissions
// themselves).
//
// This stops the most common fraud: bot signups that just scoop the welcome
// bonus and never engage. With a threshold of 500 coins (~₹5 of activity), a
// fraudster has to do real ad-watching / task work before getting paid — which
// makes the fraud unprofitable.

import { TransactionType } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

const ELIGIBLE_EARN_TYPES: TransactionType[] = [
  TransactionType.EARN_TASK,
  TransactionType.EARN_SURVEY,
  TransactionType.EARN_OFFERWALL,
  TransactionType.EARN_DAILY,
  TransactionType.EARN_STREAK,
  TransactionType.EARN_CONTEST_WIN,
  TransactionType.EARN_IPL_WIN,
];

/**
 * Check whether this user has a pending referral signup bonus and settle it
 * if their cumulative eligible earnings have crossed the threshold.
 *
 * Safe to call on every coin credit — fast-paths to no-op when:
 *   - The user has no Referral row (most users)
 *   - Their bonuses have already been settled
 *   - There's no threshold configured (legacy / disabled)
 *
 * Best-effort: any error is logged and swallowed so a settlement bug never
 * blocks the underlying coin credit that triggered it.
 */
export async function settlePendingReferralBonuses(referredId: string): Promise<void> {
  try {
    const referral = await prisma.referral.findUnique({
      where: { referredId },
      select: {
        id: true,
        referrerId: true,
        signupBonusPending: true,
        referrerBonusPending: true,
        bonusesSettledAt: true,
        status: true,
      },
    });

    if (!referral) return;                      // user wasn't referred
    if (referral.bonusesSettledAt) return;      // already settled
    if (referral.signupBonusPending === 0 && referral.referrerBonusPending === 0) {
      // No pending bonuses — also mark settled to skip future checks
      if (!referral.bonusesSettledAt) {
        await prisma.referral.update({
          where: { id: referral.id },
          data: { bonusesSettledAt: new Date(), status: 'active' },
        });
      }
      return;
    }

    const settings = await prisma.referralSettings.findFirst().catch(() => null);
    const threshold = settings?.minWithdrawForBonus ?? 0;

    if (threshold > 0) {
      // Sum eligible earnings (exclude welcome / referral types from threshold)
      const result = await prisma.transaction.aggregate({
        where: {
          userId: referredId,
          type: { in: ELIGIBLE_EARN_TYPES },
          amount: { gt: 0 },
        },
        _sum: { amount: true },
      });
      const earned = result._sum.amount ?? 0;
      if (earned < threshold) return; // not yet eligible
      logger.info('[ReferralBonus] threshold crossed, settling', {
        referredId, earned, threshold,
      });
    }

    // Settle: pay out both bonuses, mark settled, flip status to active
    await prisma.$transaction(async (tx) => {
      if (referral.signupBonusPending > 0) {
        await tx.user.update({
          where: { id: referredId },
          data: { coinBalance: { increment: referral.signupBonusPending } },
        });
        await tx.transaction.create({
          data: {
            userId: referredId,
            type: TransactionType.EARN_REFERRAL,
            amount: referral.signupBonusPending,
            description: 'Welcome bonus from referral (settled after activity)',
            status: 'completed',
          },
        });
      }

      if (referral.referrerBonusPending > 0) {
        await tx.user.update({
          where: { id: referral.referrerId },
          data: { coinBalance: { increment: referral.referrerBonusPending } },
        });
        await tx.transaction.create({
          data: {
            userId: referral.referrerId,
            type: TransactionType.EARN_REFERRAL,
            amount: referral.referrerBonusPending,
            description: 'Friend became active — your referral bonus',
            status: 'completed',
            refId: referral.id,
          },
        });
        await tx.referralCommission.create({
          data: {
            referralId: referral.id,
            referrerId: referral.referrerId,
            referredId,
            type: 'SIGNUP',
            amount: referral.referrerBonusPending,
            percentage: 100,
            sourceAmount: referral.referrerBonusPending,
            description: 'Friend signup bonus (settled after activity)',
            status: 'credited',
            creditedAt: new Date(),
          },
        });
        await tx.referral.update({
          where: { id: referral.id },
          data: {
            totalEarned:  { increment: referral.referrerBonusPending },
            coinsEarned:  { increment: referral.referrerBonusPending },
            lastActiveAt: new Date(),
          },
        });
      }

      await tx.referral.update({
        where: { id: referral.id },
        data: {
          signupBonusPending: 0,
          referrerBonusPending: 0,
          bonusesSettledAt: new Date(),
          status: 'active',
        },
      });
    });

    logger.info('[ReferralBonus] settled', {
      referredId,
      referrerId: referral.referrerId,
      refereeBonus: referral.signupBonusPending,
      referrerBonus: referral.referrerBonusPending,
    });
  } catch (err) {
    // Never throw — settlement bug must not block the coin credit that called us
    logger.error('[ReferralBonus] settlement failed', { err, referredId });
  }
}
