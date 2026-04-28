import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import { updateQuestProgress } from './questController';
import { sendFCMToUsers } from '../services/fcmService';

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

    const [settings, referrals, commissions, link, milestones] = await Promise.all([
      prisma.referralSettings.findFirst().catch(() => null),
      prisma.referral.findMany({
        where: { referrerId: userId },
        include: { referred: { select: { id: true, name: true, createdAt: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.referralCommission.findMany({
        where: { referrerId: userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.referralLink.findFirst({
        where: { userId },
        select: { clicks: true, installs: true, conversions: true },
      }).catch(() => null),
      prisma.referralMilestone.findMany({
        where: { isActive: true },
        orderBy: { requiredReferrals: 'asc' },
      }).catch(() => []),
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

    // ── Step 6: Current tier + next-tier progress ───────────────────────
    const { getReferrerTier } = await import('../services/referralTier.service');
    const tier = await getReferrerTier(userId);

    // ── Pipeline funnel: invited → signed up → active → earning ───────────
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const activeCount = referrals.filter(r => r.status === 'active').length;
    const earningRefereeIds = new Set(
      creditedComms
        .filter(c => new Date(c.createdAt) >= thirtyDaysAgo)
        .map(c => c.referredId),
    );
    const pipeline = {
      invited:  link?.clicks ?? 0,             // people who tapped your share link
      signedUp: referrals.length,              // total accounts created via your code
      active:   activeCount,                   // passed the 500-coin earning gate
      earning:  earningRefereeIds.size,        // earned commission for you in last 30d
    };

    // ── Top 5 friends by lifetime commission contribution ────────────────
    const friendCommission = new Map<string, number>();
    for (const c of creditedComms) {
      friendCommission.set(c.referredId, (friendCommission.get(c.referredId) ?? 0) + c.amount);
    }
    const topFriends = referrals
      .map(r => ({
        userId:     r.referredId,
        name:       maskName(r.referred.name || 'User'),
        avatar:     (r.referred.name?.charAt(0) || 'U').toUpperCase(),
        commission: friendCommission.get(r.referredId) ?? 0,
        joinedAt:   r.createdAt,
      }))
      .sort((a, b) => b.commission - a.commission)
      .slice(0, 5);

    // ── Last 30 days commission totals (per day) — sparkline data ─────────
    const dailyMap = new Map<string, number>();
    for (const c of creditedComms) {
      const created = new Date(c.createdAt);
      if (created < thirtyDaysAgo) continue;
      const day = created.toISOString().slice(0, 10); // YYYY-MM-DD
      dailyMap.set(day, (dailyMap.get(day) ?? 0) + c.amount);
    }
    const dailyLast30 = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(Date.now() - (29 - i) * 86400000);
      const key = d.toISOString().slice(0, 10);
      return { date: key, amount: dailyMap.get(key) ?? 0 };
    });

    // ── Next milestone progress (what they're working toward) ─────────────
    const nextMilestone = milestones.find(m => m.requiredReferrals > activeCount);
    const nextMilestoneInfo = nextMilestone ? {
      id:            nextMilestone.id,
      title:         nextMilestone.title,
      badgeEmoji:    nextMilestone.badgeEmoji,
      rewardType:    nextMilestone.rewardType,
      rewardCoins:   nextMilestone.rewardCoins,
      rewardTickets: nextMilestone.rewardTickets,
      itemName:      nextMilestone.itemName,
      required:      nextMilestone.requiredReferrals,
      currentCount:  activeCount,
      remaining:     Math.max(0, nextMilestone.requiredReferrals - activeCount),
      progress:      Math.min(1, activeCount / Math.max(1, nextMilestone.requiredReferrals)),
    } : null;

    success(res, {
      referralCode,
      stats: {
        totalReferrals:  referrals.length,
        activeReferrals: activeCount,
        totalEarned:     totalEarned + legacyTotal,
        thisMonth,
        pending,
        paid: totalEarned,
      },
      pipeline,
      tier,
      topFriends,
      dailyLast30,
      nextMilestone: nextMilestoneInfo,
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

// ─── GET /api/referral/code/check?code=XXX ────────────────────────────────────
// Real-time availability check for the vanity-code customizer. Lightweight —
// only validates format + checks uniqueness, does NOT claim.

export const checkVanityCode = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const raw = String(req.query.code || '');
    const { normalizeCode, validateFormat, checkAvailability } = await import('../services/vanityCode.service');
    const code = normalizeCode(raw);

    const fmt = validateFormat(code);
    if (!fmt.ok) {
      res.json({ success: true, data: { available: false, ...fmt } });
      return;
    }
    const available = await checkAvailability(code, userId);
    if (!available) {
      res.json({ success: true, data: { available: false, code: 'TAKEN', message: 'That code is already taken' } });
      return;
    }
    res.json({ success: true, data: { available: true, code: 'OK', message: 'Available!', normalized: code } });
  } catch (err) {
    logger.error('checkVanityCode error', err);
    res.status(500).json({ success: false, message: 'Failed to check code' });
  }
};

// ─── POST /api/referral/code  { code: 'RAHUL26' } ─────────────────────────────
// Claim/change the user's referral code. Server-validated end-to-end.

export const claimVanityCode = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;
    const { code: rawCode } = req.body as { code: string };
    if (!rawCode) { error(res, 'code is required', 400); return; }

    const { claimVanityCode } = await import('../services/vanityCode.service');
    const result = await claimVanityCode(userId, rawCode);

    if (result.ok) {
      success(res, {
        ok: true,
        code: rawCode.trim().toUpperCase(),
      }, result.message);
    } else {
      // 400 for client validation errors (bad format / taken / rate-limited)
      // so mobile catch blocks treat them like normal API errors.
      res.status(400).json({
        success: false,
        code: result.code,
        message: result.message,
        ...(result.daysUntilNextChange !== undefined && { daysUntilNextChange: result.daysUntilNextChange }),
      });
    }
  } catch (err) {
    logger.error('claimVanityCode error', err);
    error(res, 'Failed to update code', 500);
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
    const signupBonus   = settings?.signupBonus ?? 100;
    const referrerBonus = settings?.referrerSignupBonus ?? 50;
    const threshold     = settings?.minWithdrawForBonus ?? 0;
    // Anti-fraud: when threshold > 0, hold both bonuses as pending until the
    // referee earns enough from real activity to prove they aren't a bot.
    const delayPayout = threshold > 0;

    await prisma.$transaction(async (tx) => {
      const referral = await tx.referral.create({
        data: {
          referrerId: referrer.id,
          referredId: userId,
          status: delayPayout ? 'pending' : 'active',
          signupBonusPending:   delayPayout ? signupBonus   : 0,
          referrerBonusPending: delayPayout ? referrerBonus : 0,
        },
      });

      await tx.user.update({
        where: { id: referrer.id },
        data: { referralCount: { increment: 1 } },
      });
      await tx.user.update({
        where: { id: userId },
        data: { referredBy: referrer.id, acquisitionSource: 'referral' },
      });

      if (!delayPayout) {
        // Legacy immediate-credit path (when admin sets minWithdrawForBonus=0)
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
      }
      // delayPayout=true: bonuses sit as pending; settled by referralBonus.service
      // when the referee crosses the earnings threshold.
    });

    updateQuestProgress(referrer.id, 'REFER_FRIEND', 1).catch(() => {});

    // Step 8: Push referrer the moment a friend signs up. Fire-and-forget.
    if (settings?.enableSignupPush !== false) {
      const refereeName = (await prisma.user.findUnique({
        where: { id: userId }, select: { name: true },
      }))?.name ?? 'A friend';
      const pushTitle = '🎉 New referral!';
      const pushBody = delayPayout
        ? `${refereeName} just signed up using your code! Your bonus unlocks once they earn ${threshold} coins.`
        : `${refereeName} just signed up using your code! +${referrerBonus} coins added.`;
      sendFCMToUsers([referrer.id], pushTitle, pushBody, {
        type: 'referral_signup',
        referredName: refereeName,
        bonus: String(referrerBonus),
      }).catch(e => logger.warn('FCM referral_signup failed', e));
    }

    const message = delayPayout
      ? `Referral applied! Earn ${threshold} coins from offers/surveys to unlock your ${signupBonus}-coin welcome bonus.`
      : `Referral applied! You earned ${signupBonus} coins!`;
    success(res, {
      signupBonus,
      referrerName: referrer.name,
      bonusPending: delayPayout,
      threshold: delayPayout ? threshold : 0,
    }, message);
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

    // Step 6: Tier system overrides flat % when admin enabled it
    const { getEffectiveCommissionPct } = await import('../services/referralTier.service');
    const pct = await getEffectiveCommissionPct(referral.referrerId, type);
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

    // Step 8: Push referrer when a friend earns and they get commission. Throttled
    // to once-per-friend-per-day so we don't spam — multiple offers in one day
    // collapse into a single notification.
    try {
      const settings2 = await prisma.referralSettings.findFirst().catch(() => null);
      if (settings2?.enableCommissionPush !== false) {
        const dayBucket = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const dedupKey  = `referral_push_dedup:${referral.referrerId}:${userId}:${dayBucket}`;
        const { getRedisClient } = await import('../config/redis');
        const r = getRedisClient();
        // SET NX EX 24h — only first call of the day for this referrer+friend pair fires
        const setResult = await r.set(dedupKey, '1', 'EX', 24 * 60 * 60, 'NX').catch(() => null);
        if (setResult === 'OK') {
          const friendName = (await prisma.user.findUnique({
            where: { id: userId }, select: { name: true },
          }))?.name ?? 'Your friend';
          sendFCMToUsers([referral.referrerId], '💰 Friend earned for you!',
            `${friendName} just earned coins — you got +${commission} commission!`, {
            type: 'referral_commission',
            commission: String(commission),
            friendName,
          }).catch(e => logger.warn('FCM referral_commission failed', e));
        }
      }
    } catch (e) {
      logger.warn('commission push failed', e);
    }
  } catch (err) {
    logger.error('creditReferralCommission error', { err });
  }
};

// ─── GET /api/referral/leaderboard ────────────────────────────────────────────
// Step 7: top referrers by commission earned in the current week (Mon-Sun UTC).
// On-demand computation — no precomputed table or weekly cron in v1. When you
// have many referrers and DB load matters, swap to a materialized view + cron.

export const getLeaderboard = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;

    // "This week" = Monday 00:00 UTC of the current week
    const now = new Date();
    const day = now.getUTCDay() || 7; // 1=Mon..7=Sun
    const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (day - 1)));
    weekStart.setUTCHours(0, 0, 0, 0);

    // Aggregate this-week credited commissions per referrer
    const grouped = await prisma.referralCommission.groupBy({
      by: ['referrerId'],
      where: { status: 'credited', createdAt: { gte: weekStart } },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 50,
    });

    if (grouped.length === 0) {
      success(res, { weekStart, weekEnd: new Date(weekStart.getTime() + 7 * 86400000), entries: [], you: null });
      return;
    }

    // Hydrate user names
    const uids = grouped.map(g => g.referrerId);
    const users = await prisma.user.findMany({
      where: { id: { in: uids } },
      select: { id: true, name: true, referralCode: true },
    });
    const userMap = new Map(users.map(u => [u.id, u]));

    const entries = grouped.map((g, i) => {
      const user = userMap.get(g.referrerId);
      return {
        rank:     i + 1,
        uid:      g.referrerId,
        name:     maskName(user?.name || 'User'),
        avatar:   (user?.name?.charAt(0) || 'U').toUpperCase(),
        code:     user?.referralCode ?? null,
        weeklyCommission: g._sum.amount ?? 0,
        isYou:    g.referrerId === userId,
      };
    });

    // Caller's own rank/total even if outside top 50
    let you = entries.find(e => e.isYou) ?? null;
    if (!you) {
      const yourTotal = await prisma.referralCommission.aggregate({
        where: { referrerId: userId, status: 'credited', createdAt: { gte: weekStart } },
        _sum: { amount: true },
      });
      const yourSum = yourTotal._sum.amount ?? 0;
      if (yourSum > 0) {
        const ahead = await prisma.referralCommission.groupBy({
          by: ['referrerId'],
          where: { status: 'credited', createdAt: { gte: weekStart } },
          _sum: { amount: true },
          having: { amount: { _sum: { gt: yourSum } } },
        });
        you = {
          rank: ahead.length + 1,
          uid: userId,
          name: 'You',
          avatar: 'Y',
          code: null,
          weeklyCommission: yourSum,
          isYou: true,
        };
      }
    }

    success(res, {
      weekStart,
      weekEnd: new Date(weekStart.getTime() + 7 * 86400000),
      entries,
      you,
    });
  } catch (err) {
    logger.error('getLeaderboard error', { err });
    error(res, 'Failed to load leaderboard', 500);
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
