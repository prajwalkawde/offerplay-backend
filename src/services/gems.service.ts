/**
 * Gems Service
 *
 * GEMS = non-withdrawable engagement currency.
 * Earned by: passing Super Offer quiz.
 * Spent on: entering Super Offer.
 * DO NOT mix with COINS (withdrawable) or TICKETS (legacy loyalty points).
 *
 * All balance mutations go through this service — never update gemBalance directly.
 * Balance is stored on User.gemBalance. Audit log goes to GemTransaction.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

type TxClient = Prisma.TransactionClient;

export interface GemHistoryResult {
  transactions: {
    id: number;
    amount: number;
    type: string;
    description: string | null;
    refId: string | null;
    createdAt: Date;
  }[];
  total: number;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getGemBalance(uid: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { gemBalance: true },
  });
  return user?.gemBalance ?? 0;
}

// ─── Credit ───────────────────────────────────────────────────────────────────

export async function creditGems(
  uid: string,
  amount: number,
  type: string,
  description: string,
  referenceId?: string,
  tx?: TxClient
): Promise<number> {
  if (amount <= 0) throw new Error('Gem credit amount must be positive');

  const db = tx ?? prisma;

  const updatedUser = await db.user.update({
    where: { id: uid },
    data: { gemBalance: { increment: amount } },
    select: { gemBalance: true },
  });

  await db.gemTransaction.create({
    data: {
      userId: uid,
      amount,
      type,
      description,
      refId: referenceId ?? null,
    },
  });

  logger.debug('Gems credited', { uid, amount, type, newBalance: updatedUser.gemBalance });
  return updatedUser.gemBalance;
}

// ─── Debit ────────────────────────────────────────────────────────────────────

export async function debitGems(
  uid: string,
  amount: number,
  type: string,
  description: string,
  referenceId?: string,
  tx?: TxClient
): Promise<number> {
  if (amount <= 0) throw new Error('Gem debit amount must be positive');

  const db = tx ?? prisma;

  const user = await db.user.findUnique({
    where: { id: uid },
    select: { gemBalance: true },
  });

  if (!user) throw new Error('User not found');
  if (user.gemBalance < amount) {
    throw new Error(`Insufficient gems — required: ${amount}, available: ${user.gemBalance}`);
  }

  const updatedUser = await db.user.update({
    where: { id: uid },
    data: { gemBalance: { decrement: amount } },
    select: { gemBalance: true },
  });

  await db.gemTransaction.create({
    data: {
      userId: uid,
      amount: -amount, // negative = debit
      type,
      description,
      refId: referenceId ?? null,
    },
  });

  logger.debug('Gems debited', { uid, amount, type, newBalance: updatedUser.gemBalance });
  return updatedUser.gemBalance;
}

// ─── History ──────────────────────────────────────────────────────────────────

export async function getGemHistory(
  uid: string,
  page: number,
  limit: number
): Promise<GemHistoryResult> {
  const skip = (page - 1) * limit;

  const [transactions, total] = await Promise.all([
    prisma.gemTransaction.findMany({
      where: { userId: uid },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        amount: true,
        type: true,
        description: true,
        refId: true,
        createdAt: true,
      },
    }),
    prisma.gemTransaction.count({ where: { userId: uid } }),
  ]);

  return { transactions, total };
}

// ─── Aggregates ───────────────────────────────────────────────────────────────

export async function getGemTotals(
  uid: string
): Promise<{ balance: number; totalEarned: number; totalSpent: number }> {
  const [user, earnedAgg, spentAgg] = await Promise.all([
    prisma.user.findUnique({ where: { id: uid }, select: { gemBalance: true } }),
    prisma.gemTransaction.aggregate({
      where: { userId: uid, amount: { gt: 0 } },
      _sum: { amount: true },
    }),
    prisma.gemTransaction.aggregate({
      where: { userId: uid, amount: { lt: 0 } },
      _sum: { amount: true },
    }),
  ]);

  return {
    balance: user?.gemBalance ?? 0,
    totalEarned: earnedAgg._sum.amount ?? 0,
    totalSpent: Math.abs(spentAgg._sum.amount ?? 0),
  };
}
