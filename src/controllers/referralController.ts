import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';

// ─── GET /api/referral/dashboard ──────────────────────────────────────────────
export const getReferralDashboard = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, referralCode: true, referralCount: true },
    });
    if (!user) { error(res, 'User not found', 404); return; }

    // Generate referral code if somehow missing
    let referralCode = user.referralCode;
    if (!referralCode) {
      referralCode = generateReferralCode(user.name || 'USER');
      await prisma.user.update({ where: { id: userId }, data: { referralCode } });
    }

    const [settings, referrals, commissions] = await Promise.all([
      prisma.referralSettings.findFirst().catch(() => null),
      prisma.referral.findMany({
        where: { referrerId: userId },
        include: { referred: { select: { id: true, name: true, createdAt: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.referralCommission.findMany({
        where: { referrerId: userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    const cfg = settings ?? {
      signupBonus: 100, referrerSignupBonus: 50,
      taskCommissionPct: 10, surveyCommissionPct: 10,
      offerwallCommissionPct: 10, contestWinCommissionPct: 5,
      isLifetimeCommission: true, maxReferrals: null,
    };

    const creditedComms = commissions.filter(c => c.status === 'credited');
    const pendingComms  = commissions.filter(c => c.status === 'pending');

    const startOfMonth = new Date();
    startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);

    const totalEarned = creditedComms.reduce((s, c) => s + c.amount, 0);
    const pending     = pendingComms.reduce((s, c) => s + c.amount, 0);
    const thisMonth   = creditedComms
      .filter(c => new Date(c.createdAt) >= startOfMonth)
      .reduce((s, c) => s + c.amount, 0);

    // Also include legacy coinsEarned from Referral records if commissions are empty
    const legacyTotal = commissions.length === 0
      ? referrals.reduce((s, r) => s + (r.coinsEarned || 0), 0)
      : 0;

    success(res, {
      referralCode,
      stats: {
        totalReferrals:  referrals.length,
        activeReferrals: referrals.filter(r => r.status === 'active').length,
        totalEarned:     totalEarned + legacyTotal,
        thisMonth,
        pending,
        paid: totalEarned,
      },
      settings: {
        signupBonus:             cfg.signupBonus,
        referrerSignupBonus:     cfg.referrerSignupBonus,
        taskCommissionPct:       cfg.taskCommissionPct,
        surveyCommissionPct:     cfg.surveyCommissionPct,
        offerwallCommissionPct:  cfg.offerwallCommissionPct,
        contestWinCommissionPct: cfg.contestWinCommissionPct,
        isLifetimeCommission:    cfg.isLifetimeCommission,
        maxReferrals:            cfg.maxReferrals,
      },
      referrals: referrals.map(r => ({
        id:         r.id,
        userId:     r.referredId,
        name:       maskName(r.referred.name || 'User'),
        avatar:     (r.referred.name?.charAt(0) || 'U').toUpperCase(),
        status:     r.status,
        totalEarned: r.totalEarned || r.coinsEarned || 0,
        joinedAt:   r.createdAt,
        daysAgo:    Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 86400000),
      })),
      commissions: commissions.map(c => ({
        id:          c.id,
        type:        c.type,
        amount:      c.amount,
        percentage:  c.percentage,
        description: c.description || getCommissionDesc(c),
        status:      c.status,
        createdAt:   c.createdAt,
      })),
    });
  } catch (err) {
    logger.error('getReferralDashboard error', { err });
    error(res, 'Failed to load referral data', 500);
  }
};

// ─── POST /api/referral/apply ──────────────────────────────────────────────────
export const applyReferralCode = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const { referralCode } = req.body as { referralCode: string };

    if (!referralCode?.trim()) { error(res, 'Referral code required', 400); return; }

    const referrer = await prisma.user.findUnique({
      where: { referralCode: referralCode.trim().toUpperCase() },
    });
    if (!referrer) { error(res, 'Invalid referral code', 400); return; }
    if (referrer.id === userId) { error(res, 'Cannot refer yourself', 400); return; }

    const existing = await prisma.referral.findUnique({ where: { referredId: userId } });
    if (existing) { error(res, 'You have already used a referral code', 400); return; }

    const settings = await prisma.referralSettings.findFirst().catch(() => null);
    const signupBonus  = settings?.signupBonus ?? 100;
    const referrerBonus = settings?.referrerSignupBonus ?? 50;

    await prisma.$transaction(async (tx) => {
      const referral = await tx.referral.create({
        data: { referrerId: referrer.id, referredId: userId, status: 'active' },
      });

      await tx.user.update({
        where: { id: referrer.id },
        data: { referralCount: { increment: 1 } },
      });
      await tx.user.update({
        where: { id: userId },
        data: { referredBy: referrer.id },
      });

      if (signupBonus > 0) {
        await tx.user.update({ where: { id: userId }, data: { coinBalance: { increment: signupBonus } } });
        await tx.transaction.create({
          data: { userId, type: 'EARN_REFERRAL', amount: signupBonus, description: 'Welcome bonus from referral', status: 'completed' },
        });
      }

      if (referrerBonus > 0) {
        await tx.user.update({ where: { id: referrer.id }, data: { coinBalance: { increment: referrerBonus } } });
        await tx.transaction.create({
          data: { userId: referrer.id, type: 'EARN_REFERRAL', amount: referrerBonus, description: 'Friend joined using your referral code', status: 'completed', refId: referral.id },
        });
        await tx.referralCommission.create({
          data: {
            referralId:   referral.id,
            referrerId:   referrer.id,
            referredId:   userId,
            type:         'SIGNUP',
            amount:       referrerBonus,
            percentage:   100,
            sourceAmount: referrerBonus,
            description:  'Friend signup bonus',
            status:       'credited',
            creditedAt:   new Date(),
          },
        });
        await tx.referral.update({
          where: { id: referral.id },
          data: { totalEarned: { increment: referrerBonus }, coinsEarned: { increment: referrerBonus } },
        });
      }
    });

    success(res, { signupBonus, referrerName: referrer.name },
      `Referral applied! You earned ${signupBonus} coins!`);
  } catch (err) {
    logger.error('applyReferralCode error', { err });
    error(res, 'Failed to apply referral code', 500);
  }
};

// ─── Internal: credit commission when referred user earns ─────────────────────
export const creditReferralCommission = async (
  userId: string,
  earnedAmount: number,
  type: 'TASK' | 'SURVEY' | 'OFFERWALL' | 'CONTEST',
): Promise<void> => {
  try {
    const referral = await prisma.referral.findFirst({
      where: { referredId: userId, status: 'active' },
    });
    if (!referral) return;

    const settings = await prisma.referralSettings.findFirst().catch(() => null);
    const pctMap = {
      TASK:      settings?.taskCommissionPct       ?? 10,
      SURVEY:    settings?.surveyCommissionPct      ?? 10,
      OFFERWALL: settings?.offerwallCommissionPct   ?? 10,
      CONTEST:   settings?.contestWinCommissionPct  ?? 5,
    };
    const pct = pctMap[type];
    const commission = Math.floor(earnedAmount * (pct / 100));
    if (commission <= 0) return;

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: referral.referrerId }, data: { coinBalance: { increment: commission } } });
      await tx.transaction.create({
        data: {
          userId: referral.referrerId,
          type: 'EARN_REFERRAL',
          amount: commission,
          description: `${pct}% of friend's ${type.toLowerCase()} (${commission} coins)`,
          status: 'completed',
          refId: referral.id,
        },
      });
      await tx.referralCommission.create({
        data: {
          referralId:   referral.id,
          referrerId:   referral.referrerId,
          referredId:   userId,
          type,
          amount:       commission,
          percentage:   pct,
          sourceAmount: earnedAmount,
          description:  `${pct}% of friend's ${type.toLowerCase()}`,
          status:       'credited',
          creditedAt:   new Date(),
        },
      });
      await tx.referral.update({
        where: { id: referral.id },
        data: {
          totalEarned:  { increment: commission },
          coinsEarned:  { increment: commission },
          lastActiveAt: new Date(),
        },
      });
    });
    logger.info(`Referral commission: ${commission} coins to ${referral.referrerId} for ${type}`);
  } catch (err) {
    logger.error('creditReferralCommission error', { err });
  }
};

// ─── GET /api/referral/milestones ─────────────────────────────────────────────
export const getMilestones = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;

    const [milestones, referralCount, claims] = await Promise.all([
      prisma.referralMilestone.findMany({ where: { isActive: true }, orderBy: { requiredReferrals: 'asc' } }),
      prisma.referral.count({ where: { referrerId: userId } }),
      prisma.referralMilestoneClaim.findMany({ where: { userId } }),
    ]);

    const claimMap = new Map(claims.map(c => [c.milestoneId, c]));

    success(res, {
      milestones: milestones.map(m => {
        const claim = claimMap.get(m.id);
        return {
          ...m,
          isUnlocked:   referralCount >= m.requiredReferrals,
          isClaimed:    !!claim,
          claimStatus:  claim?.status ?? null,
          progress:     Math.min(referralCount, m.requiredReferrals),
          progressPct:  Math.min((referralCount / m.requiredReferrals) * 100, 100),
        };
      }),
      currentReferrals: referralCount,
    });
  } catch (err) {
    logger.error('getMilestones error', { err });
    error(res, 'Failed to load milestones', 500);
  }
};

// ─── POST /api/referral/milestones/:id/claim ──────────────────────────────────
export const claimMilestone = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const id     = req.params.id as string;
    const { deliveryEmail, deliveryAddress } = req.body as { deliveryEmail?: string; deliveryAddress?: string };

    const milestone = await prisma.referralMilestone.findUnique({ where: { id } });
    if (!milestone) { error(res, 'Milestone not found', 404); return; }

    const existing = await prisma.referralMilestoneClaim.findUnique({
      where: { userId_milestoneId: { userId, milestoneId: id } },
    });
    if (existing) { error(res, 'Already claimed!', 400); return; }

    const referralCount = await prisma.referral.count({ where: { referrerId: userId } });
    if (referralCount < milestone.requiredReferrals) {
      error(res, `Need ${milestone.requiredReferrals} referrals, you have ${referralCount}`, 400);
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.referralMilestoneClaim.create({
        data: {
          userId,
          milestoneId: id,
          status:          milestone.rewardType === 'INVENTORY' ? 'pending' : 'claimed',
          deliveryAddress: deliveryAddress ?? null,
          deliveryEmail:   deliveryEmail   ?? null,
        },
      });

      if (milestone.rewardType === 'COINS' && milestone.rewardCoins) {
        await tx.user.update({ where: { id: userId }, data: { coinBalance: { increment: milestone.rewardCoins } } });
        await tx.transaction.create({
          data: {
            userId,
            type:        'REFERRAL_MILESTONE',
            amount:      milestone.rewardCoins,
            description: `Milestone: ${milestone.title}`,
            status:      'completed',
            refId:       id as string,
          },
        });
      }

      if (milestone.rewardType === 'TICKETS' && milestone.rewardTickets) {
        await tx.user.update({ where: { id: userId }, data: { ticketBalance: { increment: milestone.rewardTickets } } });
      }
    });

    const msg = milestone.rewardType === 'INVENTORY'
      ? 'Claim submitted! Admin will process your gift.'
      : `${milestone.title} reward claimed!`;

    success(res, {
      rewardType:    milestone.rewardType,
      rewardCoins:   milestone.rewardCoins,
      rewardTickets: milestone.rewardTickets,
      isPhysical:    milestone.rewardType === 'INVENTORY',
    }, msg);
  } catch (err) {
    logger.error('claimMilestone error', { err });
    error(res, 'Failed to claim milestone', 500);
  }
};

// ─── ADMIN: GET /api/referral/admin/claims ────────────────────────────────────
export const getAdminMilestoneClaims = async (_req: Request, res: Response): Promise<void> => {
  try {
    const claims = await prisma.referralMilestoneClaim.findMany({
      where:   { status: 'pending' },
      include: {
        user:      { select: { name: true, phone: true, coinBalance: true } },
        milestone: true,
      },
      orderBy: { claimedAt: 'desc' },
    });
    success(res, claims);
  } catch (err) {
    logger.error('getAdminMilestoneClaims error', { err });
    error(res, 'Failed', 500);
  }
};

// ─── ADMIN: PUT /api/referral/admin/claims/:id ────────────────────────────────
export const processAdminClaim = async (req: Request, res: Response): Promise<void> => {
  try {
    const id                     = req.params.id as string;
    const { status, adminNote }  = req.body as { status: string; adminNote?: string };

    const claim = await prisma.referralMilestoneClaim.update({
      where: { id },
      data:  {
        status,
        adminNote:   adminNote ?? null,
        completedAt: status === 'completed' ? new Date() : null,
      },
    });
    success(res, claim, 'Updated!');
  } catch (err) {
    logger.error('processAdminClaim error', { err });
    error(res, 'Failed', 500);
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateReferralCode(name: string): string {
  const clean = name.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'USER';
  const num = Math.floor(1000 + Math.random() * 9000);
  return `${clean}${num}`;
}

function maskName(name: string): string {
  return name.split(' ').map(p =>
    p.charAt(0).toUpperCase() + '*'.repeat(Math.max(p.length - 1, 2))
  ).join(' ');
}

function getCommissionDesc(c: { type: string; percentage: number; sourceAmount: number }): string {
  const map: Record<string, string> = {
    SIGNUP:    'New signup bonus',
    TASK:      `Task commission (${c.percentage}% of ${c.sourceAmount})`,
    SURVEY:    `Survey commission (${c.percentage}%)`,
    OFFERWALL: `Offerwall commission (${c.percentage}%)`,
    CONTEST:   `Contest win commission (${c.percentage}%)`,
  };
  return map[c.type] || c.type;
}
