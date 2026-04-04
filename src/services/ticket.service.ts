/**
 * Ticket Service
 *
 * TICKETS are non-withdrawable loyalty points — no monetary value.
 * Earned by: FindMistake game (Phase 2). Spent on: entering Super Offer.
 * DO NOT mix with COINS (which are withdrawable reward currency).
 *
 * All balance mutations go through this service — never update ticketBalance directly.
 * Balance is stored on User.ticketBalance. Audit log goes to TicketTransaction.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

type TxClient = Prisma.TransactionClient;

export interface TicketHistoryResult {
  transactions: {
    id: string;
    amount: number;
    type: string;
    description: string | null;
    refId: string | null;
    createdAt: Date;
  }[];
  total: number;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getTicketBalance(uid: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { ticketBalance: true },
  });
  return user?.ticketBalance ?? 0;
}

// ─── Credit ───────────────────────────────────────────────────────────────────

export async function creditTickets(
  uid: string,
  amount: number,
  type: string,
  description: string,
  referenceId?: string,
  tx?: TxClient
): Promise<number> {
  if (amount <= 0) throw new Error('Ticket credit amount must be positive');

  const db = tx ?? prisma;

  const updatedUser = await db.user.update({
    where: { id: uid },
    data: { ticketBalance: { increment: amount } },
    select: { ticketBalance: true },
  });

  await db.ticketTransaction.create({
    data: {
      userId: uid,
      amount,
      type,
      description,
      refId: referenceId ?? null,
    },
  });

  logger.debug('Tickets credited', { uid, amount, type, newBalance: updatedUser.ticketBalance });
  return updatedUser.ticketBalance;
}

// ─── Debit ────────────────────────────────────────────────────────────────────

export async function debitTickets(
  uid: string,
  amount: number,
  type: string,
  description: string,
  referenceId?: string,
  tx?: TxClient
): Promise<number> {
  if (amount <= 0) throw new Error('Ticket debit amount must be positive');

  const db = tx ?? prisma;

  const user = await db.user.findUnique({
    where: { id: uid },
    select: { ticketBalance: true },
  });

  if (!user) throw new Error('User not found');
  if (user.ticketBalance < amount) {
    throw new Error(`Insufficient tickets — required: ${amount}, available: ${user.ticketBalance}`);
  }

  const updatedUser = await db.user.update({
    where: { id: uid },
    data: { ticketBalance: { decrement: amount } },
    select: { ticketBalance: true },
  });

  await db.ticketTransaction.create({
    data: {
      userId: uid,
      amount: -amount, // negative = debit
      type,
      description,
      refId: referenceId ?? null,
    },
  });

  logger.debug('Tickets debited', { uid, amount, type, newBalance: updatedUser.ticketBalance });
  return updatedUser.ticketBalance;
}

// ─── History ─────────────────────────────────────────────────────────────────

export async function getTicketHistory(
  uid: string,
  page: number,
  limit: number
): Promise<TicketHistoryResult> {
  const skip = (page - 1) * limit;

  const [transactions, total] = await Promise.all([
    prisma.ticketTransaction.findMany({
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
    prisma.ticketTransaction.count({ where: { userId: uid } }),
  ]);

  return { transactions, total };
}

// ─── Aggregates (for admin panel totals) ─────────────────────────────────────

export async function getTicketTotals(
  uid: string
): Promise<{ balance: number; totalEarned: number; totalSpent: number }> {
  const [user, earnedAgg, spentAgg] = await Promise.all([
    prisma.user.findUnique({ where: { id: uid }, select: { ticketBalance: true } }),
    prisma.ticketTransaction.aggregate({
      where: { userId: uid, amount: { gt: 0 } },
      _sum: { amount: true },
    }),
    prisma.ticketTransaction.aggregate({
      where: { userId: uid, amount: { lt: 0 } },
      _sum: { amount: true },
    }),
  ]);

  return {
    balance: user?.ticketBalance ?? 0,
    totalEarned: earnedAgg._sum.amount ?? 0,
    totalSpent: Math.abs(spentAgg._sum.amount ?? 0),
  };
}
