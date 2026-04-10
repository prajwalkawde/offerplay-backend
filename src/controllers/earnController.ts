import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { redis, rk } from '../config/redis';
import { success, error } from '../utils/response';
import { creditCoins } from '../services/coinService';
import { logger } from '../utils/logger';
import { TransactionType } from '@prisma/client';
import { getMergedFeed, autoBlacklist } from '../services/offerwallAggregator';
import Anthropic from '@anthropic-ai/sdk';
import { updateStreak } from '../services/postbackService';
import { qs } from '../utils/query';
import dayjs from 'dayjs';

// ─── Daily Bonus (existing) ───────────────────────────────────────────────────
export async function claimDailyBonus(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const today = dayjs().format('YYYY-MM-DD');
  const key = rk(`daily:${userId}:${today}`);

  const claimed = await redis.get(key);
  if (claimed) {
    error(res, 'Daily bonus already claimed today', 400);
    return;
  }

  const DAILY_COINS = 50;
  await creditCoins(userId, DAILY_COINS, TransactionType.EARN_DAILY, today, 'Daily login bonus');
  await redis.setex(key, 25 * 60 * 60, '1');

  success(res, { coins: DAILY_COINS }, `Daily bonus of ${DAILY_COINS} coins claimed!`);
}

// ─── Earn Options (existing) ──────────────────────────────────────────────────
export async function getEarnOptions(_req: Request, res: Response): Promise<void> {
  success(res, {
    daily: { coins: 50, description: 'Login daily' },
    referral: { coins: 200, description: 'Refer a friend' },
    offerwall: {
      providers: ['Pubscale', 'Torox', 'AyetStudios'],
      description: 'Complete offers and surveys',
    },
  });
}

// ─── Offerwall Token (existing) ───────────────────────────────────────────────
export async function getOfferwallToken(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const provider = req.params.provider as string;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true },
  });
  if (!user) { error(res, 'User not found', 404); return; }

  const token = Buffer.from(JSON.stringify({ userId, provider, ts: Date.now() })).toString('base64');
  success(res, { token, userId, provider });
}

// ─── GET /api/earn/offers ─────────────────────────────────────────────────────
export async function getOffers(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const gaid = qs(req.query.gaid) || '';
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim()) || req.ip || '';

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { language: true },
    });
    const language = user?.language || 'en';

    const offers = await getMergedFeed(userId, gaid, language, ip);
    success(res, { total: offers.length, offers });
  } catch (err) {
    logger.error('getOffers error:', { message: (err as Error).message });
    error(res, 'Failed to fetch offers', 500);
  }
}

// ─── POST /api/earn/offers/click ──────────────────────────────────────────────
export async function clickOffer(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const { offerId, provider, url } = req.body as {
      offerId?: string; provider?: string; url?: string;
    };

    if (!url) { error(res, 'URL required', 400); return; }

    if (offerId && provider) {
      try {
        await prisma.offerQualityScore.upsert({
          where: { provider_offerId: { provider, offerId } },
          update: { totalClicks: { increment: 1 }, lastSeenAt: new Date() },
          create: { provider, offerId, totalClicks: 1 },
        });
        await prisma.offerClick.create({ data: { userId, provider, offerId, ip: req.ip } });

        // Invalidate user's cached feed
        const keys = await redis.keys(rk(`offer_feed:${userId}:*`));
        if (keys.length > 0) await redis.del(...keys);
      } catch {
        // Non-critical — don't fail the click
      }
    }

    success(res, { redirectUrl: url });
  } catch (err) {
    error(res, 'Failed to track click', 500);
  }
}

// ─── POST /api/earn/offers/progress ──────────────────────────────────────────
export async function trackProgress(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const { offerId, provider, taskIndex, totalTasks, offerName, offerCoins } = req.body as {
      offerId: string; provider: string; taskIndex: number; totalTasks: number;
      offerName?: string; offerCoins?: number;
    };

    if (!offerId || taskIndex === undefined || !totalTasks) {
      error(res, 'offerId, taskIndex, totalTasks required', 400);
      return;
    }

    await prisma.offerProgress.upsert({
      where: { userId_offerId: { userId, offerId } },
      update: {
        tasksStarted: taskIndex + 1,
        totalTasks,
        isCompleted: taskIndex + 1 >= totalTasks,
        lastTaskAt: new Date(),
      },
      create: {
        userId, provider, offerId,
        offerName: offerName ?? null,
        offerCoins: offerCoins ?? 0,
        tasksStarted: taskIndex + 1,
        totalTasks,
        isCompleted: taskIndex + 1 >= totalTasks,
      },
    });

    await updateStreak(userId);

    success(res, {
      progress: `${taskIndex + 1}/${totalTasks}`,
      percent: Math.round(((taskIndex + 1) / Math.max(totalTasks, 1)) * 100),
    });
  } catch (err) {
    error(res, 'Failed to track progress', 500);
  }
}

// ─── GET /api/earn/offers/progress ───────────────────────────────────────────
export async function getProgress(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const inProgress = await prisma.offerProgress.findMany({
      where: { userId, isCompleted: false },
      orderBy: { lastTaskAt: 'desc' },
    });
    success(res, inProgress);
  } catch (err) {
    error(res, 'Failed to get progress', 500);
  }
}

// ─── POST /api/earn/offers/rate ───────────────────────────────────────────────
export async function rateOffer(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const { offerId, provider, rating } = req.body as {
      offerId: string; provider: string; rating: number;
    };

    if (!rating || rating < 1 || rating > 5) { error(res, 'Rating must be 1-5', 400); return; }
    if (!offerId || !provider) { error(res, 'offerId and provider required', 400); return; }

    await prisma.offerRating.upsert({
      where: { userId_offerId: { userId, offerId } },
      update: { rating },
      create: { userId, provider, offerId, rating },
    });

    const agg = await prisma.offerRating.aggregate({
      where: { offerId },
      _avg: { rating: true },
      _count: { rating: true },
    });
    const avgRating = agg._avg.rating ?? 0;
    const ratingCount = agg._count.rating ?? 0;

    await prisma.offerQualityScore.upsert({
      where: { provider_offerId: { provider, offerId } },
      update: { avgRating, ratingCount },
      create: { provider, offerId, avgRating, ratingCount },
    });

    if (avgRating < 2.0 && ratingCount >= 5) {
      await autoBlacklist(provider, offerId, `Low rating: ${avgRating.toFixed(2)} avg from ${ratingCount} users`);
    }

    // Invalidate cache
    const keys = await redis.keys(rk(`offer_feed:${userId}:*`));
    if (keys.length > 0) await redis.del(...keys);

    success(res, { avgRating: Math.round(avgRating * 100) / 100 });
  } catch (err) {
    error(res, 'Failed to rate offer', 500);
  }
}

// ─── POST /api/earn/offers/report-missing ────────────────────────────────────
export async function reportMissingCoins(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const { offerId, provider } = req.body as { offerId: string; provider: string };

    if (!offerId || !provider) { error(res, 'offerId and provider required', 400); return; }

    const record = await prisma.offerQualityScore.upsert({
      where: { provider_offerId: { provider, offerId } },
      update: { missingCoinReports: { increment: 1 } },
      create: { provider, offerId, missingCoinReports: 1 },
    });

    if (record.missingCoinReports >= 2) {
      await autoBlacklist(provider, offerId, `Missing coins x${record.missingCoinReports}`);
    }

    logger.warn('Missing coins reported', { userId, offerId, provider });
    success(res, null, 'Report received. We will investigate within 24 hours!');
  } catch (err) {
    error(res, 'Failed to report', 500);
  }
}

// ─── POST /api/earn/offers/report-dead ───────────────────────────────────────
export async function reportDeadUrl(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const { offerId, provider, finalUrl } = req.body as {
      offerId: string; provider: string; finalUrl?: string;
    };

    if (!offerId || !provider) { error(res, 'offerId and provider required', 400); return; }

    await autoBlacklist(provider, offerId,
      `Dead redirect: ${(finalUrl || '').substring(0, 200)}`);

    const keys = await redis.keys(rk(`offer_feed:${userId}:*`));
    if (keys.length > 0) await redis.del(...keys);

    success(res, null, 'Thank you for reporting! The offer has been flagged.');
  } catch (err) {
    error(res, 'Failed to report', 500);
  }
}

// ─── POST /api/earn/offers/enhance ───────────────────────────────────────────
export async function enhanceOffer(req: Request, res: Response): Promise<void> {
  try {
    const {
      offerId, provider, offerName,
      offerType, category, description, events,
    } = req.body as {
      offerId: string; provider: string; offerName: string;
      offerType?: string; category?: string; description?: string;
      events?: any[];
    };

    if (!offerId || !offerName) { error(res, 'offerId and offerName required', 400); return; }

    const cacheKey = rk(`enhanced_offer:${provider || 'unknown'}:${offerId}`);
    const cached = await redis.get(cacheKey);
    if (cached) { success(res, JSON.parse(cached)); return; }

    const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

    const prompt = `You are an expert at explaining mobile app offers to Indian users in simple, clear language.

OFFER DETAILS:
Name: ${offerName}
Type: ${offerType || 'CPA'} (CPI=install app, CPE=complete tasks, CPA=complete action)
Category: ${category || 'N/A'}
Description: ${description || offerName}
Existing Steps: ${JSON.stringify(events?.slice(0, 5) || [])}

Create clear, engaging steps for this offer.
For CPI: 1 step (install and open app)
For CPE: Use existing events, clean up instructions
For CPA: 2-4 steps based on description

Also create a 5-step guide on how to complete.

Return ONLY this JSON, no other text:
{
  "steps": [
    {
      "stepNumber": 1,
      "eventId": "step_1",
      "title": "Install the app",
      "description": "Download and install from Play Store",
      "coins": 150,
      "estimatedTime": "2-5 min",
      "tips": "Use WiFi for faster download",
      "callToAction": "Install Now",
      "status": "pending",
      "completed": false
    }
  ],
  "guide": [
    "Step 1: Open the offer link...",
    "Step 2: Install the app...",
    "Step 3: Complete the required action...",
    "Step 4: Return to OfferPlay...",
    "Step 5: Coins will be credited..."
  ]
}`;

    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    let result: { steps: any[]; guide: any[] };
    if (jsonMatch) {
      result = JSON.parse(jsonMatch[0]);
    } else {
      result = {
        steps: events?.length
          ? events.map((e: any, i: number) => ({
              stepNumber: i + 1,
              eventId: e.eventId || `step_${i + 1}`,
              title: e.eventName || e.callToAction || `Step ${i + 1}`,
              description: (e.instructions || e.eventName || '')
                .replace(/<[^>]*>/g, '').trim() || 'Complete this step',
              coins: e.coins || 0,
              estimatedTime: i === 0 ? '2-5 min' : '5-10 min',
              tips: 'Complete this step carefully',
              callToAction: e.callToAction || 'Continue',
              status: 'pending',
              completed: false,
            }))
          : [{
              stepNumber: 1,
              eventId: 'step_1',
              title: `Complete ${offerName}`,
              description: description || 'Follow the offer instructions',
              coins: 0,
              estimatedTime: '5-10 min',
              tips: 'Read all requirements before starting',
              callToAction: 'Start Now',
              status: 'pending',
              completed: false,
            }],
        guide: [
          `Tap "Start & Earn" to begin tracking`,
          `Complete the required action for ${offerName}`,
          `Return to OfferPlay after completion`,
          `Wait for verification (1-7 days)`,
          `Coins will be credited to your wallet`,
        ],
      };
    }

    await redis.setex(cacheKey, 86400, JSON.stringify(result));
    success(res, result);
  } catch (err) {
    logger.error('enhanceOffer error:', err);
    success(res, { steps: [], guide: [] });
  }
}

// ─── GET /api/earn/recent-coins?since=ISO_DATE ───────────────────────────────
export async function getRecentCoins(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const sinceRaw = req.query.since as string | undefined;
    const since = sinceRaw ? new Date(sinceRaw) : new Date(Date.now() - 10 * 60_000);

    const txns = await prisma.transaction.findMany({
      where: {
        userId,
        type: TransactionType.EARN_OFFERWALL,
        createdAt: { gte: since },
      },
      select: { amount: true, description: true, createdAt: true, refId: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const coinsEarned = txns.reduce((s, t) => s + t.amount, 0);
    success(res, { coinsEarned, count: txns.length, transactions: txns });
  } catch (err) {
    error(res, 'Failed to fetch recent coins', 500);
  }
}

// ─── GET /api/earn/surveys/history ───────────────────────────────────────────
export async function getSurveyHistory(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const surveys = await prisma.transaction.findMany({
      where: { userId, type: 'EARN_SURVEY' },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, amount: true, description: true, createdAt: true, refId: true },
    });
    success(res, surveys);
  } catch (err) {
    error(res, 'Failed to get survey history', 500);
  }
}

// ─── GET /api/earn/transactions ──────────────────────────────────────────────
export async function getTransactions(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const page = parseInt(String(req.query.page || '1'), 10);
    const limit = Math.min(parseInt(String(req.query.limit || '20'), 10), 50);
    const skip = (page - 1) * limit;

    // Fetch coin transactions and ticket transactions together
    const [coinTxs, ticketTxs] = await Promise.all([
      prisma.transaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        // Include refId so we can join RedemptionRequest for voucher details
        select: { id: true, type: true, amount: true, description: true, createdAt: true, status: true, refId: true },
      }),
      prisma.ticketTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, type: true, amount: true, description: true, createdAt: true },
      }),
    ]);

    // Enrich REDEEM coin transactions with voucher details from RedemptionRequest
    const redeemRefIds = coinTxs
      .filter(tx => tx.type.toString().includes('REDEEM') && tx.refId)
      .map(tx => tx.refId as string);

    let redemptionMap: Record<string, any> = {};
    if (redeemRefIds.length > 0) {
      const redemptions = await prisma.redemptionRequest.findMany({
        where: { id: { in: redeemRefIds } },
        select: {
          id: true,
          voucherCode: true,
          voucherLink: true,
          redeemUrl: true,
          productName: true,
          customFieldValues: true,
          status: true,
          failureReason: true,
          amountInr: true,
          type: true,
          mobileNumber: true,
          operator: true,
          gamePlayerId: true,
          upiId: true,
          accountNumber: true,
        },
      });
      redemptionMap = Object.fromEntries(redemptions.map(r => [r.id, r]));
    }

    const coinNormalised = coinTxs.map(tx => {
      const base = { ...tx, currency: 'coin' as const };
      if (!tx.type.toString().includes('REDEEM') || !tx.refId) return base;
      const r = redemptionMap[tx.refId];
      if (!r) return base;
      const cfv = (r.customFieldValues as any) || {};
      const rawCode = r.voucherCode || '';
      const isUrl   = rawCode.startsWith('http');
      return {
        ...base,
        voucherCode:      isUrl ? '' : rawCode,
        voucherPin:       cfv.pin      || undefined,
        voucherValidity:  cfv.validity || undefined,
        voucherLink:      isUrl ? rawCode : (r.voucherLink || undefined),
        redeemUrl:        isUrl ? rawCode : (r.redeemUrl   || undefined),
        productName:      r.productName    || undefined,
        redemptionStatus: r.status         || undefined,
        failureReason:    r.failureReason  || undefined,
        amountInr:        r.amountInr      || undefined,
        redemptionType:   r.type           || undefined,
        mobileNumber:     r.mobileNumber   || undefined,
        operator:         r.operator       || undefined,
        gamePlayerId:     r.gamePlayerId   || undefined,
        upiId:            r.upiId          || undefined,
        accountNumber:    r.accountNumber  || undefined,
        redemptionId:     r.id,
      };
    });

    // Normalise ticket records to match coin tx shape, tag with currency
    const ticketNormalised = ticketTxs.map(t => ({
      ...t,
      status: 'completed',
      currency: 'ticket' as const,
    }));

    // Merge and sort by date descending, then paginate
    const all = [...coinNormalised, ...ticketNormalised].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const total = all.length;
    const transactions = all.slice(skip, skip + limit);

    success(res, { transactions, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    error(res, 'Failed to get transactions', 500);
  }
}

// ─── GET /api/earn/referral ───────────────────────────────────────────────────
export async function getReferral(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const [user, referrals] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { referralCode: true, referralCount: true },
      }),
      prisma.referral.findMany({
        where: { referrerId: userId },
        select: { id: true, coinsEarned: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    if (!user) { error(res, 'User not found', 404); return; }

    const totalCoinsEarned = referrals.reduce((sum, r) => sum + r.coinsEarned, 0);

    success(res, {
      referralCode: user.referralCode,
      referralCount: user.referralCount,
      totalCoinsEarned,
      referrals,
    });
  } catch (err) {
    error(res, 'Failed to get referral info', 500);
  }
}

// ─── GET /api/earn/streak ─────────────────────────────────────────────────────
export async function getStreak(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const streak = await prisma.userStreak.findUnique({ where: { userId } });

    const current = streak?.currentStreak ?? 0;
    const milestones = [3, 7, 14, 30];
    const nextMilestone = milestones.find((m) => current < m) ?? 30;

    const getMultiplier = (n: number) => {
      if (n >= 30) return 3.0;
      if (n >= 14) return 2.5;
      if (n >= 7) return 2.0;
      if (n >= 3) return 1.5;
      return 1.0;
    };

    success(res, {
      currentStreak: current,
      longestStreak: streak?.longestStreak ?? 0,
      multiplier: streak?.multiplier ?? 1.0,
      lastActive: streak?.lastActive ?? null,
      nextMilestone: {
        days: nextMilestone,
        daysAway: nextMilestone - current,
        multiplier: getMultiplier(nextMilestone),
      },
    });
  } catch (err) {
    error(res, 'Failed to get streak', 500);
  }
}
