import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { getLedger } from '../services/coinService';
import { getUserStats } from '../services/scoreService';
import { getReferrals } from '../services/referralService';
import { success, error, paginated } from '../utils/response';
import { qs } from '../utils/query';
import { TransactionType } from '@prisma/client';

export async function getProfile(req: Request, res: Response): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: {
      id: true, name: true, phone: true, email: true,
      coinBalance: true, referralCode: true, language: true,
      status: true, createdAt: true,
    },
  });
  if (!user) { error(res, 'User not found', 404); return; }
  success(res, user);
}

export async function updateProfile(req: Request, res: Response): Promise<void> {
  const { name, language, fcmToken } = req.body as {
    name?: string; language?: string; fcmToken?: string;
  };

  const user = await prisma.user.update({
    where: { id: req.userId! },
    data: {
      ...(name !== undefined && { name }),
      ...(language !== undefined && { language }),
      ...(fcmToken !== undefined && { fcmToken }),
    },
    select: { id: true, name: true, language: true, fcmToken: true },
  });

  success(res, user, 'Profile updated');
}

export async function getTransactions(req: Request, res: Response): Promise<void> {
  const page = parseInt(qs(req.query.page) ?? '1', 10);
  const limit = Math.min(parseInt(qs(req.query.limit) ?? '20', 10), 100);
  const type = qs(req.query.type) as TransactionType | undefined;

  const { transactions, total } = await getLedger(req.userId!, type, limit, page);
  paginated(res, transactions as unknown[], total, page, limit);
}

export async function getStats(req: Request, res: Response): Promise<void> {
  const stats = await getUserStats(req.userId!);
  success(res, stats);
}

export async function getUserReferrals(req: Request, res: Response): Promise<void> {
  const page = parseInt(qs(req.query.page) ?? '1', 10);
  const limit = Math.min(parseInt(qs(req.query.limit) ?? '20', 10), 50);

  const { referrals, total } = await getReferrals(req.userId!, limit, page);
  paginated(res, referrals as unknown[], total, page, limit);
}

export async function getWalletData(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;

  const [user, txAgg] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { coinBalance: true, ticketBalance: true },
    }),
    prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, type: true, amount: true, description: true, createdAt: true },
    }),
  ]);

  if (!user) { error(res, 'User not found', 404); return; }

  let totalEarned = 0;
  let totalSpent = 0;
  let totalRedeemed = 0;

  for (const tx of txAgg) {
    if (tx.amount > 0) {
      totalEarned += tx.amount;
    } else if (String(tx.type).toUpperCase().includes('REDEEM')) {
      totalRedeemed += Math.abs(tx.amount);
    } else {
      totalSpent += Math.abs(tx.amount);
    }
  }

  success(res, {
    coinBalance: user.coinBalance,
    ticketBalance: user.ticketBalance,
    totalEarned,
    totalSpent,
    totalRedeemed,
    transactions: txAgg,
  });
}

export async function validateReferralCode(req: Request, res: Response): Promise<void> {
  const code = String(req.params.code).toUpperCase();
  const user = await prisma.user.findUnique({
    where: { referralCode: code },
    select: { id: true, name: true },
  });

  if (!user) { error(res, 'Invalid referral code', 404); return; }
  success(res, { valid: true, referrer: user.name });
}
