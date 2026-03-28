import { prisma } from '../config/database';
import { logger } from '../utils/logger';

export const getTicketBalance = async (userId: string): Promise<number> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ticketBalance: true },
  });
  return user?.ticketBalance || 0;
};

export const creditTickets = async (
  userId: string,
  amount: number,
  reason: string,
  refId?: string
): Promise<number> => {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  const [user] = await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { ticketBalance: { increment: amount } },
    }),
    prisma.ticketTransaction.create({
      data: {
        userId,
        amount,
        type: 'EARN_TICKET',
        refId,
        description: reason,
        expiresAt,
      },
    }),
  ]);

  logger.info(`Tickets credited: ${userId} +${amount} (${reason})`);
  return user.ticketBalance;
};

export const spendTickets = async (
  userId: string,
  amount: number,
  reason: string,
  refId?: string
): Promise<{ success: boolean; newBalance: number; error?: string }> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ticketBalance: true },
  });

  if (!user || user.ticketBalance < amount) {
    return {
      success: false,
      newBalance: user?.ticketBalance || 0,
      error: `Insufficient tickets. Need ${amount}, have ${user?.ticketBalance || 0}`,
    };
  }

  const [updated] = await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { ticketBalance: { decrement: amount } },
    }),
    prisma.ticketTransaction.create({
      data: {
        userId,
        amount: -amount,
        type: 'SPEND_TICKET',
        refId,
        description: reason,
      },
    }),
  ]);

  return { success: true, newBalance: updated.ticketBalance };
};
