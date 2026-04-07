import { Request, Response } from 'express';
import { TransactionType } from '@prisma/client';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import { transferToUPI, transferToBank } from '../services/cashfreeService';
import { getXoxodayProducts, placeXoxodayOrder } from '../services/xoxodayService';
import { checkRedemptionFraud } from '../services/fraudDetectionService';

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
export async function getRedeemPackages(req: Request, res: Response): Promise<void> {
  try {
    let allPackages = await prisma.redeemPackage.findMany({
      where: { isActive: true },
      orderBy: [
        { isFeatured: 'desc' },
        { isPopular: 'desc' },
        { sortOrder: 'asc' },
        { coinsRequired: 'asc' },
      ],
    });

    if (allPackages.length === 0) {
      await prisma.redeemPackage.createMany({ data: DEFAULT_PACKAGES, skipDuplicates: true });
      allPackages = await prisma.redeemPackage.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { coinsRequired: 'asc' }],
      });
    }

    // Determine user's country
    let userCountry = 'IN';
    const userId = req.userId;
    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { country: true },
      });
      userCountry = user?.country || 'IN';
    }

    // Filter by country — include package if:
    //   - availableIn contains userCountry or "GLOBAL"
    //   - or isDefault is true
    const countryPackages = allPackages.filter(p => {
      const available = (p.availableIn as string[]) || ['IN'];
      return available.includes(userCountry) || available.includes('GLOBAL') || p.isDefault;
    });

    // Fallback chain: country match → default only → all
    const finalPackages = countryPackages.length > 0
      ? countryPackages
      : allPackages.filter(p => p.isDefault).length > 0
        ? allPackages.filter(p => p.isDefault)
        : allPackages;

    success(res, finalPackages);
  } catch (err) {
    logger.error('getRedeemPackages error:', err);
    error(res, 'Failed to get packages', 500);
  }
}

// ─── GET /redeem/gift-cards ────────────────────────────────────────────────────
export async function getGiftCards(req: Request, res: Response): Promise<void> {
  try {
    const country  = req.query.country  ? String(req.query.country)  : undefined;
    const category = req.query.category ? String(req.query.category) : undefined;
    const products = await getXoxodayProducts({ country, category });
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
      accountNumber, ifscCode, accountName, bankName, transferMode,
      productId, productName, denominationId,
      mobileNumber, operator,
      gameId, gamePlayerId,
      customFieldValues,
      packageId,
    } = req.body as {
      type: string; coinsToRedeem: number;
      upiId?: string;
      accountNumber?: string; ifscCode?: string; accountName?: string; bankName?: string;
      transferMode?: 'imps' | 'neft' | 'rtgs';
      productId?: string; productName?: string; denominationId?: string;
      mobileNumber?: string; operator?: string;
      gameId?: string; gamePlayerId?: string;
      customFieldValues?: Record<string, string>;
      packageId?: string;
    };

    if (!type || !coinsToRedeem) {
      error(res, 'type and coinsToRedeem are required', 400);
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { coinBalance: true, name: true, email: true, phone: true },
    });
    if (!user) { error(res, 'User not found', 404); return; }

    // ── Security: For Xoxoday products, resolve authoritative values from DB ──
    // Never trust client-supplied coinsToRedeem or denominationId for gift cards.
    // A malicious user could send coinsToRedeem:1 with denominationId:"1000" to
    // obtain a ₹1000 voucher for 1 coin. We override with package DB values.
    let resolvedCoins       = coinsToRedeem;
    let resolvedAmountInr:  number | null = null;   // set from package — overrides coin-rate calc
    let resolvedDenomination = denominationId || '';
    let pkgRedeemUrl: string | null = null;

    const isXoxodayType = ['GIFT_CARD', 'GAME_CREDIT', 'RECHARGE', 'VOUCHER'].includes(type);

    if (packageId) {
      const pkg = await prisma.redeemPackage.findUnique({
        where: { id: packageId, isActive: true },
        select: { coinsRequired: true, amountInr: true, redeemUrl: true },
      });
      if (!pkg) {
        error(res, 'Invalid or inactive package', 400);
        return;
      }
      pkgRedeemUrl = pkg.redeemUrl || null;
      // Always use package's authoritative coin count and INR amount —
      // prevents both under-paying (wrong coinsToRedeem) and mis-priced UPI/bank transfers
      resolvedCoins     = pkg.coinsRequired;
      resolvedAmountInr = pkg.amountInr;
      if (isXoxodayType) {
        resolvedDenomination = pkg.amountInr.toString();
      }
    } else if (isXoxodayType) {
      // No packageId for a Xoxoday product — validate denomination matches coins
      const coinRate2 = await prisma.coinConversionRate.findFirst({ where: { countryCode: 'IN' } });
      const rate2     = coinRate2?.coinsPerUnit || 100;
      const expected  = coinsToRedeem / rate2;
      const requested = parseFloat(denominationId || '0');
      if (Math.abs(requested - expected) > 1) {
        error(res, 'Denomination does not match coins redeemed', 400);
        return;
      }
    }

    if (user.coinBalance < resolvedCoins) { error(res, 'Insufficient coins', 400); return; }

    const coinRate = await prisma.coinConversionRate.findFirst({ where: { countryCode: 'IN' } });
    const coinsPerUnit = coinRate?.coinsPerUnit || 100;
    // Use package amountInr if available; fall back to coin-rate calculation
    const amountInr = resolvedAmountInr ?? (resolvedCoins / coinsPerUnit);

    const orderId = `OP_${userId.slice(0, 6)}_${Date.now()}`;

    const redemption = await prisma.redemptionRequest.create({
      data: {
        userId, type, status: 'processing',
        coinsRedeemed: resolvedCoins, amountInr,
        upiId, accountNumber, ifscCode, accountName, bankName,
        productId, productName, denominationId,
        mobileNumber, operator, gameId, gamePlayerId,
        // Merge customFieldValues with transferMode so approveRedemption can reuse it
        customFieldValues: {
          ...(customFieldValues || {}),
          ...(transferMode ? { transferMode } : {}),
        },
        ...(pkgRedeemUrl ? { redeemUrl: pkgRedeemUrl } : {}),
      },
    });

    // Admin notification log for new redemption
    logger.info(`[REDEMPTION] New request #${redemption.id} | user=${userId} | type=${type} | coins=${resolvedCoins} | ₹${amountInr.toFixed(2)}`);

    // Deduct coins immediately
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { coinBalance: { decrement: resolvedCoins } },
      }),
      prisma.transaction.create({
        data: {
          userId,
          type: redeemTransactionType(type),
          amount: resolvedCoins,
          refId: redemption.id,
          description: `Redemption: ${type} — ₹${amountInr.toFixed(2)}`,
        },
      }),
    ]);

    // ── Fraud detection gate ──────────────────────────────────────────────────
    // Run before any payment API is called. Suspicious requests are held as
    // 'pending' for admin review — coins are already deducted (held in escrow).
    const fraudResult = await checkRedemptionFraud(userId, resolvedCoins, amountInr);

    if (fraudResult.requiresReview) {
      const fraudMeta: Record<string, string> = {
        fraudScore:     String(fraudResult.score),
        fraudRiskLevel: fraudResult.riskLevel,
        fraudSignals:   fraudResult.signals.map(s => s.code).join(','),
        fraudDetails:   JSON.stringify(fraudResult.signals),
      };
      await prisma.redemptionRequest.update({
        where: { id: redemption.id },
        data: {
          status: 'pending',
          adminNote: `[AUTO-HOLD] Risk score ${fraudResult.score}/100 (${fraudResult.riskLevel.toUpperCase()}) — ${fraudResult.signals.map(s => s.code).join(', ')}`,
          customFieldValues: fraudMeta,
        },
      });
      logger.warn(`[FraudGate] HELD redemption ${redemption.id} | user=${userId} | score=${fraudResult.score} | signals=${fraudMeta.fraudSignals}`);
      // Tell user it's under review (no mention of fraud — just processing)
      success(res, {
        redemptionId: redemption.id,
        status:       'pending',
        coinsRedeemed: resolvedCoins,
        amountInr,
      }, 'Your redemption is being reviewed. We\'ll process it within 24 hours.');
      return;
    }

    // Process by type
    let result: { success: boolean; referenceId?: string; voucherCode?: string; voucherPin?: string; voucherLink?: string; validity?: string; error?: string } = { success: false };

    if (type === 'UPI' && upiId) {
      result = await transferToUPI(orderId, upiId, amountInr, user.name || 'User', userId, user.phone || undefined, user.email || undefined);
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
      result = await transferToBank(orderId, accountNumber, ifscCode || '', accountName || '', amountInr, userId, transferMode || 'imps', user.phone || undefined, user.email || undefined);
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
        productId, resolvedDenomination, 1,
        userId, user.email || `${userId}@offerplay.in`, orderId
      );
      // Store pin + validity in customFieldValues (no migration needed)
      const xoxoMeta: Record<string, string> = {};
      if (result.voucherPin)  xoxoMeta.pin      = result.voucherPin;
      if (result.validity)    xoxoMeta.validity  = result.validity;
      await prisma.redemptionRequest.update({
        where: { id: redemption.id },
        data: {
          xoxodayOrderId: orderId,
          voucherCode:    result.voucherCode,
          voucherLink:    result.voucherLink,   // only set when no direct code
          status:         result.success ? 'completed' : 'failed',
          failureReason:  result.error,
          processedAt:    result.success ? new Date() : null,
          ...(Object.keys(xoxoMeta).length > 0 ? { customFieldValues: xoxoMeta } : {}),
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
      await prisma.user.update({ where: { id: userId }, data: { coinBalance: { increment: resolvedCoins } } });
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
      type, coinsRedeemed: resolvedCoins, amountInr,
      status: 'completed',
      voucherCode: result.voucherCode,
      voucherPin:  result.voucherPin,
      voucherLink: result.voucherLink,
      validity:    result.validity,
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

// ─── Admin: Delete package ─────────────────────────────────────────────────────
export async function deleteRedeemPackage(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    await prisma.redeemPackage.delete({ where: { id } });
    success(res, null, 'Package deleted');
  } catch (err) {
    error(res, 'Failed to delete package', 500);
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

    const accountAgeDays = Math.floor(
      (Date.now() - new Date(redemption.user?.createdAt || Date.now()).getTime()) / 86400000
    );
    const [todayRedemptions, totalRedemptions] = await Promise.all([
      prisma.redemptionRequest.count({
        where: { userId: redemption.userId, createdAt: { gte: new Date(new Date().setHours(0,0,0,0)) } },
      }),
      prisma.redemptionRequest.count({ where: { userId: redemption.userId } }),
    ]);

    const totalEarned   = earnedAgg._sum.amount || 0;
    const totalRedeemed = Math.abs(redeemedAgg._sum.amount || 0);

    // Use stored fraud data if this was auto-held, otherwise compute live
    const cfv = (redemption.customFieldValues as Record<string, string> | null) || {};
    let fraudScore    = cfv.fraudScore    ? parseInt(cfv.fraudScore, 10) : undefined;
    let fraudSignals: Array<{ code: string; weight: number; description: string }> | undefined;
    let fraudRiskLevel: string | undefined = cfv.fraudRiskLevel;

    if (cfv.fraudDetails) {
      try { fraudSignals = JSON.parse(cfv.fraudDetails); } catch (_) { /* ignore */ }
    }

    // If no stored fraud data (old record or non-held), compute a live score
    if (fraudScore === undefined) {
      const { checkRedemptionFraud: liveCheck } = await import('../services/fraudDetectionService');
      const live = await liveCheck(redemption.userId, redemption.coinsRedeemed, redemption.amountInr);
      fraudScore    = live.score;
      fraudSignals  = live.signals;
      fraudRiskLevel = live.riskLevel;
    }

    success(res, {
      redemption,
      userStats: {
        totalEarned,
        totalRedeemed,
        currentBalance:       redemption.user?.coinBalance || 0,
        totalTransactions:    totalAgg._count.id,
        accountAgeDays,
        todayRedemptions,
        offerwallEarnings:    0,  // kept for UI compat
        totalRedemptionCount: totalRedemptions,
      },
      transactions,
      fraudScore,
      fraudRiskLevel,
      fraudSignals,
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
    let result: { success: boolean; referenceId?: string; voucherCode?: string; voucherPin?: string; voucherLink?: string; validity?: string; error?: string } = { success: false };

    if (redemption.type === 'UPI' && redemption.upiId) {
      result = await transferToUPI(orderId, redemption.upiId, redemption.amountInr, redemption.user?.name || 'User', redemption.userId, redemption.user?.phone || undefined, redemption.user?.email || undefined);
    } else if (redemption.type === 'BANK' && redemption.accountNumber) {
      const cfv = (redemption.customFieldValues as Record<string, string> | null) || {};
      const savedMode = (cfv.transferMode as 'imps' | 'neft' | 'rtgs') || 'imps';
      result = await transferToBank(orderId, redemption.accountNumber, redemption.ifscCode || '', redemption.accountName || '', redemption.amountInr, redemption.userId, savedMode, redemption.user?.phone || undefined, redemption.user?.email || undefined);
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

    const xoxoMetaApproval: Record<string, string> = {};
    if (result.voucherPin) xoxoMetaApproval.pin     = result.voucherPin;
    if (result.validity)   xoxoMetaApproval.validity = result.validity;
    await prisma.$transaction([
      prisma.redemptionRequest.update({
        where: { id },
        data: {
          status: 'completed',
          cashfreeOrderId: orderId,
          cashfreeRefId:   result.referenceId,
          voucherCode:     result.voucherCode,
          voucherLink:     result.voucherLink,
          failureReason:   note || null,
          processedAt:     new Date(),
          ...(Object.keys(xoxoMetaApproval).length > 0 ? { customFieldValues: xoxoMetaApproval } : {}),
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

// ─── Admin: Update status + save code/note ─────────────────────────────────────
export async function updateRedemptionStatus(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    const { status, failureReason, redemptionCode, adminNote, processedByAdmin } = req.body as {
      status: string; failureReason?: string;
      redemptionCode?: string; adminNote?: string; processedByAdmin?: string;
    };

    const redemption = await prisma.redemptionRequest.findUnique({ where: { id } });
    if (!redemption) { error(res, 'Not found', 404); return; }

    await prisma.redemptionRequest.update({
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
      await prisma.$transaction([
        prisma.user.update({ where: { id: redemption.userId }, data: { coinBalance: { increment: redemption.coinsRedeemed } } }),
        prisma.transaction.create({
          data: {
            userId: redemption.userId,
            type: TransactionType.REFUND,
            amount: redemption.coinsRedeemed,
            refId: id,
            description: `Refund: ${failureReason || 'Rejected by admin'}`,
          },
        }),
      ]);
    }

    if (adminNote) {
      await prisma.notification.create({
        data: {
          userId: redemption.userId,
          title: status === 'completed' ? '✅ Redemption Processed!' : '❌ Redemption Rejected',
          body: adminNote,
          type: 'REDEMPTION',
        },
      }).catch(() => {});
    }

    logger.info(`Redemption ${id} → ${status} by ${processedByAdmin || 'Admin'}`);
    success(res, null, `Redemption ${status}`);
  } catch (err) {
    logger.error('updateRedemptionStatus error:', err);
    error(res, 'Failed to update', 500);
  }
}

// ─── User: Rate a completed redemption ────────────────────────────────────────
export async function rateRedemption(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.userId!;
    const { id } = req.params as { id: string };
    const { rating, feedback } = req.body as { rating: number; feedback?: string };

    if (!rating || rating < 1 || rating > 5) { error(res, 'Rating must be 1-5', 400); return; }

    const redemption = await prisma.redemptionRequest.findFirst({ where: { id, userId } });
    if (!redemption) { error(res, 'Not found', 404); return; }

    await prisma.redemptionRequest.update({ where: { id }, data: { userRating: rating, userFeedback: feedback || null } });
    success(res, null, 'Rating submitted!');
  } catch (err) {
    error(res, 'Failed to submit rating', 500);
  }
}

// ─── Legacy shim (used by old redeem.ts validation route) ─────────────────────
export async function listOptions(_req: Request, res: Response): Promise<void> {
  success(res, { message: 'Use GET /api/redeem/packages for full list' });
}

export async function redemptionHistory(req: Request, res: Response): Promise<void> {
  return getRedemptionHistory(req, res);
}

// ─── Admin: Reject a redemption ───────────────────────────────────────────────
// refundCoins=true  → coins returned to user (default for fraud holds)
// refundCoins=false → coins forfeited (use for confirmed fraud / abuse)
export async function rejectRedemption(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    const { reason, refundCoins = true } = req.body as { reason?: string; refundCoins?: boolean };

    const redemption = await prisma.redemptionRequest.findUnique({ where: { id } });
    if (!redemption) { error(res, 'Not found', 404); return; }
    if (redemption.status === 'completed') { error(res, 'Cannot reject a completed redemption', 400); return; }
    if (redemption.status === 'failed')    { error(res, 'Already rejected', 400); return; }

    const rejectReason = reason || (refundCoins ? 'Redemption rejected — coins refunded' : 'Redemption rejected — coins forfeited');

    await prisma.$transaction([
      prisma.redemptionRequest.update({
        where: { id },
        data: {
          status:           'failed',
          failureReason:    rejectReason,
          processedAt:      new Date(),
          processedByAdmin: 'Admin',
        },
      }),
      prisma.notification.create({
        data: {
          userId: redemption.userId,
          title:  '❌ Redemption Rejected',
          body:   rejectReason,
          type:   'REDEMPTION',
        },
      }),
      ...(refundCoins ? [
        prisma.user.update({
          where: { id: redemption.userId },
          data:  { coinBalance: { increment: redemption.coinsRedeemed } },
        }),
        prisma.transaction.create({
          data: {
            userId:      redemption.userId,
            type:        TransactionType.REFUND,
            amount:      redemption.coinsRedeemed,
            refId:       id,
            description: `Refund: ${rejectReason}`,
          },
        }),
      ] : []),
    ]);

    logger.info(`[RejectRedemption] id=${id} | userId=${redemption.userId} | refundCoins=${refundCoins} | coins=${redemption.coinsRedeemed} | reason=${rejectReason}`);
    success(res, { refundCoins, coinsReturned: refundCoins ? redemption.coinsRedeemed : 0 },
      refundCoins ? 'Redemption rejected and coins refunded' : 'Redemption rejected — coins forfeited');
  } catch (err) {
    logger.error('rejectRedemption error:', err);
    error(res, 'Failed to reject', 500);
  }
}
