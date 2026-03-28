"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getXoxodayProducts = void 0;
exports.getRedeemPackages = getRedeemPackages;
exports.getGiftCards = getGiftCards;
exports.requestRedemption = requestRedemption;
exports.getRedemptionHistory = getRedemptionHistory;
exports.getAdminRedemptions = getAdminRedemptions;
exports.getAdminPackages = getAdminPackages;
exports.deleteRedeemPackage = deleteRedeemPackage;
exports.upsertRedeemPackage = upsertRedeemPackage;
exports.manualProcessRedemption = manualProcessRedemption;
exports.getRedemptionDetails = getRedemptionDetails;
exports.approveRedemption = approveRedemption;
exports.updateRedemptionStatus = updateRedemptionStatus;
exports.rateRedemption = rateRedemption;
exports.listOptions = listOptions;
exports.redemptionHistory = redemptionHistory;
const client_1 = require("@prisma/client");
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const logger_1 = require("../utils/logger");
const cashfreeService_1 = require("../services/cashfreeService");
const xoxodayService_1 = require("../services/xoxodayService");
Object.defineProperty(exports, "getXoxodayProducts", { enumerable: true, get: function () { return xoxodayService_1.getXoxodayProducts; } });
const DEFAULT_PACKAGES = [
    { name: 'UPI ₹10', type: 'UPI', coinsRequired: 100, amountInr: 10, minCoins: 100, icon: '💳', description: 'Transfer to UPI ID', provider: 'cashfree' },
    { name: 'UPI ₹50', type: 'UPI', coinsRequired: 500, amountInr: 50, minCoins: 500, icon: '💳', description: 'Transfer to UPI ID', provider: 'cashfree' },
    { name: 'UPI ₹100', type: 'UPI', coinsRequired: 1000, amountInr: 100, minCoins: 1000, icon: '💳', description: 'Transfer to UPI ID', provider: 'cashfree' },
    { name: 'Bank ₹100', type: 'BANK', coinsRequired: 1000, amountInr: 100, minCoins: 1000, icon: '🏦', description: 'Transfer to bank account', provider: 'cashfree' },
    { name: 'Bank ₹500', type: 'BANK', coinsRequired: 5000, amountInr: 500, minCoins: 5000, icon: '🏦', description: 'Transfer to bank account', provider: 'cashfree' },
    { name: 'Amazon ₹100', type: 'GIFT_CARD', coinsRequired: 1100, amountInr: 100, minCoins: 1100, icon: '🛍️', description: 'Amazon gift card', provider: 'xoxoday' },
    { name: 'Flipkart ₹100', type: 'GIFT_CARD', coinsRequired: 1100, amountInr: 100, minCoins: 1100, icon: '🛒', description: 'Flipkart gift card', provider: 'xoxoday' },
    { name: 'Free Fire 310 Gems', type: 'GAME_CREDIT', coinsRequired: 2600, amountInr: 250, minCoins: 2600, icon: '🎮', description: 'Free Fire diamonds top-up', provider: 'xoxoday' },
    { name: 'Mobile Recharge ₹149', type: 'RECHARGE', coinsRequired: 1600, amountInr: 149, minCoins: 1600, icon: '📱', description: 'Any network recharge', provider: 'xoxoday' },
];
function redeemTransactionType(type) {
    switch (type) {
        case 'GIFT_CARD':
        case 'GAME_CREDIT':
        case 'VOUCHER': return client_1.TransactionType.REDEEM_GIFT_CARD;
        case 'RECHARGE': return client_1.TransactionType.REDEEM_PAYTM;
        case 'BANK':
        case 'UPI':
        default: return client_1.TransactionType.REDEEM_UPI;
    }
}
// ─── GET /redeem/packages ──────────────────────────────────────────────────────
async function getRedeemPackages(req, res) {
    try {
        let allPackages = await database_1.prisma.redeemPackage.findMany({
            where: { isActive: true },
            orderBy: [
                { isFeatured: 'desc' },
                { isPopular: 'desc' },
                { sortOrder: 'asc' },
                { coinsRequired: 'asc' },
            ],
        });
        if (allPackages.length === 0) {
            await database_1.prisma.redeemPackage.createMany({ data: DEFAULT_PACKAGES, skipDuplicates: true });
            allPackages = await database_1.prisma.redeemPackage.findMany({
                where: { isActive: true },
                orderBy: [{ sortOrder: 'asc' }, { coinsRequired: 'asc' }],
            });
        }
        // Determine user's country
        let userCountry = 'IN';
        const userId = req.userId;
        if (userId) {
            const user = await database_1.prisma.user.findUnique({
                where: { id: userId },
                select: { country: true },
            });
            userCountry = user?.country || 'IN';
        }
        // Filter by country — include package if:
        //   - availableIn contains userCountry or "GLOBAL"
        //   - or isDefault is true
        const countryPackages = allPackages.filter(p => {
            const available = p.availableIn || ['IN'];
            return available.includes(userCountry) || available.includes('GLOBAL') || p.isDefault;
        });
        // Fallback chain: country match → default only → all
        const finalPackages = countryPackages.length > 0
            ? countryPackages
            : allPackages.filter(p => p.isDefault).length > 0
                ? allPackages.filter(p => p.isDefault)
                : allPackages;
        (0, response_1.success)(res, finalPackages);
    }
    catch (err) {
        logger_1.logger.error('getRedeemPackages error:', err);
        (0, response_1.error)(res, 'Failed to get packages', 500);
    }
}
// ─── GET /redeem/gift-cards ────────────────────────────────────────────────────
async function getGiftCards(req, res) {
    try {
        const country = String(req.query.country || 'IN');
        const category = req.query.category ? String(req.query.category) : undefined;
        const products = await (0, xoxodayService_1.getXoxodayProducts)(country, category);
        (0, response_1.success)(res, { products, total: products.length });
    }
    catch (err) {
        logger_1.logger.error('getGiftCards error:', err);
        (0, response_1.error)(res, 'Failed to get gift cards', 500);
    }
}
// ─── POST /redeem/request ──────────────────────────────────────────────────────
async function requestRedemption(req, res) {
    try {
        const userId = req.userId;
        const { type, coinsToRedeem, upiId, accountNumber, ifscCode, accountName, bankName, productId, productName, denominationId, mobileNumber, operator, gameId, gamePlayerId, customFieldValues, packageId, } = req.body;
        if (!type || !coinsToRedeem) {
            (0, response_1.error)(res, 'type and coinsToRedeem are required', 400);
            return;
        }
        const user = await database_1.prisma.user.findUnique({
            where: { id: userId },
            select: { coinBalance: true, name: true, email: true },
        });
        if (!user) {
            (0, response_1.error)(res, 'User not found', 404);
            return;
        }
        if (user.coinBalance < coinsToRedeem) {
            (0, response_1.error)(res, 'Insufficient coins', 400);
            return;
        }
        const coinRate = await database_1.prisma.coinConversionRate.findFirst({ where: { countryCode: 'IN' } });
        const coinsPerUnit = coinRate?.coinsPerUnit || 100;
        const amountInr = coinsToRedeem / coinsPerUnit;
        const orderId = `OP_${userId.slice(0, 6)}_${Date.now()}`;
        // Look up package for redeemUrl and other metadata
        let pkgRedeemUrl = null;
        if (packageId) {
            const pkg = await database_1.prisma.redeemPackage.findUnique({
                where: { id: packageId },
                select: { redeemUrl: true },
            });
            pkgRedeemUrl = pkg?.redeemUrl || null;
        }
        const redemption = await database_1.prisma.redemptionRequest.create({
            data: {
                userId, type, status: 'processing',
                coinsRedeemed: coinsToRedeem, amountInr,
                upiId, accountNumber, ifscCode, accountName, bankName,
                productId, productName, denominationId,
                mobileNumber, operator, gameId, gamePlayerId,
                ...(customFieldValues ? { customFieldValues } : {}),
                ...(pkgRedeemUrl ? { redeemUrl: pkgRedeemUrl } : {}),
            },
        });
        // Admin notification log for new redemption
        logger_1.logger.info(`[REDEMPTION] New request #${redemption.id} | user=${userId} | type=${type} | coins=${coinsToRedeem} | ₹${amountInr.toFixed(2)}`);
        // Deduct coins immediately
        await database_1.prisma.$transaction([
            database_1.prisma.user.update({
                where: { id: userId },
                data: { coinBalance: { decrement: coinsToRedeem } },
            }),
            database_1.prisma.transaction.create({
                data: {
                    userId,
                    type: redeemTransactionType(type),
                    amount: coinsToRedeem,
                    refId: redemption.id,
                    description: `Redemption: ${type} — ₹${amountInr.toFixed(2)}`,
                },
            }),
        ]);
        // Process by type
        let result = { success: false };
        if (type === 'UPI' && upiId) {
            result = await (0, cashfreeService_1.transferToUPI)(orderId, upiId, amountInr, user.name || 'User', userId);
            await database_1.prisma.redemptionRequest.update({
                where: { id: redemption.id },
                data: {
                    cashfreeOrderId: orderId,
                    cashfreeRefId: result.referenceId,
                    status: result.success ? 'completed' : 'failed',
                    failureReason: result.error,
                    processedAt: result.success ? new Date() : null,
                },
            });
        }
        else if (type === 'BANK' && accountNumber) {
            result = await (0, cashfreeService_1.transferToBank)(orderId, accountNumber, ifscCode || '', accountName || '', amountInr, userId);
            await database_1.prisma.redemptionRequest.update({
                where: { id: redemption.id },
                data: {
                    cashfreeOrderId: orderId,
                    cashfreeRefId: result.referenceId,
                    status: result.success ? 'completed' : 'failed',
                    failureReason: result.error,
                    processedAt: result.success ? new Date() : null,
                },
            });
        }
        else if ((type === 'GIFT_CARD' || type === 'GAME_CREDIT' || type === 'RECHARGE' || type === 'VOUCHER') && productId) {
            result = await (0, xoxodayService_1.placeXoxodayOrder)(productId, denominationId || '', 1, userId, user.email || `${userId}@offerplay.in`, orderId);
            await database_1.prisma.redemptionRequest.update({
                where: { id: redemption.id },
                data: {
                    xoxodayOrderId: orderId,
                    voucherCode: result.voucherCode,
                    voucherLink: result.voucherLink,
                    status: result.success ? 'completed' : 'failed',
                    failureReason: result.error,
                    processedAt: result.success ? new Date() : null,
                },
            });
        }
        else {
            // Unknown type — just mark pending for admin review
            await database_1.prisma.redemptionRequest.update({
                where: { id: redemption.id },
                data: { status: 'pending' },
            });
            result = { success: true };
        }
        // Refund coins on failure
        if (!result.success) {
            await database_1.prisma.user.update({ where: { id: userId }, data: { coinBalance: { increment: coinsToRedeem } } });
            await database_1.prisma.redemptionRequest.update({ where: { id: redemption.id }, data: { status: 'refunded' } });
            (0, response_1.error)(res, result.error || 'Redemption failed. Coins refunded.', 400);
            return;
        }
        // Notify user
        await database_1.prisma.notification.create({
            data: {
                userId,
                title: 'Redemption Successful!',
                body: (type === 'UPI' || type === 'BANK')
                    ? `₹${amountInr.toFixed(2)} will be credited within 24 hours`
                    : `Your ${productName || type} voucher is ready!`,
                type: 'REDEMPTION',
            },
        });
        (0, response_1.success)(res, {
            redemptionId: redemption.id,
            type, coinsRedeemed: coinsToRedeem, amountInr,
            status: 'completed',
            voucherCode: result.voucherCode,
            voucherLink: result.voucherLink,
            referenceId: result.referenceId,
        }, 'Redemption successful!');
    }
    catch (err) {
        logger_1.logger.error('requestRedemption error:', err);
        (0, response_1.error)(res, 'Redemption failed', 500);
    }
}
// ─── GET /redeem/history ───────────────────────────────────────────────────────
async function getRedemptionHistory(req, res) {
    try {
        const userId = req.userId;
        const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
        const limit = Math.min(50, parseInt(String(req.query.limit || '20'), 10));
        const [redemptions, total] = await Promise.all([
            database_1.prisma.redemptionRequest.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            database_1.prisma.redemptionRequest.count({ where: { userId } }),
        ]);
        (0, response_1.success)(res, { redemptions, total, page, pages: Math.ceil(total / limit) });
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to get history', 500);
    }
}
// ─── Admin: GET all redemptions ────────────────────────────────────────────────
async function getAdminRedemptions(req, res) {
    try {
        const status = req.query.status ? String(req.query.status) : undefined;
        const type = req.query.type ? String(req.query.type) : undefined;
        const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
        const limit = Math.min(100, parseInt(String(req.query.limit || '50'), 10));
        const where = {};
        if (status)
            where.status = status;
        if (type)
            where.type = type;
        const [redemptions, total] = await Promise.all([
            database_1.prisma.redemptionRequest.findMany({
                where,
                include: { user: { select: { name: true, phone: true, email: true } } },
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            database_1.prisma.redemptionRequest.count({ where }),
        ]);
        (0, response_1.success)(res, { redemptions, total, page, pages: Math.ceil(total / limit) });
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to get redemptions', 500);
    }
}
// ─── Admin: GET redeem packages ────────────────────────────────────────────────
async function getAdminPackages(_req, res) {
    try {
        const packages = await database_1.prisma.redeemPackage.findMany({ orderBy: { coinsRequired: 'asc' } });
        (0, response_1.success)(res, packages);
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to get packages', 500);
    }
}
// ─── Admin: Delete package ─────────────────────────────────────────────────────
async function deleteRedeemPackage(req, res) {
    try {
        const { id } = req.params;
        await database_1.prisma.redeemPackage.delete({ where: { id } });
        (0, response_1.success)(res, null, 'Package deleted');
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to delete package', 500);
    }
}
// ─── Admin: Create or update package ──────────────────────────────────────────
async function upsertRedeemPackage(req, res) {
    try {
        const { id, ...data } = req.body;
        if (id) {
            const pkg = await database_1.prisma.redeemPackage.update({ where: { id: String(id) }, data });
            (0, response_1.success)(res, pkg, 'Package updated!');
        }
        else {
            const pkg = await database_1.prisma.redeemPackage.create({ data: data });
            (0, response_1.success)(res, pkg, 'Package created!');
        }
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to save package', 500);
    }
}
// ─── Admin: Manual process a failed redemption ────────────────────────────────
async function manualProcessRedemption(req, res) {
    try {
        const { id } = req.params;
        const { action, note } = req.body;
        const redemption = await database_1.prisma.redemptionRequest.findUnique({ where: { id } });
        if (!redemption) {
            (0, response_1.error)(res, 'Redemption not found', 404);
            return;
        }
        if (action === 'complete') {
            await database_1.prisma.redemptionRequest.update({
                where: { id },
                data: { status: 'completed', failureReason: note, processedAt: new Date() },
            });
            (0, response_1.success)(res, null, 'Marked as completed');
            return;
        }
        if (action === 'refund') {
            await database_1.prisma.$transaction([
                database_1.prisma.redemptionRequest.update({
                    where: { id },
                    data: { status: 'refunded', failureReason: note },
                }),
                database_1.prisma.user.update({
                    where: { id: redemption.userId },
                    data: { coinBalance: { increment: redemption.coinsRedeemed } },
                }),
                database_1.prisma.transaction.create({
                    data: {
                        userId: redemption.userId,
                        type: client_1.TransactionType.REFUND,
                        amount: redemption.coinsRedeemed,
                        refId: id,
                        description: `Refund: ${note || 'Admin refund'}`,
                    },
                }),
            ]);
            (0, response_1.success)(res, null, 'Refunded successfully');
            return;
        }
        (0, response_1.error)(res, 'Invalid action — use "complete" or "refund"', 400);
    }
    catch (err) {
        logger_1.logger.error('manualProcessRedemption error:', err);
        (0, response_1.error)(res, 'Failed to process', 500);
    }
}
// ─── Admin: Get single redemption with user history ───────────────────────────
async function getRedemptionDetails(req, res) {
    try {
        const { id } = req.params;
        const redemption = await database_1.prisma.redemptionRequest.findUnique({
            where: { id },
            include: {
                user: {
                    select: { id: true, name: true, phone: true, email: true, coinBalance: true, createdAt: true },
                },
            },
        });
        if (!redemption) {
            (0, response_1.error)(res, 'Not found', 404);
            return;
        }
        const [transactions, earnedAgg, redeemedAgg, totalAgg] = await Promise.all([
            database_1.prisma.transaction.findMany({
                where: { userId: redemption.userId },
                orderBy: { createdAt: 'desc' },
                take: 50,
            }),
            database_1.prisma.transaction.aggregate({
                where: { userId: redemption.userId, amount: { gt: 0 } },
                _sum: { amount: true },
            }),
            database_1.prisma.transaction.aggregate({
                where: {
                    userId: redemption.userId,
                    type: { in: [client_1.TransactionType.REDEEM_UPI, client_1.TransactionType.REDEEM_GIFT_CARD, client_1.TransactionType.REDEEM_PAYTM] },
                },
                _sum: { amount: true },
            }),
            database_1.prisma.transaction.aggregate({
                where: { userId: redemption.userId },
                _count: { id: true },
            }),
        ]);
        // Fraud score
        const accountAgeDays = Math.floor((Date.now() - new Date(redemption.user?.createdAt || Date.now()).getTime()) / 86400000);
        const [todayRedemptions, totalRedemptions, offerwallAgg] = await Promise.all([
            database_1.prisma.redemptionRequest.count({
                where: { userId: redemption.userId, createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
            }),
            database_1.prisma.redemptionRequest.count({ where: { userId: redemption.userId } }),
            database_1.prisma.transaction.aggregate({
                where: { userId: redemption.userId, type: { in: [client_1.TransactionType.EARN_OFFERWALL, client_1.TransactionType.EARN_TASK, client_1.TransactionType.EARN_SURVEY] }, amount: { gt: 0 } },
                _sum: { amount: true },
            }),
        ]);
        const totalEarned = earnedAgg._sum.amount || 0;
        const totalRedeemed = Math.abs(redeemedAgg._sum.amount || 0);
        const offerwallEarnings = offerwallAgg._sum.amount || 0;
        let fraudScore = 0;
        if (accountAgeDays < 1)
            fraudScore += 40;
        else if (accountAgeDays < 7)
            fraudScore += 20;
        if (todayRedemptions > 5)
            fraudScore += 30;
        else if (todayRedemptions > 3)
            fraudScore += 15;
        if (!offerwallEarnings)
            fraudScore += 25;
        if (totalRedeemed > totalEarned * 0.9)
            fraudScore += 15;
        fraudScore = Math.min(fraudScore, 100);
        (0, response_1.success)(res, {
            redemption,
            userStats: {
                totalEarned,
                totalRedeemed,
                currentBalance: redemption.user?.coinBalance || 0,
                totalTransactions: totalAgg._count.id,
                accountAgeDays,
                todayRedemptions,
                offerwallEarnings,
                totalRedemptionCount: totalRedemptions,
            },
            transactions,
            fraudScore,
        });
    }
    catch (err) {
        logger_1.logger.error('getRedemptionDetails error:', err);
        (0, response_1.error)(res, 'Failed', 500);
    }
}
// ─── Admin: Approve and process a pending redemption ──────────────────────────
async function approveRedemption(req, res) {
    try {
        const { id } = req.params;
        const { note } = req.body;
        const redemption = await database_1.prisma.redemptionRequest.findUnique({
            where: { id },
            include: { user: { select: { name: true, email: true, phone: true } } },
        });
        if (!redemption) {
            (0, response_1.error)(res, 'Not found', 404);
            return;
        }
        if (redemption.status === 'completed') {
            (0, response_1.error)(res, 'Already completed', 400);
            return;
        }
        const orderId = `OP_MANUAL_${id.slice(0, 8)}_${Date.now()}`;
        let result = { success: false };
        if (redemption.type === 'UPI' && redemption.upiId) {
            result = await (0, cashfreeService_1.transferToUPI)(orderId, redemption.upiId, redemption.amountInr, redemption.user?.name || 'User', redemption.userId);
        }
        else if (redemption.type === 'BANK' && redemption.accountNumber) {
            result = await (0, cashfreeService_1.transferToBank)(orderId, redemption.accountNumber, redemption.ifscCode || '', redemption.accountName || '', redemption.amountInr, redemption.userId);
        }
        else if (['GIFT_CARD', 'GAME_CREDIT', 'RECHARGE', 'VOUCHER'].includes(redemption.type)) {
            if (redemption.productId) {
                result = await (0, xoxodayService_1.placeXoxodayOrder)(redemption.productId, redemption.denominationId || '', 1, redemption.userId, redemption.user?.email || `${redemption.userId}@offerplay.in`, orderId);
            }
            else {
                result = { success: true };
            }
        }
        else {
            result = { success: true };
        }
        if (!result.success) {
            (0, response_1.error)(res, result.error || 'Payment failed', 400);
            return;
        }
        await database_1.prisma.$transaction([
            database_1.prisma.redemptionRequest.update({
                where: { id },
                data: {
                    status: 'completed',
                    cashfreeOrderId: orderId,
                    cashfreeRefId: result.referenceId,
                    voucherCode: result.voucherCode,
                    voucherLink: result.voucherLink,
                    failureReason: note || null,
                    processedAt: new Date(),
                },
            }),
            database_1.prisma.notification.create({
                data: {
                    userId: redemption.userId,
                    title: 'Payment Processed!',
                    body: (redemption.type === 'UPI' || redemption.type === 'BANK')
                        ? `₹${redemption.amountInr} sent! Ref: ${result.referenceId || orderId}`
                        : result.voucherCode
                            ? `Voucher: ${result.voucherCode}`
                            : 'Your redemption has been processed',
                    type: 'REDEMPTION',
                },
            }),
        ]);
        (0, response_1.success)(res, {
            status: 'completed',
            referenceId: result.referenceId,
            voucherCode: result.voucherCode,
            voucherLink: result.voucherLink,
        }, 'Payment processed successfully!');
    }
    catch (err) {
        logger_1.logger.error('approveRedemption error:', err);
        (0, response_1.error)(res, 'Failed to process', 500);
    }
}
// ─── Admin: Update status + save code/note ─────────────────────────────────────
async function updateRedemptionStatus(req, res) {
    try {
        const { id } = req.params;
        const { status, failureReason, redemptionCode, adminNote, processedByAdmin } = req.body;
        const redemption = await database_1.prisma.redemptionRequest.findUnique({ where: { id } });
        if (!redemption) {
            (0, response_1.error)(res, 'Not found', 404);
            return;
        }
        await database_1.prisma.redemptionRequest.update({
            where: { id },
            data: {
                status,
                failureReason: failureReason || null,
                redemptionCode: redemptionCode || null,
                adminNote: adminNote || null,
                processedByAdmin: processedByAdmin || 'Admin',
                processedAt: ['completed', 'failed'].includes(status) ? new Date() : undefined,
            },
        });
        if (status === 'failed') {
            await database_1.prisma.$transaction([
                database_1.prisma.user.update({ where: { id: redemption.userId }, data: { coinBalance: { increment: redemption.coinsRedeemed } } }),
                database_1.prisma.transaction.create({
                    data: {
                        userId: redemption.userId,
                        type: client_1.TransactionType.REFUND,
                        amount: redemption.coinsRedeemed,
                        refId: id,
                        description: `Refund: ${failureReason || 'Rejected by admin'}`,
                    },
                }),
            ]);
        }
        if (adminNote) {
            await database_1.prisma.notification.create({
                data: {
                    userId: redemption.userId,
                    title: status === 'completed' ? '✅ Redemption Processed!' : '❌ Redemption Rejected',
                    body: adminNote,
                    type: 'REDEMPTION',
                },
            }).catch(() => { });
        }
        logger_1.logger.info(`Redemption ${id} → ${status} by ${processedByAdmin || 'Admin'}`);
        (0, response_1.success)(res, null, `Redemption ${status}`);
    }
    catch (err) {
        logger_1.logger.error('updateRedemptionStatus error:', err);
        (0, response_1.error)(res, 'Failed to update', 500);
    }
}
// ─── User: Rate a completed redemption ────────────────────────────────────────
async function rateRedemption(req, res) {
    try {
        const userId = req.userId;
        const { id } = req.params;
        const { rating, feedback } = req.body;
        if (!rating || rating < 1 || rating > 5) {
            (0, response_1.error)(res, 'Rating must be 1-5', 400);
            return;
        }
        const redemption = await database_1.prisma.redemptionRequest.findFirst({ where: { id, userId } });
        if (!redemption) {
            (0, response_1.error)(res, 'Not found', 404);
            return;
        }
        await database_1.prisma.redemptionRequest.update({ where: { id }, data: { userRating: rating, userFeedback: feedback || null } });
        (0, response_1.success)(res, null, 'Rating submitted!');
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to submit rating', 500);
    }
}
// ─── Legacy shim (used by old redeem.ts validation route) ─────────────────────
async function listOptions(_req, res) {
    (0, response_1.success)(res, { message: 'Use GET /api/redeem/packages for full list' });
}
async function redemptionHistory(req, res) {
    return getRedemptionHistory(req, res);
}
