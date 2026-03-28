"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRedeemOptions = getRedeemOptions;
exports.createRedemption = createRedemption;
exports.getRedemptionHistory = getRedemptionHistory;
const database_1 = require("../config/database");
const coinService_1 = require("./coinService");
const client_1 = require("@prisma/client");
const logger_1 = require("../utils/logger");
const env_1 = require("../config/env");
const axios_1 = __importDefault(require("axios"));
const COIN_TO_INR = 100; // 100 coins = ₹1
const MIN_REDEEM = {
    UPI: 5000,
    PAYTM: 5000,
    PAYPAL: 10000,
    GIFT_CARD: 2000,
};
function getRedeemOptions() {
    return [
        { method: 'UPI', minCoins: 5000, inrEquivalent: 50, label: 'UPI Transfer (₹50+)' },
        { method: 'PAYTM', minCoins: 5000, inrEquivalent: 50, label: 'Paytm Wallet (₹50+)' },
        { method: 'PAYPAL', minCoins: 10000, inrEquivalent: 100, label: 'PayPal (₹100+)' },
        { method: 'GIFT_CARD', minCoins: 2000, inrEquivalent: 20, label: 'Gift Card (₹20+)' },
    ];
}
async function createRedemption(req) {
    const minCoins = MIN_REDEEM[req.method];
    if (!minCoins)
        throw new Error('Invalid redemption method');
    if (req.coins < minCoins)
        throw new Error(`Minimum ${minCoins} coins required`);
    const typeMap = {
        UPI: client_1.TransactionType.REDEEM_UPI,
        PAYTM: client_1.TransactionType.REDEEM_PAYTM,
        PAYPAL: client_1.TransactionType.REDEEM_PAYPAL,
        GIFT_CARD: client_1.TransactionType.REDEEM_GIFT_CARD,
    };
    await (0, coinService_1.debitCoins)(req.userId, req.coins, typeMap[req.method], undefined, `Redeem via ${req.method}`);
    // Trigger Xoxoday payout if configured
    const redemptionId = await triggerXoxodayPayout(req);
    logger_1.logger.info('Redemption created', { userId: req.userId, method: req.method, coins: req.coins });
    return { redemptionId };
}
async function triggerXoxodayPayout(req) {
    if (!env_1.env.XOXODAY_API_KEY || env_1.env.XOXODAY_API_KEY === 'your-xoxoday-key') {
        // Mock payout in dev
        return `mock-${Date.now()}`;
    }
    try {
        const inrAmount = req.coins / COIN_TO_INR;
        const res = await axios_1.default.post('https://api.xoxoday.com/v1/payout', {
            apiKey: env_1.env.XOXODAY_API_KEY,
            method: req.method,
            amount: inrAmount,
            currency: 'INR',
            details: req.details,
        }, { headers: { 'Content-Type': 'application/json' } });
        return res.data?.payoutId ?? `xoxy-${Date.now()}`;
    }
    catch (err) {
        logger_1.logger.error('Xoxoday payout failed', { err });
        throw new Error('Payout provider unavailable');
    }
}
async function getRedemptionHistory(userId, limit = 20, page = 1) {
    const skip = (page - 1) * limit;
    const typeList = [
        client_1.TransactionType.REDEEM_UPI,
        client_1.TransactionType.REDEEM_PAYTM,
        client_1.TransactionType.REDEEM_PAYPAL,
        client_1.TransactionType.REDEEM_GIFT_CARD,
    ];
    const where = { userId, type: { in: typeList } };
    const [items, total] = await Promise.all([
        database_1.prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
        database_1.prisma.transaction.count({ where }),
    ]);
    return { items, total };
}
