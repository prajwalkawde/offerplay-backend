import { Request, Response } from 'express';
import { TransactionType } from '@prisma/client';
import axios from 'axios';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import { creditCoins } from '../services/coinService';
import { autoBlacklist } from '../services/offerwallAggregator';
import { qs } from '../utils/query';
import { env } from '../config/env';

// ─── GET /api/admin/offerwall/offers ─────────────────────────────────────────
export async function listOfferwallOffers(req: Request, res: Response): Promise<void> {
  return getAdminOffers(req, res);
}

export async function getAdminOffers(req: Request, res: Response): Promise<void> {
  try {
    const provider = qs(req.query.provider);
    const status = qs(req.query.status);
    const page = parseInt(qs(req.query.page) ?? '1', 10);
    const limit = Math.min(parseInt(qs(req.query.limit) ?? '50', 10), 200);
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (provider && provider !== 'all') where.provider = provider;
    if (status === 'active') { where.isActive = true; where.isBlacklisted = false; }
    if (status === 'blacklisted') where.isBlacklisted = true;

    const [offers, total] = await Promise.all([
      prisma.offerQualityScore.findMany({
        where,
        orderBy: { qualityScore: 'desc' },
        skip,
        take: limit,
      }),
      prisma.offerQualityScore.count({ where }),
    ]);

    success(res, { offers, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    logger.error('getAdminOffers error:', err);
    error(res, 'Failed to get offers', 500);
  }
}

// ─── GET /api/admin/offerwall/live-offers ─────────────────────────────────────
export async function fetchLiveOffersForAdmin(req: Request, res: Response): Promise<void> {
  try {
    if (!env.PUBSCALE_APP_ID || !env.PUBSCALE_PUB_KEY) {
      error(res, 'PubScale credentials not configured', 400);
      return;
    }

    const response = await axios.post(
      'https://api-ow.pubscale.com/v1/offer/api',
      {
        page: 1,
        size: 100,
        filt: [{ dim: 'platform', match: { type: 'any', value: ['android'] } }],
      },
      {
        headers: {
          'App-Id': env.PUBSCALE_APP_ID,
          'Pub-Key': env.PUBSCALE_PUB_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const offers = (response.data?.offers || []) as Array<Record<string, unknown>>;
    const normalized = offers.slice(0, 100).map((o) => ({
      offerId: String(o.id),
      offerName: o.name,
      provider: 'pubscale',
      coins: Math.round((o.inapp_pyt as Record<string, unknown>)?.amt as number || 0),
      payoutUsd: parseFloat(String((o.pyt as Record<string, unknown>)?.amt || '0')),
      offType: o.off_type,
      qualityScore: 50,
      isActive: true,
      isBlacklisted: false,
      totalClicks: 0,
      totalCompletions: 0,
      completionRate: 0,
      avgRating: 0,
    }));

    success(res, { offers: normalized, total: normalized.length });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logger.error('fetchLiveOffersForAdmin error:', err);
    error(res, `Failed to fetch from PubScale: ${msg}`, 500);
  }
}

// ─── POST /api/admin/offerwall/blacklist ──────────────────────────────────────
export async function blacklistOffer(req: Request, res: Response): Promise<void> {
  const { provider, offerId, reason } = req.body as {
    provider: string; offerId: string; reason?: string;
  };

  if (!provider || !offerId) { error(res, 'provider and offerId required', 400); return; }

  await autoBlacklist(provider, offerId, reason || 'Manual admin blacklist');
  logger.info('Offer manually blacklisted', { provider, offerId, reason });
  success(res, null, 'Offer blacklisted and feed cache will refresh on next request');
}

// ─── POST /api/admin/offerwall/whitelist ──────────────────────────────────────
export async function whitelistOffer(req: Request, res: Response): Promise<void> {
  const { provider, offerId } = req.body as { provider: string; offerId: string };

  if (!provider || !offerId) { error(res, 'provider and offerId required', 400); return; }

  await prisma.offerQualityScore.upsert({
    where: { provider_offerId: { provider, offerId } },
    update: { isBlacklisted: false, isActive: true, blacklistReason: null },
    create: { provider, offerId, isBlacklisted: false, isActive: true },
  });

  logger.info('Offer whitelisted', { provider, offerId });
  success(res, null, 'Offer removed from blacklist');
}

// ─── GET /api/admin/offerwall/quality-report ──────────────────────────────────
export async function getQualityReport(req: Request, res: Response): Promise<void> {
  const tab = qs(req.query.tab) || 'best';

  let offers: any[];

  switch (tab) {
    case 'best':
      offers = await prisma.offerQualityScore.findMany({
        where: { isBlacklisted: false, isActive: true, totalClicks: { gt: 0 } },
        orderBy: { completionRate: 'desc' },
        take: 50,
      });
      break;
    case 'worst':
      offers = await prisma.offerQualityScore.findMany({
        where: { isBlacklisted: false, totalClicks: { gte: 5 } },
        orderBy: { completionRate: 'asc' },
        take: 50,
      });
      break;
    case 'blacklisted':
      offers = await prisma.offerQualityScore.findMany({
        where: { isBlacklisted: true },
        orderBy: { updatedAt: 'desc' },
      });
      break;
    case 'dead':
      offers = await prisma.offerQualityScore.findMany({
        where: { totalClicks: { gte: 20 }, totalCompletions: 0, isBlacklisted: false },
        orderBy: { totalClicks: 'desc' },
      });
      break;
    default:
      offers = [];
  }

  success(res, { tab, total: offers.length, offers });
}

// ─── GET /api/admin/offerwall/postback-logs ───────────────────────────────────
export async function getPostbackLogs(req: Request, res: Response): Promise<void> {
  const provider = qs(req.query.provider);
  const userId = qs(req.query.userId);
  const date = qs(req.query.date);
  const page = parseInt(qs(req.query.page) ?? '1', 10);
  const limit = Math.min(parseInt(qs(req.query.limit) ?? '50', 10), 100);
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (provider) where.provider = provider;
  if (userId) where.userId = userId;
  if (date) {
    const start = new Date(date);
    const end = new Date(date);
    end.setDate(end.getDate() + 1);
    where.createdAt = { gte: start, lt: end };
  }

  const [logs, total] = await Promise.all([
    prisma.offerwallLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.offerwallLog.count({ where }),
  ]);

  success(res, { logs, total, page, pages: Math.ceil(total / limit) });
}

// ─── GET /api/admin/offerwall/retry-queue ────────────────────────────────────
export async function getRetryQueue(req: Request, res: Response): Promise<void> {
  const page = parseInt(qs(req.query.page) ?? '1', 10);
  const limit = Math.min(parseInt(qs(req.query.limit) ?? '50', 10), 100);

  const [pending, resolved, total] = await Promise.all([
    prisma.postbackRetryQueue.findMany({
      where: { resolvedAt: null, attempts: { lt: 3 } },
      orderBy: { nextRetry: 'asc' },
      take: limit,
      skip: (page - 1) * limit,
    }),
    prisma.postbackRetryQueue.count({ where: { resolvedAt: { not: null } } }),
    prisma.postbackRetryQueue.count(),
  ]);

  const failed = await prisma.postbackRetryQueue.count({
    where: { resolvedAt: null, attempts: { gte: 3 } },
  });

  success(res, {
    pending,
    stats: { total, resolved, failed, pendingCount: total - resolved - failed },
    page,
  });
}

// ─── POST /api/admin/offerwall/manual-credit ─────────────────────────────────
export async function manualCredit(req: Request, res: Response): Promise<void> {
  const { userId, coins, reason } = req.body as {
    userId: string; coins: number; reason?: string;
  };

  if (!userId || !coins || coins <= 0) { error(res, 'userId and coins (>0) required', 400); return; }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, coinBalance: true },
  });
  if (!user) { error(res, 'User not found', 404); return; }

  await creditCoins(
    userId,
    coins,
    TransactionType.EARN_BONUS,
    `admin_manual_${Date.now()}`,
    reason || 'Admin manual credit'
  );

  logger.info('Admin manual credit', { userId, coins, reason });
  success(res, { userId, coinsAdded: coins, newBalance: user.coinBalance + coins }, 'Coins credited successfully');
}

// ─── GET /api/admin/offerwall/stats ──────────────────────────────────────────
export async function getOfferwallStats(_req: Request, res: Response): Promise<void> {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalOffers, activeOffers, blacklisted, todayRevenue, providerStats, topOffers] = await Promise.all([
      prisma.offerQualityScore.count(),
      prisma.offerQualityScore.count({ where: { isActive: true, isBlacklisted: false } }),
      prisma.offerQualityScore.count({ where: { isBlacklisted: true } }),
      prisma.offerwallLog.aggregate({
        where: { createdAt: { gte: today } },
        _sum: { coinsAwarded: true },
      }),
      prisma.offerwallLog.groupBy({
        by: ['provider'],
        _sum: { coinsAwarded: true },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),
      prisma.offerQualityScore.findMany({
        where: { isBlacklisted: false },
        orderBy: { totalCompletions: 'desc' },
        take: 10,
        select: { provider: true, offerId: true, offerName: true, totalCompletions: true, completionRate: true, avgRating: true },
      }),
    ]);

    success(res, {
      totalOffers,
      activeOffers,
      blacklisted,
      todayRevenue: todayRevenue._sum.coinsAwarded || 0,
      byProvider: providerStats.map((p) => ({
        provider: p.provider,
        completions: p._count.id,
        coinsAwarded: p._sum.coinsAwarded ?? 0,
      })),
      topOffers,
    });
  } catch (err) {
    logger.error('getOfferwallStats error:', err);
    error(res, 'Failed to get offerwall stats', 500);
  }
}


// ─── GET /api/admin/surveys/stats ────────────────────────────────────────────
export async function getSurveyStats(req: Request, res: Response): Promise<void> {
  try {
    const surveyLogs = await prisma.offerwallLog.findMany({
      where: { provider: 'cpx' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const totalCompleted = surveyLogs.length;
    const totalCoins = surveyLogs.reduce((sum, l) => sum + (l.coinsAwarded || 0), 0);
    const todayStr = new Date().toDateString();
    const todayLogs = surveyLogs.filter((l) => new Date(l.createdAt).toDateString() === todayStr);

    success(res, {
      totalCompleted,
      totalCoins,
      todayCompleted: todayLogs.length,
      todayCoins: todayLogs.reduce((s, l) => s + (l.coinsAwarded || 0), 0),
    });
  } catch (err) {
    error(res, 'Failed to get survey stats', 500);
  }
}
