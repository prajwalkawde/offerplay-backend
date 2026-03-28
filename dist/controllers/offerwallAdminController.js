"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listOfferwallOffers = listOfferwallOffers;
exports.getAdminOffers = getAdminOffers;
exports.fetchLiveOffersForAdmin = fetchLiveOffersForAdmin;
exports.blacklistOffer = blacklistOffer;
exports.whitelistOffer = whitelistOffer;
exports.getQualityReport = getQualityReport;
exports.getPostbackLogs = getPostbackLogs;
exports.getRetryQueue = getRetryQueue;
exports.manualCredit = manualCredit;
exports.getOfferwallStats = getOfferwallStats;
exports.getSurveyStats = getSurveyStats;
const client_1 = require("@prisma/client");
const axios_1 = __importDefault(require("axios"));
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const logger_1 = require("../utils/logger");
const coinService_1 = require("../services/coinService");
const offerwallAggregator_1 = require("../services/offerwallAggregator");
const query_1 = require("../utils/query");
const env_1 = require("../config/env");
// ─── GET /api/admin/offerwall/offers ─────────────────────────────────────────
async function listOfferwallOffers(req, res) {
    return getAdminOffers(req, res);
}
async function getAdminOffers(req, res) {
    try {
        const provider = (0, query_1.qs)(req.query.provider);
        const status = (0, query_1.qs)(req.query.status);
        const page = parseInt((0, query_1.qs)(req.query.page) ?? '1', 10);
        const limit = Math.min(parseInt((0, query_1.qs)(req.query.limit) ?? '50', 10), 200);
        const skip = (page - 1) * limit;
        const where = {};
        if (provider && provider !== 'all')
            where.provider = provider;
        if (status === 'active') {
            where.isActive = true;
            where.isBlacklisted = false;
        }
        if (status === 'blacklisted')
            where.isBlacklisted = true;
        const [offers, total] = await Promise.all([
            database_1.prisma.offerQualityScore.findMany({
                where,
                orderBy: { qualityScore: 'desc' },
                skip,
                take: limit,
            }),
            database_1.prisma.offerQualityScore.count({ where }),
        ]);
        (0, response_1.success)(res, { offers, total, page, pages: Math.ceil(total / limit) });
    }
    catch (err) {
        logger_1.logger.error('getAdminOffers error:', err);
        (0, response_1.error)(res, 'Failed to get offers', 500);
    }
}
// ─── GET /api/admin/offerwall/live-offers ─────────────────────────────────────
async function fetchLiveOffersForAdmin(req, res) {
    try {
        if (!env_1.env.PUBSCALE_APP_ID || !env_1.env.PUBSCALE_PUB_KEY) {
            (0, response_1.error)(res, 'PubScale credentials not configured', 400);
            return;
        }
        const response = await axios_1.default.post('https://api-ow.pubscale.com/v1/offer/api', {
            page: 1,
            size: 100,
            filt: [{ dim: 'platform', match: { type: 'any', value: ['android'] } }],
        }, {
            headers: {
                'App-Id': env_1.env.PUBSCALE_APP_ID,
                'Pub-Key': env_1.env.PUBSCALE_PUB_KEY,
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        });
        const offers = (response.data?.offers || []);
        const normalized = offers.slice(0, 100).map((o) => ({
            offerId: String(o.id),
            offerName: o.name,
            provider: 'pubscale',
            coins: Math.round(o.inapp_pyt?.amt || 0),
            payoutUsd: parseFloat(String(o.pyt?.amt || '0')),
            offType: o.off_type,
            qualityScore: 50,
            isActive: true,
            isBlacklisted: false,
            totalClicks: 0,
            totalCompletions: 0,
            completionRate: 0,
            avgRating: 0,
        }));
        (0, response_1.success)(res, { offers: normalized, total: normalized.length });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        logger_1.logger.error('fetchLiveOffersForAdmin error:', err);
        (0, response_1.error)(res, `Failed to fetch from PubScale: ${msg}`, 500);
    }
}
// ─── POST /api/admin/offerwall/blacklist ──────────────────────────────────────
async function blacklistOffer(req, res) {
    const { provider, offerId, reason } = req.body;
    if (!provider || !offerId) {
        (0, response_1.error)(res, 'provider and offerId required', 400);
        return;
    }
    await (0, offerwallAggregator_1.autoBlacklist)(provider, offerId, reason || 'Manual admin blacklist');
    logger_1.logger.info('Offer manually blacklisted', { provider, offerId, reason });
    (0, response_1.success)(res, null, 'Offer blacklisted and feed cache will refresh on next request');
}
// ─── POST /api/admin/offerwall/whitelist ──────────────────────────────────────
async function whitelistOffer(req, res) {
    const { provider, offerId } = req.body;
    if (!provider || !offerId) {
        (0, response_1.error)(res, 'provider and offerId required', 400);
        return;
    }
    await database_1.prisma.offerQualityScore.upsert({
        where: { provider_offerId: { provider, offerId } },
        update: { isBlacklisted: false, isActive: true, blacklistReason: null },
        create: { provider, offerId, isBlacklisted: false, isActive: true },
    });
    logger_1.logger.info('Offer whitelisted', { provider, offerId });
    (0, response_1.success)(res, null, 'Offer removed from blacklist');
}
// ─── GET /api/admin/offerwall/quality-report ──────────────────────────────────
async function getQualityReport(req, res) {
    const tab = (0, query_1.qs)(req.query.tab) || 'best';
    let offers;
    switch (tab) {
        case 'best':
            offers = await database_1.prisma.offerQualityScore.findMany({
                where: { isBlacklisted: false, isActive: true, totalClicks: { gt: 0 } },
                orderBy: { completionRate: 'desc' },
                take: 50,
            });
            break;
        case 'worst':
            offers = await database_1.prisma.offerQualityScore.findMany({
                where: { isBlacklisted: false, totalClicks: { gte: 5 } },
                orderBy: { completionRate: 'asc' },
                take: 50,
            });
            break;
        case 'blacklisted':
            offers = await database_1.prisma.offerQualityScore.findMany({
                where: { isBlacklisted: true },
                orderBy: { updatedAt: 'desc' },
            });
            break;
        case 'dead':
            offers = await database_1.prisma.offerQualityScore.findMany({
                where: { totalClicks: { gte: 20 }, totalCompletions: 0, isBlacklisted: false },
                orderBy: { totalClicks: 'desc' },
            });
            break;
        default:
            offers = [];
    }
    (0, response_1.success)(res, { tab, total: offers.length, offers });
}
// ─── GET /api/admin/offerwall/postback-logs ───────────────────────────────────
async function getPostbackLogs(req, res) {
    const provider = (0, query_1.qs)(req.query.provider);
    const userId = (0, query_1.qs)(req.query.userId);
    const date = (0, query_1.qs)(req.query.date);
    const page = parseInt((0, query_1.qs)(req.query.page) ?? '1', 10);
    const limit = Math.min(parseInt((0, query_1.qs)(req.query.limit) ?? '50', 10), 100);
    const skip = (page - 1) * limit;
    const where = {};
    if (provider)
        where.provider = provider;
    if (userId)
        where.userId = userId;
    if (date) {
        const start = new Date(date);
        const end = new Date(date);
        end.setDate(end.getDate() + 1);
        where.createdAt = { gte: start, lt: end };
    }
    const [logs, total] = await Promise.all([
        database_1.prisma.offerwallLog.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        database_1.prisma.offerwallLog.count({ where }),
    ]);
    (0, response_1.success)(res, { logs, total, page, pages: Math.ceil(total / limit) });
}
// ─── GET /api/admin/offerwall/retry-queue ────────────────────────────────────
async function getRetryQueue(req, res) {
    const page = parseInt((0, query_1.qs)(req.query.page) ?? '1', 10);
    const limit = Math.min(parseInt((0, query_1.qs)(req.query.limit) ?? '50', 10), 100);
    const [pending, resolved, total] = await Promise.all([
        database_1.prisma.postbackRetryQueue.findMany({
            where: { resolvedAt: null, attempts: { lt: 3 } },
            orderBy: { nextRetry: 'asc' },
            take: limit,
            skip: (page - 1) * limit,
        }),
        database_1.prisma.postbackRetryQueue.count({ where: { resolvedAt: { not: null } } }),
        database_1.prisma.postbackRetryQueue.count(),
    ]);
    const failed = await database_1.prisma.postbackRetryQueue.count({
        where: { resolvedAt: null, attempts: { gte: 3 } },
    });
    (0, response_1.success)(res, {
        pending,
        stats: { total, resolved, failed, pendingCount: total - resolved - failed },
        page,
    });
}
// ─── POST /api/admin/offerwall/manual-credit ─────────────────────────────────
async function manualCredit(req, res) {
    const { userId, coins, reason } = req.body;
    if (!userId || !coins || coins <= 0) {
        (0, response_1.error)(res, 'userId and coins (>0) required', 400);
        return;
    }
    const user = await database_1.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, coinBalance: true },
    });
    if (!user) {
        (0, response_1.error)(res, 'User not found', 404);
        return;
    }
    await (0, coinService_1.creditCoins)(userId, coins, client_1.TransactionType.EARN_BONUS, `admin_manual_${Date.now()}`, reason || 'Admin manual credit');
    logger_1.logger.info('Admin manual credit', { userId, coins, reason });
    (0, response_1.success)(res, { userId, coinsAdded: coins, newBalance: user.coinBalance + coins }, 'Coins credited successfully');
}
// ─── GET /api/admin/offerwall/stats ──────────────────────────────────────────
async function getOfferwallStats(_req, res) {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const [totalOffers, activeOffers, blacklisted, todayRevenue, providerStats, topOffers] = await Promise.all([
            database_1.prisma.offerQualityScore.count(),
            database_1.prisma.offerQualityScore.count({ where: { isActive: true, isBlacklisted: false } }),
            database_1.prisma.offerQualityScore.count({ where: { isBlacklisted: true } }),
            database_1.prisma.offerwallLog.aggregate({
                where: { createdAt: { gte: today } },
                _sum: { coinsAwarded: true },
            }),
            database_1.prisma.offerwallLog.groupBy({
                by: ['provider'],
                _sum: { coinsAwarded: true },
                _count: { id: true },
                orderBy: { _count: { id: 'desc' } },
            }),
            database_1.prisma.offerQualityScore.findMany({
                where: { isBlacklisted: false },
                orderBy: { totalCompletions: 'desc' },
                take: 10,
                select: { provider: true, offerId: true, offerName: true, totalCompletions: true, completionRate: true, avgRating: true },
            }),
        ]);
        (0, response_1.success)(res, {
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
    }
    catch (err) {
        logger_1.logger.error('getOfferwallStats error:', err);
        (0, response_1.error)(res, 'Failed to get offerwall stats', 500);
    }
}
// ─── GET /api/admin/surveys/stats ────────────────────────────────────────────
async function getSurveyStats(req, res) {
    try {
        const surveyLogs = await database_1.prisma.offerwallLog.findMany({
            where: { provider: 'cpx' },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
        const totalCompleted = surveyLogs.length;
        const totalCoins = surveyLogs.reduce((sum, l) => sum + (l.coinsAwarded || 0), 0);
        const todayStr = new Date().toDateString();
        const todayLogs = surveyLogs.filter((l) => new Date(l.createdAt).toDateString() === todayStr);
        (0, response_1.success)(res, {
            totalCompleted,
            totalCoins,
            todayCompleted: todayLogs.length,
            todayCoins: todayLogs.reduce((s, l) => s + (l.coinsAwarded || 0), 0),
        });
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to get survey stats', 500);
    }
}
