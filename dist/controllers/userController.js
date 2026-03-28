"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProfile = getProfile;
exports.updateProfile = updateProfile;
exports.getTransactions = getTransactions;
exports.getStats = getStats;
exports.getUserReferrals = getUserReferrals;
exports.validateReferralCode = validateReferralCode;
const database_1 = require("../config/database");
const coinService_1 = require("../services/coinService");
const scoreService_1 = require("../services/scoreService");
const referralService_1 = require("../services/referralService");
const response_1 = require("../utils/response");
const query_1 = require("../utils/query");
async function getProfile(req, res) {
    const user = await database_1.prisma.user.findUnique({
        where: { id: req.userId },
        select: {
            id: true, name: true, phone: true, email: true,
            coinBalance: true, referralCode: true, language: true,
            status: true, createdAt: true,
        },
    });
    if (!user) {
        (0, response_1.error)(res, 'User not found', 404);
        return;
    }
    (0, response_1.success)(res, user);
}
async function updateProfile(req, res) {
    const { name, language, fcmToken } = req.body;
    const user = await database_1.prisma.user.update({
        where: { id: req.userId },
        data: {
            ...(name !== undefined && { name }),
            ...(language !== undefined && { language }),
            ...(fcmToken !== undefined && { fcmToken }),
        },
        select: { id: true, name: true, language: true, fcmToken: true },
    });
    (0, response_1.success)(res, user, 'Profile updated');
}
async function getTransactions(req, res) {
    const page = parseInt((0, query_1.qs)(req.query.page) ?? '1', 10);
    const limit = Math.min(parseInt((0, query_1.qs)(req.query.limit) ?? '20', 10), 100);
    const type = (0, query_1.qs)(req.query.type);
    const { transactions, total } = await (0, coinService_1.getLedger)(req.userId, type, limit, page);
    (0, response_1.paginated)(res, transactions, total, page, limit);
}
async function getStats(req, res) {
    const stats = await (0, scoreService_1.getUserStats)(req.userId);
    (0, response_1.success)(res, stats);
}
async function getUserReferrals(req, res) {
    const page = parseInt((0, query_1.qs)(req.query.page) ?? '1', 10);
    const limit = Math.min(parseInt((0, query_1.qs)(req.query.limit) ?? '20', 10), 50);
    const { referrals, total } = await (0, referralService_1.getReferrals)(req.userId, limit, page);
    (0, response_1.paginated)(res, referrals, total, page, limit);
}
async function validateReferralCode(req, res) {
    const code = String(req.params.code).toUpperCase();
    const user = await database_1.prisma.user.findUnique({
        where: { referralCode: code },
        select: { id: true, name: true },
    });
    if (!user) {
        (0, response_1.error)(res, 'Invalid referral code', 404);
        return;
    }
    (0, response_1.success)(res, { valid: true, referrer: user.name });
}
