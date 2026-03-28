import { prisma } from '../config/database';
import { creditCoins } from './coinService';
import { TransactionType } from '@prisma/client';
import { logger } from '../utils/logger';

const REFERRER_BONUS = 200;
const REFERRED_BONUS = 100;

export async function processReferral(newUserId: string, referralCode: string): Promise<void> {
  const referrer = await prisma.user.findUnique({
    where: { referralCode },
    select: { id: true, status: true },
  });

  if (!referrer || referrer.status !== 'ACTIVE') {
    logger.debug('Invalid referral code', { referralCode });
    return;
  }

  if (referrer.id === newUserId) {
    logger.debug('Self-referral attempt blocked', { userId: newUserId });
    return;
  }

  // Idempotent — one referral per new user
  const existing = await prisma.referral.findUnique({ where: { referredId: newUserId } });
  if (existing) return;

  await prisma.referral.create({
    data: {
      referrerId: referrer.id,
      referredId: newUserId,
      coinsEarned: REFERRER_BONUS,
      status: 'active',
    },
  });

  await Promise.all([
    creditCoins(referrer.id, REFERRER_BONUS, TransactionType.EARN_REFERRAL, newUserId, 'Referral bonus'),
    creditCoins(newUserId, REFERRED_BONUS, TransactionType.EARN_REFERRAL, referrer.id, 'Joined via referral'),
  ]);

  logger.info('Referral processed', { referrerId: referrer.id, referredId: newUserId });
}

export async function getReferrals(
  userId: string,
  limit = 20,
  page = 1
): Promise<{ referrals: unknown[]; total: number }> {
  const skip = (page - 1) * limit;
  const where = { referrerId: userId };

  const [referrals, total] = await Promise.all([
    prisma.referral.findMany({
      where,
      include: { referred: { select: { id: true, name: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.referral.count({ where }),
  ]);

  return { referrals, total };
}
