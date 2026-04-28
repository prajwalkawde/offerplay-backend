// Step 10 — LTV/CAC dashboard backend.
//
// Per-source breakdown of signups, retention, payout costs, plus admin-entered
// ad revenue and marketing spend. Outputs directional LTV/CAC ratios so admin
// can decide which acquisition channels to scale up vs kill.
//
// "Per-user" allocations are rough — without per-event source attribution we
// allocate ad revenue + offerwall margin proportionally to user count in
// each cohort. Real precision needs Branch/AppsFlyer integration; this is
// the v1 that gets you 80% of the answer with 0% of that integration cost.

import { Request, Response } from 'express';
import { Prisma, TransactionType } from '@prisma/client';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';

const DAY_MS = 24 * 60 * 60 * 1000;
const COIN_TO_INR = 1 / 100;

function startOfUtcDay(d: Date | string): Date {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}

// ─── GET /api/admin/analytics/ltv-cac?days=30 ────────────────────────────────

export async function getLtvCac(req: Request, res: Response): Promise<void> {
  try {
    const days = Math.max(1, Math.min(365, parseInt(String(req.query.days ?? '30'), 10) || 30));
    const since = new Date(Date.now() - days * DAY_MS);
    const sinceDay = startOfUtcDay(since);

    // ── Signups grouped by source (treats null as 'organic') ────────────
    const signupGroups = await prisma.user.groupBy({
      by: ['acquisitionSource'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });

    const sources = ['organic', 'referral', 'paid_fb', 'paid_google', 'paid_other'];
    const signupsBySource = new Map<string, number>(sources.map(s => [s, 0]));
    let totalSignups = 0;
    for (const g of signupGroups) {
      const src = g.acquisitionSource || 'organic';
      signupsBySource.set(src, (signupsBySource.get(src) ?? 0) + g._count._all);
      totalSignups += g._count._all;
    }

    // ── Active users (have any earning transaction in last 30d) per source ─
    const activeWindowStart = new Date(Date.now() - 30 * DAY_MS);
    const activeUsers = await prisma.transaction.findMany({
      where: {
        createdAt: { gte: activeWindowStart },
        type: { in: [
          TransactionType.EARN_TASK, TransactionType.EARN_SURVEY,
          TransactionType.EARN_OFFERWALL, TransactionType.EARN_DAILY,
          TransactionType.EARN_STREAK,
        ]},
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    const activeUidSet = new Set(activeUsers.map(u => u.userId));

    const activeBySource = new Map<string, number>(sources.map(s => [s, 0]));
    if (activeUidSet.size > 0) {
      const activeUsersWithSource = await prisma.user.findMany({
        where: { id: { in: Array.from(activeUidSet) }, createdAt: { gte: since } },
        select: { acquisitionSource: true },
      });
      for (const u of activeUsersWithSource) {
        const src = u.acquisitionSource || 'organic';
        activeBySource.set(src, (activeBySource.get(src) ?? 0) + 1);
      }
    }

    // ── Retention per source (D1, D7, D30) ──────────────────────────────
    // For each source, compute % of signups that had an earning event after
    // their joining date, within each window.
    async function retentionForSource(src: string, dayWindow: number): Promise<number> {
      const sourceFilter: Prisma.UserWhereInput['acquisitionSource'] = src === 'organic'
        ? { in: ['organic'] } as any  // null/undefined fall in 'organic' bucket via the post-filter below
        : src;
      const cohort = await prisma.user.findMany({
        where: {
          createdAt: { gte: since, lt: new Date(Date.now() - dayWindow * DAY_MS) },
          ...(src === 'organic'
              ? { OR: [{ acquisitionSource: 'organic' }, { acquisitionSource: null }] }
              : { acquisitionSource: src }),
        },
        select: { id: true, createdAt: true },
      });
      if (cohort.length === 0) return 0;
      const cohortIds = cohort.map(c => c.id);
      const retained = await prisma.transaction.findMany({
        where: {
          userId: { in: cohortIds },
          createdAt: { gte: new Date(Date.now() - dayWindow * DAY_MS) },
          type: { in: [
            TransactionType.EARN_TASK, TransactionType.EARN_SURVEY,
            TransactionType.EARN_OFFERWALL, TransactionType.EARN_DAILY,
            TransactionType.EARN_STREAK,
          ]},
        },
        select: { userId: true },
        distinct: ['userId'],
      });
      return (retained.length / cohort.length) * 100;
    }

    const retentionPromises = sources.map(async src => ({
      source: src,
      d1:  await retentionForSource(src, 1).catch(() => 0),
      d7:  await retentionForSource(src, 7).catch(() => 0),
      d30: await retentionForSource(src, 30).catch(() => 0),
    }));
    const retention = await Promise.all(retentionPromises);
    const retentionMap = new Map(retention.map(r => [r.source, r]));

    // ── Payout cost per source (signup bonuses + commissions paid out) ──
    // Sum EARN_REFERRAL and EARN_BONUS transactions for users in each source bucket.
    const payoutBySource = new Map<string, number>(sources.map(s => [s, 0]));
    const cohortUsers = await prisma.user.findMany({
      where: { createdAt: { gte: since } },
      select: { id: true, acquisitionSource: true },
    });
    const userToSource = new Map<string, string>();
    for (const u of cohortUsers) userToSource.set(u.id, u.acquisitionSource || 'organic');

    if (cohortUsers.length > 0) {
      const payouts = await prisma.transaction.groupBy({
        by: ['userId'],
        where: {
          userId: { in: cohortUsers.map(u => u.id) },
          type: { in: [TransactionType.EARN_REFERRAL, TransactionType.EARN_BONUS] },
          status: 'completed',
          amount: { gt: 0 },
        },
        _sum: { amount: true },
      });
      for (const p of payouts) {
        const src = userToSource.get(p.userId) || 'organic';
        payoutBySource.set(src, (payoutBySource.get(src) ?? 0) + (p._sum.amount ?? 0));
      }
    }

    // ── Marketing spend (per source, total in window) ───────────────────
    const spendRows = await prisma.marketingSpendDaily.findMany({
      where: { date: { gte: sinceDay } },
      orderBy: { date: 'desc' },
    });
    const spendBySource = new Map<string, number>();
    for (const s of spendRows) {
      spendBySource.set(s.source, (spendBySource.get(s.source) ?? 0) + s.amountInr);
    }
    const totalSpendInr = Array.from(spendBySource.values()).reduce((a, b) => a + b, 0);

    // ── Ad revenue (total in window — not source-attributable directly) ──
    const adRevRows = await prisma.adRevenueDaily.findMany({
      where: { date: { gte: sinceDay } },
      orderBy: { date: 'desc' },
    });
    const totalAdRevenueInr = adRevRows.reduce((s, r) => s + r.amountInr, 0);

    // ── Compose per-source rows ─────────────────────────────────────────
    const rows = sources.map(src => {
      const signups = signupsBySource.get(src) ?? 0;
      const active  = activeBySource.get(src)  ?? 0;
      const payoutCoins = payoutBySource.get(src) ?? 0;
      const payoutInr   = payoutCoins * COIN_TO_INR;
      const spendInr    = spendBySource.get(src) ?? 0;
      const ret = retentionMap.get(src);

      // Per-source LTV proxy: ad revenue allocated proportionally to active users
      const adRevAllocated = activeUidSet.size > 0
        ? (active / activeUidSet.size) * totalAdRevenueInr
        : 0;
      const netRevenue = adRevAllocated - payoutInr; // (offerwall margin not counted — would need provider data)
      const ltvPerUser = active > 0 ? netRevenue / active : 0;
      const cacPerUser = signups > 0 && spendInr > 0 ? spendInr / signups : null;
      const ltvCacRatio = cacPerUser !== null && cacPerUser > 0 ? ltvPerUser / cacPerUser : null;

      return {
        source: src,
        signups,
        active,
        retentionD1:  ret?.d1 ?? 0,
        retentionD7:  ret?.d7 ?? 0,
        retentionD30: ret?.d30 ?? 0,
        payoutCoins,
        payoutInr,
        spendInr,
        adRevenueAllocatedInr: adRevAllocated,
        ltvPerUser,
        cacPerUser,
        ltvCacRatio,
      };
    });

    // ── Aggregate summary ───────────────────────────────────────────────
    const totalActive = activeUidSet.size;
    const totalPayoutCoins = Array.from(payoutBySource.values()).reduce((a, b) => a + b, 0);
    const totalPayoutInr = totalPayoutCoins * COIN_TO_INR;
    const summary = {
      totalSignups,
      totalActive,
      totalPayoutCoins,
      totalPayoutInr,
      totalAdRevenueInr,
      totalSpendInr,
      netProfitInr: totalAdRevenueInr - totalPayoutInr - totalSpendInr,
      avgRevenuePerActive: totalActive > 0 ? totalAdRevenueInr / totalActive : 0,
      avgPayoutPerActive:  totalActive > 0 ? totalPayoutInr  / totalActive : 0,
    };

    // ── Health alerts ───────────────────────────────────────────────────
    const alerts: { severity: 'warn' | 'critical'; message: string }[] = [];
    for (const r of rows) {
      if (r.ltvCacRatio !== null && r.ltvCacRatio < 1) {
        alerts.push({ severity: 'critical', message: `${r.source}: LTV/CAC ${r.ltvCacRatio.toFixed(2)} — losing money on every user. Pause this channel.` });
      } else if (r.ltvCacRatio !== null && r.ltvCacRatio < 1.5) {
        alerts.push({ severity: 'warn', message: `${r.source}: LTV/CAC ${r.ltvCacRatio.toFixed(2)} — break-even. Optimize before scaling.` });
      }
    }

    success(res, {
      period: { days, since: since.toISOString() },
      bySource: rows,
      summary,
      alerts,
      marketingSpend: spendRows,
      adRevenue:      adRevRows,
    });
  } catch (err) {
    logger.error('[LTV/CAC] error', err);
    error(res, 'Failed to load LTV/CAC analytics', 500);
  }
}

// ─── Marketing spend / Ad revenue admin entry endpoints ──────────────────────

export async function upsertMarketingSpend(req: Request, res: Response): Promise<void> {
  try {
    const { date, source, amountInr, notes } = req.body as {
      date: string; source: string; amountInr: number; notes?: string;
    };
    if (!date || !source || typeof amountInr !== 'number') {
      error(res, 'date, source, amountInr required', 400);
      return;
    }
    const day = startOfUtcDay(date);
    const result = await prisma.marketingSpendDaily.upsert({
      where: { date_source: { date: day, source } },
      update: { amountInr, notes, createdBy: req.adminId },
      create: { date: day, source, amountInr, notes, createdBy: req.adminId },
    });
    success(res, result, 'Marketing spend saved');
  } catch (err) {
    logger.error('[LTV/CAC] upsertMarketingSpend error', err);
    error(res, 'Failed to save spend', 500);
  }
}

export async function deleteMarketingSpend(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params.id), 10);
    await prisma.marketingSpendDaily.delete({ where: { id } });
    success(res, null, 'Spend entry deleted');
  } catch (err) {
    logger.error('[LTV/CAC] deleteMarketingSpend error', err);
    error(res, 'Failed to delete entry', 500);
  }
}

export async function upsertAdRevenue(req: Request, res: Response): Promise<void> {
  try {
    const { date, amountInr, impressions, ecpm, notes } = req.body as {
      date: string; amountInr: number; impressions?: number; ecpm?: number; notes?: string;
    };
    if (!date || typeof amountInr !== 'number') {
      error(res, 'date, amountInr required', 400);
      return;
    }
    const day = startOfUtcDay(date);
    const result = await prisma.adRevenueDaily.upsert({
      where: { date: day },
      update: { amountInr, impressions, ecpm, notes, createdBy: req.adminId },
      create: { date: day, amountInr, impressions, ecpm, notes, createdBy: req.adminId },
    });
    success(res, result, 'Ad revenue saved');
  } catch (err) {
    logger.error('[LTV/CAC] upsertAdRevenue error', err);
    error(res, 'Failed to save ad revenue', 500);
  }
}

export async function deleteAdRevenue(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params.id), 10);
    await prisma.adRevenueDaily.delete({ where: { id } });
    success(res, null, 'Ad revenue entry deleted');
  } catch (err) {
    logger.error('[LTV/CAC] deleteAdRevenue error', err);
    error(res, 'Failed to delete entry', 500);
  }
}
