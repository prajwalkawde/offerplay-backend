import { prisma } from '../config/database';
import { debitCoins } from './coinService';
import { TransactionType } from '@prisma/client';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import axios from 'axios';

export interface RedeemRequest {
  userId: string;
  method: 'UPI' | 'PAYTM' | 'PAYPAL' | 'GIFT_CARD';
  coins: number;
  details: Record<string, string>;
}

const COIN_TO_INR = 100; // 100 coins = ₹1

const MIN_REDEEM: Record<string, number> = {
  UPI: 5000,
  PAYTM: 5000,
  PAYPAL: 10000,
  GIFT_CARD: 2000,
};

export function getRedeemOptions(): Array<{
  method: string;
  minCoins: number;
  inrEquivalent: number;
  label: string;
}> {
  return [
    { method: 'UPI', minCoins: 5000, inrEquivalent: 50, label: 'UPI Transfer (₹50+)' },
    { method: 'PAYTM', minCoins: 5000, inrEquivalent: 50, label: 'Paytm Wallet (₹50+)' },
    { method: 'PAYPAL', minCoins: 10000, inrEquivalent: 100, label: 'PayPal (₹100+)' },
    { method: 'GIFT_CARD', minCoins: 2000, inrEquivalent: 20, label: 'Gift Card (₹20+)' },
  ];
}

export async function createRedemption(req: RedeemRequest): Promise<{ redemptionId: string }> {
  const minCoins = MIN_REDEEM[req.method];
  if (!minCoins) throw new Error('Invalid redemption method');
  if (req.coins < minCoins) throw new Error(`Minimum ${minCoins} coins required`);

  const typeMap: Record<string, TransactionType> = {
    UPI: TransactionType.REDEEM_UPI,
    PAYTM: TransactionType.REDEEM_PAYTM,
    PAYPAL: TransactionType.REDEEM_PAYPAL,
    GIFT_CARD: TransactionType.REDEEM_GIFT_CARD,
  };

  await debitCoins(req.userId, req.coins, typeMap[req.method], undefined, `Redeem via ${req.method}`);

  // Trigger Xoxoday payout if configured
  const redemptionId = await triggerXoxodayPayout(req);

  logger.info('Redemption created', { userId: req.userId, method: req.method, coins: req.coins });
  return { redemptionId };
}

async function triggerXoxodayPayout(req: RedeemRequest): Promise<string> {
  if (!env.XOXODAY_API_KEY || env.XOXODAY_API_KEY === 'your-xoxoday-key') {
    // Mock payout in dev
    return `mock-${Date.now()}`;
  }

  try {
    const inrAmount = req.coins / COIN_TO_INR;
    const res = await axios.post(
      'https://api.xoxoday.com/v1/payout',
      {
        apiKey: env.XOXODAY_API_KEY,
        method: req.method,
        amount: inrAmount,
        currency: 'INR',
        details: req.details,
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
    return res.data?.payoutId ?? `xoxy-${Date.now()}`;
  } catch (err) {
    logger.error('Xoxoday payout failed', { err });
    throw new Error('Payout provider unavailable');
  }
}

export async function getRedemptionHistory(
  userId: string,
  limit = 20,
  page = 1
): Promise<{ items: unknown[]; total: number }> {
  const skip = (page - 1) * limit;
  const typeList: TransactionType[] = [
    TransactionType.REDEEM_UPI,
    TransactionType.REDEEM_PAYTM,
    TransactionType.REDEEM_PAYPAL,
    TransactionType.REDEEM_GIFT_CARD,
  ];

  const where = { userId, type: { in: typeList } };
  const [items, total] = await Promise.all([
    prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.transaction.count({ where }),
  ]);

  return { items, total };
}
