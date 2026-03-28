"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyPubscaleSignature = verifyPubscaleSignature;
exports.verifyToroxSignature = verifyToroxSignature;
exports.verifyAyetSignature = verifyAyetSignature;
exports.processPostback = processPostback;
const database_1 = require("../config/database");
const coinService_1 = require("./coinService");
const client_1 = require("@prisma/client");
const crypto_1 = require("../utils/crypto");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
async function verifyPubscaleSignature(query, sig) {
    // Pubscale sends HMAC-SHA256 of sorted query params
    const sorted = Object.keys(query)
        .filter((k) => k !== 'sig')
        .sort()
        .map((k) => `${k}=${query[k]}`)
        .join('&');
    const expected = (0, crypto_1.hmacSha256)(env_1.env.PUBSCALE_SECRET, sorted);
    return (0, crypto_1.timingSafeEqual)(expected, sig);
}
async function verifyToroxSignature(userId, offerId, coins, sig) {
    const data = `${userId}${offerId}${coins}`;
    const expected = (0, crypto_1.hmacSha256)(env_1.env.TOROX_SECRET, data);
    return (0, crypto_1.timingSafeEqual)(expected, sig);
}
async function verifyAyetSignature(query, sig) {
    const sorted = Object.keys(query)
        .filter((k) => k !== 'signature')
        .sort()
        .map((k) => `${k}=${query[k]}`)
        .join('&');
    const expected = (0, crypto_1.hmacSha256)(env_1.env.AYETSTUDIO_SECRET, sorted);
    return (0, crypto_1.timingSafeEqual)(expected, sig);
}
async function processPostback(payload) {
    // Idempotency check
    const existing = await database_1.prisma.offerwallLog.findUnique({ where: { offerId: payload.offerId } });
    if (existing) {
        logger_1.logger.debug('Duplicate postback', { offerId: payload.offerId, provider: payload.provider });
        return { duplicate: true };
    }
    const user = await database_1.prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user)
        throw new Error('User not found');
    await database_1.prisma.$transaction([
        database_1.prisma.offerwallLog.create({
            data: {
                userId: payload.userId,
                provider: payload.provider,
                offerId: payload.offerId,
                coinsAwarded: payload.coins,
                rawData: payload.rawData ?? {},
            },
        }),
    ]);
    await (0, coinService_1.creditCoins)(payload.userId, payload.coins, client_1.TransactionType.EARN_OFFERWALL, payload.offerId, `${payload.provider} offer completed`);
    logger_1.logger.info('Postback processed', {
        userId: payload.userId,
        provider: payload.provider,
        coins: payload.coins,
    });
    return { duplicate: false };
}
