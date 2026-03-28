"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.claimDailyBonus = claimDailyBonus;
exports.getEarnOptions = getEarnOptions;
exports.getOfferwallToken = getOfferwallToken;
exports.getOffers = getOffers;
exports.clickOffer = clickOffer;
exports.trackProgress = trackProgress;
exports.getProgress = getProgress;
exports.rateOffer = rateOffer;
exports.reportMissingCoins = reportMissingCoins;
exports.reportDeadUrl = reportDeadUrl;
exports.enhanceOffer = enhanceOffer;
exports.getTransactions = getTransactions;
exports.getReferral = getReferral;
exports.getStreak = getStreak;
const database_1 = require("../config/database");
const redis_1 = require("../config/redis");
const response_1 = require("../utils/response");
const coinService_1 = require("../services/coinService");
const logger_1 = require("../utils/logger");
const client_1 = require("@prisma/client");
const offerwallAggregator_1 = require("../services/offerwallAggregator");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const postbackService_1 = require("../services/postbackService");
const query_1 = require("../utils/query");
const dayjs_1 = __importDefault(require("dayjs"));
// ─── Daily Bonus (existing) ───────────────────────────────────────────────────
async function claimDailyBonus(req, res) {
    const userId = req.userId;
    const today = (0, dayjs_1.default)().format('YYYY-MM-DD');
    const key = `daily:${userId}:${today}`;
    const claimed = await redis_1.redis.get(key);
    if (claimed) {
        (0, response_1.error)(res, 'Daily bonus already claimed today', 400);
        return;
    }
    const DAILY_COINS = 50;
    await (0, coinService_1.creditCoins)(userId, DAILY_COINS, client_1.TransactionType.EARN_DAILY, today, 'Daily login bonus');
    await redis_1.redis.setex(key, 25 * 60 * 60, '1');
    (0, response_1.success)(res, { coins: DAILY_COINS }, `Daily bonus of ${DAILY_COINS} coins claimed!`);
}
// ─── Earn Options (existing) ──────────────────────────────────────────────────
async function getEarnOptions(_req, res) {
    (0, response_1.success)(res, {
        daily: { coins: 50, description: 'Login daily' },
        referral: { coins: 200, description: 'Refer a friend' },
        offerwall: {
            providers: ['Pubscale', 'Torox', 'AyetStudios'],
            description: 'Complete offers and surveys',
        },
    });
}
// ─── Offerwall Token (existing) ───────────────────────────────────────────────
async function getOfferwallToken(req, res) {
    const userId = req.userId;
    const provider = req.params.provider;
    const user = await database_1.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true },
    });
    if (!user) {
        (0, response_1.error)(res, 'User not found', 404);
        return;
    }
    const token = Buffer.from(JSON.stringify({ userId, provider, ts: Date.now() })).toString('base64');
    (0, response_1.success)(res, { token, userId, provider });
}
// ─── GET /api/earn/offers ─────────────────────────────────────────────────────
async function getOffers(req, res) {
    try {
        const userId = req.userId;
        const gaid = (0, query_1.qs)(req.query.gaid) || '';
        const ip = req.ip || '';
        const user = await database_1.prisma.user.findUnique({
            where: { id: userId },
            select: { language: true },
        });
        const language = user?.language || 'en';
        const offers = await (0, offerwallAggregator_1.getMergedFeed)(userId, gaid, language, ip);
        (0, response_1.success)(res, { total: offers.length, offers });
    }
    catch (err) {
        logger_1.logger.error('getOffers error:', { message: err.message });
        (0, response_1.error)(res, 'Failed to fetch offers', 500);
    }
}
// ─── POST /api/earn/offers/click ──────────────────────────────────────────────
async function clickOffer(req, res) {
    try {
        const userId = req.userId;
        const { offerId, provider, url } = req.body;
        if (!url) {
            (0, response_1.error)(res, 'URL required', 400);
            return;
        }
        if (offerId && provider) {
            try {
                await database_1.prisma.offerQualityScore.upsert({
                    where: { provider_offerId: { provider, offerId } },
                    update: { totalClicks: { increment: 1 }, lastSeenAt: new Date() },
                    create: { provider, offerId, totalClicks: 1 },
                });
                await database_1.prisma.offerClick.create({ data: { userId, provider, offerId, ip: req.ip } });
                // Invalidate user's cached feed
                const keys = await redis_1.redis.keys(`offer_feed:${userId}:*`);
                if (keys.length > 0)
                    await redis_1.redis.del(...keys);
            }
            catch {
                // Non-critical — don't fail the click
            }
        }
        (0, response_1.success)(res, { redirectUrl: url });
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to track click', 500);
    }
}
// ─── POST /api/earn/offers/progress ──────────────────────────────────────────
async function trackProgress(req, res) {
    try {
        const userId = req.userId;
        const { offerId, provider, taskIndex, totalTasks, offerName, offerCoins } = req.body;
        if (!offerId || taskIndex === undefined || !totalTasks) {
            (0, response_1.error)(res, 'offerId, taskIndex, totalTasks required', 400);
            return;
        }
        await database_1.prisma.offerProgress.upsert({
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
        await (0, postbackService_1.updateStreak)(userId);
        (0, response_1.success)(res, {
            progress: `${taskIndex + 1}/${totalTasks}`,
            percent: Math.round(((taskIndex + 1) / Math.max(totalTasks, 1)) * 100),
        });
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to track progress', 500);
    }
}
// ─── GET /api/earn/offers/progress ───────────────────────────────────────────
async function getProgress(req, res) {
    try {
        const userId = req.userId;
        const inProgress = await database_1.prisma.offerProgress.findMany({
            where: { userId, isCompleted: false },
            orderBy: { lastTaskAt: 'desc' },
        });
        (0, response_1.success)(res, inProgress);
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to get progress', 500);
    }
}
// ─── POST /api/earn/offers/rate ───────────────────────────────────────────────
async function rateOffer(req, res) {
    try {
        const userId = req.userId;
        const { offerId, provider, rating } = req.body;
        if (!rating || rating < 1 || rating > 5) {
            (0, response_1.error)(res, 'Rating must be 1-5', 400);
            return;
        }
        if (!offerId || !provider) {
            (0, response_1.error)(res, 'offerId and provider required', 400);
            return;
        }
        await database_1.prisma.offerRating.upsert({
            where: { userId_offerId: { userId, offerId } },
            update: { rating },
            create: { userId, provider, offerId, rating },
        });
        const agg = await database_1.prisma.offerRating.aggregate({
            where: { offerId },
            _avg: { rating: true },
            _count: { rating: true },
        });
        const avgRating = agg._avg.rating ?? 0;
        const ratingCount = agg._count.rating ?? 0;
        await database_1.prisma.offerQualityScore.upsert({
            where: { provider_offerId: { provider, offerId } },
            update: { avgRating, ratingCount },
            create: { provider, offerId, avgRating, ratingCount },
        });
        if (avgRating < 2.0 && ratingCount >= 5) {
            await (0, offerwallAggregator_1.autoBlacklist)(provider, offerId, `Low rating: ${avgRating.toFixed(2)} avg from ${ratingCount} users`);
        }
        // Invalidate cache
        const keys = await redis_1.redis.keys(`offer_feed:${userId}:*`);
        if (keys.length > 0)
            await redis_1.redis.del(...keys);
        (0, response_1.success)(res, { avgRating: Math.round(avgRating * 100) / 100 });
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to rate offer', 500);
    }
}
// ─── POST /api/earn/offers/report-missing ────────────────────────────────────
async function reportMissingCoins(req, res) {
    try {
        const userId = req.userId;
        const { offerId, provider } = req.body;
        if (!offerId || !provider) {
            (0, response_1.error)(res, 'offerId and provider required', 400);
            return;
        }
        const record = await database_1.prisma.offerQualityScore.upsert({
            where: { provider_offerId: { provider, offerId } },
            update: { missingCoinReports: { increment: 1 } },
            create: { provider, offerId, missingCoinReports: 1 },
        });
        if (record.missingCoinReports >= 2) {
            await (0, offerwallAggregator_1.autoBlacklist)(provider, offerId, `Missing coins x${record.missingCoinReports}`);
        }
        logger_1.logger.warn('Missing coins reported', { userId, offerId, provider });
        (0, response_1.success)(res, null, 'Report received. We will investigate within 24 hours!');
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to report', 500);
    }
}
// ─── POST /api/earn/offers/report-dead ───────────────────────────────────────
async function reportDeadUrl(req, res) {
    try {
        const userId = req.userId;
        const { offerId, provider, finalUrl } = req.body;
        if (!offerId || !provider) {
            (0, response_1.error)(res, 'offerId and provider required', 400);
            return;
        }
        await (0, offerwallAggregator_1.autoBlacklist)(provider, offerId, `Dead redirect: ${(finalUrl || '').substring(0, 200)}`);
        const keys = await redis_1.redis.keys(`offer_feed:${userId}:*`);
        if (keys.length > 0)
            await redis_1.redis.del(...keys);
        (0, response_1.success)(res, null, 'Thank you for reporting! The offer has been flagged.');
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to report', 500);
    }
}
// ─── POST /api/earn/offers/enhance ───────────────────────────────────────────
async function enhanceOffer(req, res) {
    try {
        const { offerId, provider, offerName, offerType, category, description, events, } = req.body;
        if (!offerId || !offerName) {
            (0, response_1.error)(res, 'offerId and offerName required', 400);
            return;
        }
        const cacheKey = `enhanced_offer:${provider || 'unknown'}:${offerId}`;
        const cached = await redis_1.redis.get(cacheKey);
        if (cached) {
            (0, response_1.success)(res, JSON.parse(cached));
            return;
        }
        const claude = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
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
        let result;
        if (jsonMatch) {
            result = JSON.parse(jsonMatch[0]);
        }
        else {
            result = {
                steps: events?.length
                    ? events.map((e, i) => ({
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
        await redis_1.redis.setex(cacheKey, 86400, JSON.stringify(result));
        (0, response_1.success)(res, result);
    }
    catch (err) {
        logger_1.logger.error('enhanceOffer error:', err);
        (0, response_1.success)(res, { steps: [], guide: [] });
    }
}
// ─── GET /api/earn/transactions ──────────────────────────────────────────────
async function getTransactions(req, res) {
    try {
        const userId = req.userId;
        const page = parseInt(String(req.query.page || '1'), 10);
        const limit = Math.min(parseInt(String(req.query.limit || '20'), 10), 50);
        const skip = (page - 1) * limit;
        // Fetch coin transactions and ticket transactions together
        const [coinTxs, ticketTxs] = await Promise.all([
            database_1.prisma.transaction.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                select: { id: true, type: true, amount: true, description: true, createdAt: true, status: true },
            }),
            database_1.prisma.ticketTransaction.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                select: { id: true, type: true, amount: true, description: true, createdAt: true },
            }),
        ]);
        // Normalise ticket records to match coin tx shape, tag with currency
        const ticketNormalised = ticketTxs.map(t => ({
            ...t,
            status: 'completed',
            currency: 'ticket',
        }));
        const coinNormalised = coinTxs.map(t => ({
            ...t,
            currency: 'coin',
        }));
        // Merge and sort by date descending, then paginate
        const all = [...coinNormalised, ...ticketNormalised].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const total = all.length;
        const transactions = all.slice(skip, skip + limit);
        (0, response_1.success)(res, { transactions, total, page, limit, pages: Math.ceil(total / limit) });
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to get transactions', 500);
    }
}
// ─── GET /api/earn/referral ───────────────────────────────────────────────────
async function getReferral(req, res) {
    try {
        const userId = req.userId;
        const [user, referrals] = await Promise.all([
            database_1.prisma.user.findUnique({
                where: { id: userId },
                select: { referralCode: true, referralCount: true },
            }),
            database_1.prisma.referral.findMany({
                where: { referrerId: userId },
                select: { id: true, coinsEarned: true, status: true, createdAt: true },
                orderBy: { createdAt: 'desc' },
                take: 20,
            }),
        ]);
        if (!user) {
            (0, response_1.error)(res, 'User not found', 404);
            return;
        }
        const totalCoinsEarned = referrals.reduce((sum, r) => sum + r.coinsEarned, 0);
        (0, response_1.success)(res, {
            referralCode: user.referralCode,
            referralCount: user.referralCount,
            totalCoinsEarned,
            referrals,
        });
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to get referral info', 500);
    }
}
// ─── GET /api/earn/streak ─────────────────────────────────────────────────────
async function getStreak(req, res) {
    try {
        const userId = req.userId;
        const streak = await database_1.prisma.userStreak.findUnique({ where: { userId } });
        const current = streak?.currentStreak ?? 0;
        const milestones = [3, 7, 14, 30];
        const nextMilestone = milestones.find((m) => current < m) ?? 30;
        const getMultiplier = (n) => {
            if (n >= 30)
                return 3.0;
            if (n >= 14)
                return 2.5;
            if (n >= 7)
                return 2.0;
            if (n >= 3)
                return 1.5;
            return 1.0;
        };
        (0, response_1.success)(res, {
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
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to get streak', 500);
    }
}
