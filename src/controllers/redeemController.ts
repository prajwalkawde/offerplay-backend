import { Request, Response } from 'express';
import { TransactionType } from '@prisma/client';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import { transferToUPI, transferToBank } from '../services/cashfreeService';
import { getXoxodayProducts, placeXoxodayOrder } from '../services/xoxodayService';

export { getXoxodayProducts };

const DEFAULT_PACKAGES = [
  { name: 'UPI ₹10',             type: 'UPI',         coinsRequired: 100,  amountInr: 10,  minCoins: 100,  icon: '💳', description: 'Transfer to UPI ID',       provider: 'cashfree' },
  { name: 'UPI ₹50',             type: 'UPI',         coinsRequired: 500,  amountInr: 50,  minCoins: 500,  icon: '💳', description: 'Transfer to UPI ID',       provider: 'cashfree' },
  { name: 'UPI ₹100',            type: 'UPI',         coinsRequired: 1000, amountInr: 100, minCoins: 1000, icon: '💳', description: 'Transfer to UPI ID',       provider: 'cashfree' },
  { name: 'Bank ₹100',           type: 'BANK',        coinsRequired: 1000, amountInr: 100, minCoins: 1000, icon: '🏦', description: 'Transfer to bank account', provider: 'cashfree' },
  { name: 'Bank ₹500',           type: 'BANK',        coinsRequired: 5000, amountInr: 500, minCoins: 5000, icon: '🏦', description: 'Transfer to bank account', provider: 'cashfree' },
  { name: 'Amazon ₹100',         type: 'GIFT_CARD',   coinsRequired: 1100, amountInr: 100, minCoins: 1100, icon: '🛍️', description: 'Amazon gift card',         provider: 'xoxoday' },
  { name: 'Flipkart ₹100',       type: 'GIFT_CARD',   coinsRequired: 1100, amountInr: 100, minCoins: 1100, icon: '🛒', description: 'Flipkart gift card',       provider: 'xoxoday' },
  { name: 'Free Fire 310 Gems',  type: 'GAME_CREDIT', coinsRequired: 2600, amountInr: 250, minCoins: 2600, icon: '🎮', description: 'Free Fire diamonds top-up', provider: 'xoxoday' },
  { name: 'Mobile Recharge ₹149',type: 'RECHARGE',    coinsRequired: 1600, amountInr: 149, minCoins: 1600, icon: '📱', description: 'Any network recharge',     provider: 'xoxoday' },
];

function redeemTransactionType(type: string): TransactionType {
  switch (type) {
    case 'GIFT_CARD':
    case 'GAME_CREDIT':
    case 'VOUCHER':   return TransactionType.REDEEM_GIFT_CARD;
    case 'RECHARGE':  return TransactionType.REDEEM_PAYTM;
    case 'BANK':
    case 'UPI':
    default:          return TransactionType.REDEEM_UPI;
  }
}

// ─── GET /redeem/packages ──────────────────────────────────────────────────────
export async function getRedeemPackages(_req: Request, res: Response): Promise<void> {
  try {
    let packages = await prisma.redeemPackage.findMany({
      where: { isActive: true },
      orderBy: { coinsRequired: 'asc' },
    });

    if (packages.length === 0) {
      await prisma.redeemPackage.createMany({ data: DEFAULT_PACKAGES, skipDuplicates: true });
      packages = await prisma.redeemPackage.findMany({
        where: { isActive: true },
        orderBy: { coinsRequired: 'asc' },
      });
    }

    success(res, packages);
  } catch (err) {
    logger.error('getRedeemPackages error:', err);
    error(res, 'Failed to get packages', 500);
  }
}

// ─── GET /redeem/gift-cards ────────────────────────────────────────────────────
export async function getGiftCards(req: Request, res: Response): Promise<void> {
  try {
    const country = String(req.query.country || 'IN');
    const category = req.query.category ? String(req.query.category) : undefined;
    const products = await getXoxodayProducts(country, category);
    success(res, { products, total: products.length });
  } catch (err) {
    logger.error('getGiftCards error:', err);
    error(res, 'Failed to get gift cards', 500);
  }
}

// ─── POST /redeem/request ──────────────────────────────────────────────────────
export async function requestRedemption(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const {
      type, coinsToRedeem,
      upiId,
      accountNumber, ifscCode, accountName, bankName,
      productId, productName, denominationId,
      mobileNumber, operator,
      gameId, gamePlayerId,
    } = req.body as {
      type: string; coinsToRedeem: number;
      upiId?: string;
      accountNumber?: string; ifscCode?: string; accountName?: string; bankName?: string;
      productId?: string; productName?: string; denominationId?: string;
      mobileNumber?: string; operator?: string;
      gameId?: string; gamePlayerId?: string;
    };

    if (!type || !coinsToRedeem) {
      error(res, 'type and coinsToRedeem are required', 400);
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { coinBalance: true, name: true, email: true },
    });
    if (!user) { error(res, 'User not found', 404); return; }
    if (user.coinBalance < coinsToRedeem) { error(res, 'Insufficient coins', 400); return; }

    const coinRate = await prisma.coinConversionRate.findFirst({ where: { countryCode: 'IN' } });
    const coinsPerUnit = coinRate?.coinsPerUnit || 10;
    const amountInr = coinsToRedeem / coinsPerUnit;

    if (amountInr < 10) {
      error(res, `Minimum redemption is ₹10 (${Math.ceil(10 * coinsPerUnit)} coins)`, 400);
      return;
    }

    const orderId = `OP_${userId.slice(0, 6)}_${Date.now()}`;

    const redemption = await prisma.redemptionRequest.create({
      data: {
        userId, type, status: 'processing',
        coinsRedeemed: coinsToRedeem, amountInr,
        upiId, accountNumber, ifscCode, accountName, bankName,
        productId, productName, denominationId,
        mobileNumber, operator, gameId, gamePlayerId,
      },
    });

    // Deduct coins immediately
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { coinBalance: { decrement: coinsToRedeem } },
      }),
      prisma.transaction.create({
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
    let result: { success: boolean; referenceId?: string; voucherCode?: string; voucherLink?: string; error?: string } = { success: false };

    if (type === 'UPI' && upiId) {
      result = await transferToUPI(orderId, upiId, amountInr, user.name || 'User', userId);
      await prisma.redemptionRequest.update({
        where: { id: redemption.id },
        data: {
          cashfreeOrderId: orderId,
          cashfreeRefId: result.referenceId,
          status: result.success ? 'completed' : 'failed',
          failureReason: result.error,
          processedAt: result.success ? new Date() : null,
        },
      });
    } else if (type === 'BANK' && accountNumber) {
      result = await transferToBank(orderId, accountNumber, ifscCode || '', accountName || '', amountInr, userId);
      await prisma.redemptionRequest.update({
        where: { id: redemption.id },
        data: {
          cashfreeOrderId: orderId,
          cashfreeRefId: result.referenceId,
          status: result.success ? 'completed' : 'failed',
          failureReason: result.error,
          processedAt: result.success ? new Date() : null,
        },
      });
    } else if ((type === 'GIFT_CARD' || type === 'GAME_CREDIT' || type === 'RECHARGE' || type === 'VOUCHER') && productId) {
      result = await placeXoxodayOrder(
        productId, denominationId || '', 1,
        userId, user.email || `${userId}@offerplay.in`, orderId
      );
      await prisma.redemptionRequest.update({
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
    } else {
      // Unknown type — just mark pending for admin review
      await prisma.redemptionRequest.update({
        where: { id: redemption.id },
        data: { status: 'pending' },
      });
      result = { success: true };
    }

    // Refund coins on failure
    if (!result.success) {
      await prisma.user.update({ where: { id: userId }, data: { coinBalance: { increment: coinsToRedeem } } });
      await prisma.redemptionRequest.update({ where: { id: redemption.id }, data: { status: 'refunded' } });
      error(res, result.error || 'Redemption failed. Coins refunded.', 400);
      return;
    }

    // Notify user
    await prisma.notification.create({
      data: {
        userId,
        title: 'Redemption Successful!',
        body: (type === 'UPI' || type === 'BANK')
          ? `₹${amountInr.toFixed(2)} will be credited within 24 hours`
          : `Your ${productName || type} voucher is ready!`,
        type: 'REDEMPTION',
      },
    });

    success(res, {
      redemptionId: redemption.id,
      type, coinsRedeemed: coinsToRedeem, amountInr,
      status: 'completed',
      voucherCode: result.voucherCode,
      voucherLink: result.voucherLink,
      referenceId: result.referenceId,
    }, 'Redemption successful!');
  } catch (err) {
    logger.error('requestRedemption error:', err);
    error(res, 'Redemption failed', 500);
  }
}

// ─── GET /redeem/history ───────────────────────────────────────────────────────
export async function getRedemptionHistory(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(50, parseInt(String(req.query.limit || '20'), 10));

    const [redemptions, total] = await Promise.all([
      prisma.redemptionRequest.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.redemptionRequest.count({ where: { userId } }),
    ]);

    success(res, { redemptions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    error(res, 'Failed to get history', 500);
  }
}

// ─── Admin: GET all redemptions ────────────────────────────────────────────────
export async function getAdminRedemptions(req: Request, res: Response): Promise<void> {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const type = req.query.type ? String(req.query.type) : undefined;
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
    const limit = Math.min(100, parseInt(String(req.query.limit || '50'), 10));

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (type) where.type = type;

    const [redemptions, total] = await Promise.all([
      prisma.redemptionRequest.findMany({
        where,
        include: { user: { select: { name: true, phone: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.redemptionRequest.count({ where }),
    ]);

    success(res, { redemptions, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    error(res, 'Failed to get redemptions', 500);
  }
}

// ─── Admin: GET redeem packages ────────────────────────────────────────────────
export async function getAdminPackages(_req: Request, res: Response): Promise<void> {
  try {
    const packages = await prisma.redeemPackage.findMany({ orderBy: { coinsRequired: 'asc' } });
    success(res, packages);
  } catch (err) {
    error(res, 'Failed to get packages', 500);
  }
}

// ─── Admin: Create or update package ──────────────────────────────────────────
export async function upsertRedeemPackage(req: Request, res: Response): Promise<void> {
  try {
    const { id, ...data } = req.body as Record<string, unknown>;
    if (id) {
      const pkg = await prisma.redeemPackage.update({ where: { id: String(id) }, data });
      success(res, pkg, 'Package updated!');
    } else {
      const pkg = await prisma.redeemPackage.create({ data: data as Parameters<typeof prisma.redeemPackage.create>[0]['data'] });
      success(res, pkg, 'Package created!');
    }
  } catch (err) {
    error(res, 'Failed to save package', 500);
  }
}

// ─── Admin: Manual process a failed redemption ────────────────────────────────
export async function manualProcessRedemption(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    const { action, note } = req.body as { action: string; note?: string };

    const redemption = await prisma.redemptionRequest.findUnique({ where: { id } });
    if (!redemption) { error(res, 'Redemption not found', 404); return; }

    if (action === 'complete') {
      await prisma.redemptionRequest.update({
        where: { id },
        data: { status: 'completed', failureReason: note, processedAt: new Date() },
      });
      success(res, null, 'Marked as completed');
      return;
    }

    if (action === 'refund') {
      await prisma.$transaction([
        prisma.redemptionRequest.update({
          where: { id },
          data: { status: 'refunded', failureReason: note },
        }),
        prisma.user.update({
          where: { id: redemption.userId },
          data: { coinBalance: { increment: redemption.coinsRedeemed } },
        }),
        prisma.transaction.create({
          data: {
            userId: redemption.userId,
            type: TransactionType.REFUND,
            amount: redemption.coinsRedeemed,
            refId: id,
            description: `Refund: ${note || 'Admin refund'}`,
          },
        }),
      ]);
      success(res, null, 'Refunded successfully');
      return;
    }

    error(res, 'Invalid action — use "complete" or "refund"', 400);
  } catch (err) {
    logger.error('manualProcessRedemption error:', err);
    error(res, 'Failed to process', 500);
  }
}

// ─── Admin: Get single redemption with user history ───────────────────────────
export async function getRedemptionDetails(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params as { id: string };

    const redemption = await prisma.redemptionRequest.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, name: true, phone: true, email: true, coinBalance: true, createdAt: true },
        },
      },
    });
    if (!redemption) { error(res, 'Not found', 404); return; }

    const [transactions, earnedAgg, redeemedAgg, totalAgg] = await Promise.all([
      prisma.transaction.findMany({
        where: { userId: redemption.userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.transaction.aggregate({
        where: { userId: redemption.userId, amount: { gt: 0 } },
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        where: {
          userId: redemption.userId,
          type: { in: [TransactionType.REDEEM_UPI, TransactionType.REDEEM_GIFT_CARD, TransactionType.REDEEM_PAYTM] },
        },
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        where: { userId: redemption.userId },
        _count: { id: true },
      }),
    ]);

    success(res, {
      redemption,
      userStats: {
        totalEarned: earnedAgg._sum.amount || 0,
        totalRedeemed: Math.abs(redeemedAgg._sum.amount || 0),
        currentBalance: redemption.user?.coinBalance || 0,
        totalTransactions: totalAgg._count.id,
      },
      transactions,
    });
  } catch (err) {
    logger.error('getRedemptionDetails error:', err);
    error(res, 'Failed', 500);
  }
}

// ─── Admin: Approve and process a pending redemption ──────────────────────────
export async function approveRedemption(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    const { note } = req.body as { note?: string };

    const redemption = await prisma.redemptionRequest.findUnique({
      where: { id },
      include: { user: { select: { name: true, email: true, phone: true } } },
    });
    if (!redemption) { error(res, 'Not found', 404); return; }
    if (redemption.status === 'completed') { error(res, 'Already completed', 400); return; }

    const orderId = `OP_MANUAL_${id.slice(0, 8)}_${Date.now()}`;
    let result: { success: boolean; referenceId?: string; voucherCode?: string; voucherLink?: string; error?: string } = { success: false };

    if (redemption.type === 'UPI' && redemption.upiId) {
      result = await transferToUPI(orderId, redemption.upiId, redemption.amountInr, redemption.user?.name || 'User', redemption.userId);
    } else if (redemption.type === 'BANK' && redemption.accountNumber) {
      result = await transferToBank(orderId, redemption.accountNumber, redemption.ifscCode || '', redemption.accountName || '', redemption.amountInr, redemption.userId);
    } else if (['GIFT_CARD', 'GAME_CREDIT', 'RECHARGE', 'VOUCHER'].includes(redemption.type)) {
      if (redemption.productId) {
        result = await placeXoxodayOrder(
          redemption.productId,
          redemption.denominationId || '',
          1,
          redemption.userId,
          redemption.user?.email || `${redemption.userId}@offerplay.in`,
          orderId
        );
      } else {
        result = { success: true };
      }
    } else {
      result = { success: true };
    }

    if (!result.success) { error(res, result.error || 'Payment failed', 400); return; }

    await prisma.$transaction([
      prisma.redemptionRequest.update({
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
      prisma.notification.create({
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

    success(res, {
      status: 'completed',
      referenceId: result.referenceId,
      voucherCode: result.voucherCode,
      voucherLink: result.voucherLink,
    }, 'Payment processed successfully!');
  } catch (err) {
    logger.error('approveRedemption error:', err);
    error(res, 'Failed to process', 500);
  }
}

// ─── Legacy shim (used by old redeem.ts validation route) ─────────────────────
export async function listOptions(_req: Request, res: Response): Promise<void> {
  success(res, { message: 'Use GET /api/redeem/packages for full list' });
}

export async function redemptionHistory(req: Request, res: Response): Promise<void> {
  return getRedemptionHistory(req, res);
}
