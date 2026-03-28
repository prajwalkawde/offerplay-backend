"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateStreak = updateStreak;
exports.queueFailedPostback = queueFailedPostback;
exports.processRetryQueue = processRetryQueue;
exports.receivePubScalePostback = receivePubScalePostback;
exports.receiveToroxPostback = receiveToroxPostback;
exports.receiveAyetPostback = receiveAyetPostback;
const database_1 = require("../config/database");
const logger_1 = require("../utils/logger");
const offerwallService_1 = require("./offerwallService");
const client_1 = require("@prisma/client");
// ─── Streak helpers ───────────────────────────────────────────────────────────
function getStreakMultiplier(streak) {
    if (streak >= 30)
        return 3.0;
    if (streak >= 14)
        return 2.5;
    if (streak >= 7)
        return 2.0;
    if (streak >= 3)
        return 1.5;
    return 1.0;
}
async function updateStreak(userId) {
    try {
        const today = new Date().toISOString().split('T')[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        const streak = await database_1.prisma.userStreak.findUnique({ where: { userId } });
        if (!streak) {
            await database_1.prisma.userStreak.create({
                data: { userId, currentStreak: 1, longestStreak: 1, lastActive: today, multiplier: 1.0 },
            });
            return;
        }
        if (streak.lastActive === today)
            return;
        if (streak.lastActive === yesterday) {
            const newStreak = streak.currentStreak + 1;
            const multiplier = getStreakMultiplier(newStreak);
            await database_1.prisma.userStreak.update({
                where: { userId },
                data: {
                    currentStreak: newStreak,
                    longestStreak: Math.max(newStreak, streak.longestStreak),
                    lastActive: today,
                    multiplier,
                },
            });
            if ([3, 7, 14, 30].includes(newStreak)) {
                logger_1.logger.info(`Streak milestone: ${userId} — ${newStreak} days (${multiplier}x)`);
            }
        }
        else {
            await database_1.prisma.userStreak.update({
                where: { userId },
                data: { currentStreak: 1, lastActive: today, multiplier: 1.0 },
            });
        }
    }
    catch {
        // Streak failure must never break the main postback flow
    }
}
async function getMultiplier(userId) {
    const streak = await database_1.prisma.userStreak.findUnique({ where: { userId } });
    return streak?.multiplier ?? 1.0;
}
async function updateCompletionStats(provider, offerId) {
    try {
        const record = await database_1.prisma.offerQualityScore.findUnique({
            where: { provider_offerId: { provider, offerId } },
        });
        if (record) {
            const newCompletions = record.totalCompletions + 1;
            const completionRate = record.totalClicks > 0
                ? (newCompletions / record.totalClicks) * 100 : 0;
            await database_1.prisma.offerQualityScore.update({
                where: { provider_offerId: { provider, offerId } },
                data: { totalCompletions: newCompletions, completionRate: Math.round(completionRate * 100) / 100 },
            });
        }
    }
    catch {
        // silent
    }
}
// ─── Retry Queue ──────────────────────────────────────────────────────────────
async function queueFailedPostback(params, reason, provider) {
    try {
        await database_1.prisma.postbackRetryQueue.create({
            data: {
                provider,
                params,
                reason,
                attempts: 0,
                maxAttempts: 3,
                nextRetry: new Date(Date.now() + 5 * 60000),
            },
        });
    }
    catch (err) {
        logger_1.logger.error('Failed to queue postback:', { message: err.message });
    }
}
async function processRetryQueue() {
    try {
        const retries = await database_1.prisma.postbackRetryQueue.findMany({
            where: { attempts: { lt: 3 }, nextRetry: { lte: new Date() }, resolvedAt: null },
            take: 20,
        });
        for (const retry of retries) {
            await database_1.prisma.postbackRetryQueue.update({
                where: { id: retry.id },
                data: { attempts: { increment: 1 }, nextRetry: new Date(Date.now() + 15 * 60000) },
            });
            try {
                let result = 'ERROR';
                const p = retry.params;
                if (retry.provider === 'pubscale')
                    result = await receivePubScalePostback(p);
                else if (retry.provider === 'torox')
                    result = await receiveToroxPostback(p);
                else if (retry.provider === 'ayet' || retry.provider === 'ayetstudios')
                    result = await receiveAyetPostback(p);
                if (result === 'OK') {
                    await database_1.prisma.postbackRetryQueue.update({
                        where: { id: retry.id },
                        data: { resolvedAt: new Date() },
                    });
                    logger_1.logger.info('Retry successful', { id: retry.id, provider: retry.provider });
                }
            }
            catch (err) {
                logger_1.logger.error('Retry failed:', { id: retry.id, message: err.message });
            }
        }
    }
    catch (err) {
        logger_1.logger.error('processRetryQueue error:', { message: err.message });
    }
}
// ─── PubScale Postback ────────────────────────────────────────────────────────
async function receivePubScalePostback(params) {
    logger_1.logger.info('PubScale postback received', { user_id: params.user_id });
    const userId = params.user_id;
    // Support both old (coins/offer_id/sig) and new (value/c1/signature) param names
    const coinsRaw = params.value || params.coins || '0';
    const sig = params.sig || params.signature || '';
    const offerId = params.c1 || params.offer_id || '';
    const transactionId = params.transaction_id || params.token || `ps_${Date.now()}`;
    // Verify signature using existing working method
    const valid = await (0, offerwallService_1.verifyPubscaleSignature)(params, sig);
    if (!valid) {
        await queueFailedPostback(params, 'invalid_signature', 'pubscale');
        return 'INVALID_SIGNATURE';
    }
    // Idempotency
    const exists = await database_1.prisma.offerwallLog.findFirst({
        where: { offerId: transactionId, provider: 'pubscale' },
    });
    if (exists)
        return 'OK';
    const user = await database_1.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
        await queueFailedPostback(params, 'user_not_found', 'pubscale');
        return 'USER_NOT_FOUND';
    }
    const coins = Math.round(parseFloat(coinsRaw));
    if (coins <= 0)
        return 'OK';
    const multiplier = await getMultiplier(userId);
    const finalCoins = Math.round(coins * multiplier);
    try {
        await database_1.prisma.$transaction([
            database_1.prisma.user.update({ where: { id: userId }, data: { coinBalance: { increment: finalCoins } } }),
            database_1.prisma.transaction.create({
                data: {
                    userId,
                    type: client_1.TransactionType.EARN_OFFERWALL,
                    amount: finalCoins,
                    refId: transactionId,
                    description: `PubScale offer${multiplier > 1 ? ` (${multiplier}x streak)` : ''}`,
                },
            }),
            database_1.prisma.offerwallLog.create({
                data: { userId, provider: 'pubscale', offerId: transactionId, coinsAwarded: finalCoins, rawData: params },
            }),
            database_1.prisma.notification.create({
                data: {
                    userId,
                    title: 'Coins Earned! 🪙',
                    body: multiplier > 1
                        ? `🔥 ${finalCoins} coins earned! (${multiplier}x streak bonus applied)`
                        : `You earned ${finalCoins} coins from completing an offer!`,
                    type: 'COIN_EARNED',
                },
            }),
        ]);
        if (offerId) {
            await database_1.prisma.offerProgress.updateMany({ where: { userId, offerId }, data: { isCompleted: true } });
            await updateCompletionStats('pubscale', offerId);
        }
        await updateStreak(userId);
        logger_1.logger.info('PubScale coins credited', { userId, finalCoins, multiplier });
        return 'OK';
    }
    catch (err) {
        logger_1.logger.error('PubScale postback processing failed:', { message: err.message });
        await queueFailedPostback(params, 'processing_error', 'pubscale');
        return 'ERROR';
    }
}
// ─── Torox Postback ───────────────────────────────────────────────────────────
async function receiveToroxPostback(params) {
    logger_1.logger.info('Torox postback received', { user_id: params.user_id });
    const userId = params.user_id;
    const coinsRaw = params.reward || params.coins || '0';
    const transactionId = params.transaction_id || `tx_${Date.now()}`;
    const sig = params.sig || params.security_token || '';
    const offerId = params.offer_id || '';
    const valid = await (0, offerwallService_1.verifyToroxSignature)(userId, offerId, coinsRaw, sig);
    if (!valid) {
        await queueFailedPostback(params, 'invalid_signature', 'torox');
        return 'INVALID';
    }
    const exists = await database_1.prisma.offerwallLog.findFirst({
        where: { offerId: transactionId, provider: 'torox' },
    });
    if (exists)
        return 'OK';
    const user = await database_1.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
        await queueFailedPostback(params, 'user_not_found', 'torox');
        return 'ERROR';
    }
    const coins = Math.round(parseFloat(coinsRaw));
    if (coins <= 0)
        return 'OK';
    const multiplier = await getMultiplier(userId);
    const finalCoins = Math.round(coins * multiplier);
    await database_1.prisma.$transaction([
        database_1.prisma.user.update({ where: { id: userId }, data: { coinBalance: { increment: finalCoins } } }),
        database_1.prisma.transaction.create({
            data: {
                userId,
                type: client_1.TransactionType.EARN_OFFERWALL,
                amount: finalCoins,
                refId: transactionId,
                description: `Torox offer${multiplier > 1 ? ` (${multiplier}x streak)` : ''}`,
            },
        }),
        database_1.prisma.offerwallLog.create({
            data: { userId, provider: 'torox', offerId: transactionId, coinsAwarded: finalCoins, rawData: params },
        }),
    ]);
    if (offerId)
        await updateCompletionStats('torox', offerId);
    await updateStreak(userId);
    return 'OK';
}
// ─── AyeT Postback ────────────────────────────────────────────────────────────
async function receiveAyetPostback(params) {
    logger_1.logger.info('AyeT postback received', { user_id: params.external_identifier || params.user_id });
    const userId = params.external_identifier || params.user_id;
    const coinsRaw = params.amount || params.coins || '0';
    const transactionId = String(params.id || params.transaction_id || `ay_${Date.now()}`);
    const sig = params.key || params.signature || '';
    const valid = await (0, offerwallService_1.verifyAyetSignature)(params, sig);
    if (!valid) {
        await queueFailedPostback(params, 'invalid_signature', 'ayet');
        return 'error';
    }
    const exists = await database_1.prisma.offerwallLog.findFirst({
        where: { offerId: transactionId, provider: 'ayet' },
    });
    if (exists)
        return 'OK';
    const user = await database_1.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
        await queueFailedPostback(params, 'user_not_found', 'ayet');
        return 'error';
    }
    const coins = Math.round(parseFloat(coinsRaw));
    if (coins <= 0)
        return 'OK';
    const multiplier = await getMultiplier(userId);
    const finalCoins = Math.round(coins * multiplier);
    await database_1.prisma.$transaction([
        database_1.prisma.user.update({ where: { id: userId }, data: { coinBalance: { increment: finalCoins } } }),
        database_1.prisma.transaction.create({
            data: {
                userId,
                type: client_1.TransactionType.EARN_OFFERWALL,
                amount: finalCoins,
                refId: transactionId,
                description: `AyeT offer${multiplier > 1 ? ` (${multiplier}x streak)` : ''}`,
            },
        }),
        database_1.prisma.offerwallLog.create({
            data: { userId, provider: 'ayet', offerId: transactionId, coinsAwarded: finalCoins, rawData: params },
        }),
    ]);
    await updateStreak(userId);
    return 'OK';
}
