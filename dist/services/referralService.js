"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processReferral = processReferral;
exports.getReferrals = getReferrals;
const database_1 = require("../config/database");
const coinService_1 = require("./coinService");
const client_1 = require("@prisma/client");
const logger_1 = require("../utils/logger");
const REFERRER_BONUS = 200;
const REFERRED_BONUS = 100;
async function processReferral(newUserId, referralCode) {
    const referrer = await database_1.prisma.user.findUnique({
        where: { referralCode },
        select: { id: true, status: true },
    });
    if (!referrer || referrer.status !== 'ACTIVE') {
        logger_1.logger.debug('Invalid referral code', { referralCode });
        return;
    }
    if (referrer.id === newUserId) {
        logger_1.logger.debug('Self-referral attempt blocked', { userId: newUserId });
        return;
    }
    // Idempotent — one referral per new user
    const existing = await database_1.prisma.referral.findUnique({ where: { referredId: newUserId } });
    if (existing)
        return;
    await database_1.prisma.referral.create({
        data: {
            referrerId: referrer.id,
            referredId: newUserId,
            coinsEarned: REFERRER_BONUS,
            status: 'active',
        },
    });
    await Promise.all([
        (0, coinService_1.creditCoins)(referrer.id, REFERRER_BONUS, client_1.TransactionType.EARN_REFERRAL, newUserId, 'Referral bonus'),
        (0, coinService_1.creditCoins)(newUserId, REFERRED_BONUS, client_1.TransactionType.EARN_REFERRAL, referrer.id, 'Joined via referral'),
    ]);
    logger_1.logger.info('Referral processed', { referrerId: referrer.id, referredId: newUserId });
}
async function getReferrals(userId, limit = 20, page = 1) {
    const skip = (page - 1) * limit;
    const where = { referrerId: userId };
    const [referrals, total] = await Promise.all([
        database_1.prisma.referral.findMany({
            where,
            include: { referred: { select: { id: true, name: true, createdAt: true } } },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        database_1.prisma.referral.count({ where }),
    ]);
    return { referrals, total };
}
