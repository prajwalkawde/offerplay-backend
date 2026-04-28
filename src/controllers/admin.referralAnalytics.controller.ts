// Admin referral analytics — single endpoint that aggregates everything you'd
// want on a referral dashboard so the page renders in one fetch.
//
// All numbers are computed from the existing tables (Referral, ReferralCommission,
// Transaction, ReferralLink, User) — no new tables needed.

import { Request, Response } from 'express';
import { TransactionType } from '@prisma/client';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';

const DAY_MS = 24 * 60 * 60 * 1000;
const COIN_TO_INR = 1 / 100;  // 100 coins = ₹1

function periodStart(days: number | 'all'): Date | null {
  if (days === 'all') return null;
  return new Date(Date.now() - days * DAY_MS);
}

function tierForCount(active: number, settings: any): string {
  if (active >= (settings?.tierPlatinumMin ?? 100)) return 'PLATINUM';
  if (active >= (settings?.tierGoldMin     ?? 50))  return 'GOLD';
  if (active >= (settings?.tierSilverMin   ?? 10))  return 'SILVER';
  return 'BRONZE';
}

export async function getReferralAnalytics(req: Request, res: Response): Promise<void> {
  try {
    // ── Parse date range ───────────────────────────────────────────────
    const daysRaw = String(req.query.days ?? '30');
    const days: number | 'all' =
      daysRaw === 'all' ? 'all' : Math.max(1, Math.min(365, parseInt(daysRaw, 10) || 30));
    const since = periodStart(days);
    const sinceFilter = since ? { createdAt: { gte: since } } : {};
    const prevSince = since ? new Date(since.getTime() - (days as number) * DAY_MS) : null;

    const settings = await prisma.referralSettings.findFirst().catch(() => null);

    // ── Top-line stats: signups, active, paid out (this period + prior) ──
    const [signups, active, prevSignups, prevActive] = await Promise.all([
      prisma.referral.count({ where: { ...sinceFilter } }),
      prisma.referral.count({ where: { status: 'active', ...sinceFilter } }),
      prevSince
        ? prisma.referral.count({ where: { createdAt: { gte: prevSince, lt: since! } } })
        : Promise.resolve(0),
      prevSince
        ? prisma.referral.count({ where: { status: 'active', createdAt: { gte: prevSince, lt: since! } } })
        : Promise.resolve(0),
    ]);

    // Total paid = sum of EARN_REFERRAL transactions in period
    const paidAgg = await prisma.transaction.aggregate({
      where: { type: TransactionType.EARN_REFERRAL, status: 'completed', ...sinceFilter },
      _sum: { amount: true },
    });
    const totalPaidCoins = paidAgg._sum.amount ?? 0;

    const prevPaidAgg = prevSince
      ? await prisma.transaction.aggregate({
          where: { type: TransactionType.EARN_REFERRAL, status: 'completed', createdAt: { gte: prevSince, lt: since! } },
          _sum: { amount: true },
        })
      : { _sum: { amount: 0 } };
    const prevPaidCoins = prevPaidAgg._sum.amount ?? 0;

    // ── Funnel ──────────────────────────────────────────────────────────
    const linkAgg = await prisma.referralLink.aggregate({
      _sum: { clicks: true, installs: true, conversions: true },
    });
    const totalClicks = linkAgg._sum.clicks ?? 0;
    const allTimeSignups = await prisma.referral.count();
    const allTimeActive = await prisma.referral.count({ where: { status: 'active' } });
    // "Earning" = referees who generated commission in last 30 days
    const earningSet = await prisma.referralCommission.findMany({
      where: { status: 'credited', createdAt: { gte: new Date(Date.now() - 30 * DAY_MS) } },
      select: { referredId: true },
      distinct: ['referredId'],
    });

    // ── Time-series: daily signups + payouts over the selected window ───
    const seriesDays = days === 'all' ? 90 : (days as number);
    const seriesSince = new Date(Date.now() - seriesDays * DAY_MS);
    const [dailyReferrals, dailyPayouts] = await Promise.all([
      prisma.referral.findMany({
        where: { createdAt: { gte: seriesSince } },
        select: { createdAt: true, status: true },
      }),
      prisma.transaction.findMany({
        where: { type: TransactionType.EARN_REFERRAL, status: 'completed', createdAt: { gte: seriesSince } },
        select: { createdAt: true, amount: true },
      }),
    ]);
    const seriesMap = new Map<string, { signups: number; activeConverted: number; payout: number }>();
    for (let i = seriesDays - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY_MS);
      seriesMap.set(d.toISOString().slice(0, 10), { signups: 0, activeConverted: 0, payout: 0 });
    }
    for (const r of dailyReferrals) {
      const k = r.createdAt.toISOString().slice(0, 10);
      const v = seriesMap.get(k);
      if (v) {
        v.signups++;
        if (r.status === 'active') v.activeConverted++;
      }
    }
    for (const t of dailyPayouts) {
      const k = t.createdAt.toISOString().slice(0, 10);
      const v = seriesMap.get(k);
      if (v) v.payout += t.amount;
    }
    const timeSeries = Array.from(seriesMap.entries()).map(([date, v]) => ({ date, ...v }));

    // ── Tier distribution ──────────────────────────────────────────────
    // Group all referrers by their active referral count, then bucket by tier
    const byReferrer = await prisma.referral.groupBy({
      by: ['referrerId'],
      where: { status: 'active' },
      _count: true,
    });
    const tierCounts: Record<string, number> = { BRONZE: 0, SILVER: 0, GOLD: 0, PLATINUM: 0 };
    for (const r of byReferrer) {
      tierCounts[tierForCount(r._count, settings)]++;
    }

    // ── Top 20 referrers by lifetime commission ─────────────────────────
    const topReferrersAgg = await prisma.referralCommission.groupBy({
      by: ['referrerId'],
      where: { status: 'credited' },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 20,
    });
    const topReferrerIds = topReferrersAgg.map(r => r.referrerId);
    const topReferrerUsers = topReferrerIds.length
      ? await prisma.user.findMany({
          where: { id: { in: topReferrerIds } },
          select: { id: true, name: true, phone: true, email: true, referralCode: true, referralCount: true },
        })
      : [];
    const topReferrerActiveCounts = topReferrerIds.length
      ? await prisma.referral.groupBy({
          by: ['referrerId'],
          where: { referrerId: { in: topReferrerIds }, status: 'active' },
          _count: true,
        })
      : [];
    const activeMap = new Map(topReferrerActiveCounts.map(a => [a.referrerId, a._count]));
    const userMap = new Map(topReferrerUsers.map(u => [u.id, u]));
    const topReferrers = topReferrersAgg.map(r => {
      const u = userMap.get(r.referrerId);
      const activeCount = activeMap.get(r.referrerId) ?? 0;
      return {
        uid:           r.referrerId,
        name:          u?.name ?? null,
        phone:         u?.phone ?? null,
        email:         u?.email ?? null,
        referralCode:  u?.referralCode ?? null,
        totalReferrals: u?.referralCount ?? 0,
        activeReferrals: activeCount,
        totalEarned:    r._sum.amount ?? 0,
        tier:           tierForCount(activeCount, settings),
      };
    });

    // ── Top 20 friends generating most commission ───────────────────────
    const topFriendsAgg = await prisma.referralCommission.groupBy({
      by: ['referredId'],
      where: { status: 'credited' },
      _sum: { amount: true },
      orderBy: { _sum: { amount: 'desc' } },
      take: 20,
    });
    const topFriendIds = topFriendsAgg.map(r => r.referredId);
    const topFriendUsers = topFriendIds.length
      ? await prisma.user.findMany({
          where: { id: { in: topFriendIds } },
          select: { id: true, name: true, phone: true, email: true, referredBy: true, coinBalance: true },
        })
      : [];
    const friendUserMap = new Map(topFriendUsers.map(u => [u.id, u]));
    const topFriends = topFriendsAgg.map(r => {
      const u = friendUserMap.get(r.referredId);
      return {
        uid:                  r.referredId,
        name:                 u?.name ?? null,
        phone:                u?.phone ?? null,
        email:                u?.email ?? null,
        coinBalance:          u?.coinBalance ?? 0,
        referrerId:           u?.referredBy ?? null,
        commissionGenerated:  r._sum.amount ?? 0,
      };
    });

    // ── Pending bonus pool (anti-fraud holdback) ────────────────────────
    const pendingAgg = await prisma.referral.aggregate({
      where: { bonusesSettledAt: null },
      _sum: { signupBonusPending: true, referrerBonusPending: true },
      _count: true,
    });

    // ── Recent activity feed (last 20 events: signups + commissions) ────
    const [recentReferrals, recentCommissions] = await Promise.all([
      prisma.referral.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          referrer: { select: { name: true, phone: true, referralCode: true } },
          referred: { select: { name: true, phone: true } },
        },
      }),
      prisma.referralCommission.findMany({
        where: { status: 'credited' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);
    const recentCommUsers = recentCommissions.length
      ? await prisma.user.findMany({
          where: { id: { in: [...new Set([...recentCommissions.map(c => c.referrerId), ...recentCommissions.map(c => c.referredId)])] } },
          select: { id: true, name: true },
        })
      : [];
    const commUserMap = new Map(recentCommUsers.map(u => [u.id, u.name]));
    const recentActivity = [
      ...recentReferrals.map(r => ({
        kind:        'signup' as const,
        when:        r.createdAt,
        referrerName: r.referrer.name ?? r.referrer.referralCode ?? '—',
        referredName: r.referred.name ?? '—',
        amount:      r.signupBonusPending + r.referrerBonusPending,
        pending:     !r.bonusesSettledAt,
      })),
      ...recentCommissions.map(c => ({
        kind:         'commission' as const,
        when:         c.createdAt,
        referrerName: commUserMap.get(c.referrerId) ?? '—',
        referredName: commUserMap.get(c.referredId) ?? '—',
        amount:       c.amount,
        type:         c.type,
        percentage:   c.percentage,
      })),
    ].sort((a, b) => b.when.getTime() - a.when.getTime()).slice(0, 20);

    // ── Compose response ────────────────────────────────────────────────
    const conversionSignupToActive = signups > 0 ? active / signups : 0;
    const totalPaidInr = totalPaidCoins * COIN_TO_INR;
    const prevPaidInr = prevPaidCoins * COIN_TO_INR;
    const costPerActive = active > 0 ? totalPaidCoins / active : 0;

    success(res, {
      period: { days, since: since?.toISOString() ?? null },

      stats: {
        signups,
        active,
        totalPaidCoins,
        totalPaidInr,
        costPerActiveCoins: costPerActive,
        costPerActiveInr:   costPerActive * COIN_TO_INR,
        // Period-over-period deltas (% change). null when no prior data.
        signupsChange: prevSince && prevSignups > 0 ? ((signups - prevSignups) / prevSignups) * 100 : null,
        activeChange:  prevSince && prevActive  > 0 ? ((active  - prevActive)  / prevActive)  * 100 : null,
        paidChange:    prevSince && prevPaidCoins > 0 ? ((totalPaidCoins - prevPaidCoins) / prevPaidCoins) * 100 : null,
      },

      funnel: {
        clicks:   totalClicks,
        signups:  allTimeSignups,
        active:   allTimeActive,
        earning:  earningSet.length,
        // conversion percentages between adjacent stages
        clickToSignup: totalClicks > 0    ? (allTimeSignups / totalClicks) * 100 : 0,
        signupToActive: allTimeSignups > 0 ? (allTimeActive / allTimeSignups) * 100 : 0,
        activeToEarning: allTimeActive > 0 ? (earningSet.length / allTimeActive) * 100 : 0,
      },

      timeSeries,

      tierDistribution: [
        { tier: 'BRONZE',   count: tierCounts.BRONZE,   emoji: '🥉' },
        { tier: 'SILVER',   count: tierCounts.SILVER,   emoji: '🥈' },
        { tier: 'GOLD',     count: tierCounts.GOLD,     emoji: '🥇' },
        { tier: 'PLATINUM', count: tierCounts.PLATINUM, emoji: '💎' },
      ],

      topReferrers,
      topFriends,

      pending: {
        referralCount:        pendingAgg._count,
        signupBonusPending:   pendingAgg._sum.signupBonusPending ?? 0,
        referrerBonusPending: pendingAgg._sum.referrerBonusPending ?? 0,
        totalCoinsPending:    (pendingAgg._sum.signupBonusPending ?? 0) + (pendingAgg._sum.referrerBonusPending ?? 0),
      },

      recentActivity,

      // Period-over-period summary for at-a-glance insight
      summary: {
        signupsConvertingToActive: `${(conversionSignupToActive * 100).toFixed(1)}%`,
        avgPaidPerActive: Math.round(costPerActive),
      },
    });
  } catch (err) {
    logger.error('[ReferralAnalytics] error', err);
    error(res, 'Failed to load analytics', 500);
  }
}
