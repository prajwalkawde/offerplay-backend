import { prisma } from '../config/database';
import { escrowCoins, awardPrizes, refundEscrow } from './coinService';
import { ContestStatus, ContestType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';

export async function joinContest(contestId: string, userId: string): Promise<{ playToken: string }> {
  const contest = await prisma.contest.findUnique({ where: { id: contestId } });
  if (!contest) throw new Error('Contest not found');
  if (contest.status !== ContestStatus.REGISTRATION_OPEN) throw new Error('Registration not open');
  if (contest.currentPlayers >= contest.maxPlayers) throw new Error('Contest is full');

  const existing = await prisma.participant.findUnique({
    where: { contestId_userId: { contestId, userId } },
  });
  if (existing) throw new Error('Already joined this contest');

  const playToken = uuidv4();

  await prisma.$transaction([
    prisma.participant.create({
      data: { contestId, userId, playToken, coinsEscrowed: 0 },
    }),
    prisma.contest.update({
      where: { id: contestId },
      data: { currentPlayers: { increment: 1 } },
    }),
  ]);

  if (contest.entryFee > 0) {
    await escrowCoins(userId, contest.entryFee, contestId);
  }

  // Auto-start ONE_V_ONE when full
  if (contest.type === ContestType.ONE_V_ONE && contest.currentPlayers + 1 >= contest.maxPlayers) {
    await prisma.contest.update({
      where: { id: contestId },
      data: { status: ContestStatus.GAMEPLAY_ACTIVE },
    });
  }

  return { playToken };
}

export async function submitScore(
  contestId: string,
  userId: string,
  score: number
): Promise<{ rank: number | null }> {
  const participant = await prisma.participant.findUnique({
    where: { contestId_userId: { contestId, userId } },
  });
  if (!participant) throw new Error('Not a participant');

  const contest = await prisma.contest.findUnique({ where: { id: contestId } });
  if (!contest || contest.status !== ContestStatus.GAMEPLAY_ACTIVE) {
    throw new Error('Contest not active');
  }

  // Only update if score is higher
  if (score > participant.score) {
    await prisma.participant.update({
      where: { id: participant.id },
      data: { score, lastScoreAt: new Date() },
    });
  }

  // For ONE_V_ONE check if both have submitted
  if (contest.type === ContestType.ONE_V_ONE) {
    const now = new Date();
    if (now >= contest.gameEndTime) {
      await finalizeContest(contestId);
    }
  }

  const allParticipants = await prisma.participant.findMany({
    where: { contestId },
    orderBy: { score: 'desc' },
  });

  const rank = allParticipants.findIndex((p) => p.userId === userId) + 1;
  return { rank };
}

export async function finalizeContest(contestId: string): Promise<void> {
  const contest = await prisma.contest.findUnique({ where: { id: contestId } });
  if (!contest || contest.status === ContestStatus.COMPLETED) return;

  await prisma.contest.update({
    where: { id: contestId },
    data: { status: ContestStatus.SCORING },
  });

  if (contest.currentPlayers < contest.minPlayers) {
    await refundEscrow(contestId);
    await prisma.contest.update({
      where: { id: contestId },
      data: { status: ContestStatus.CANCELLED },
    });
    logger.info('Contest cancelled — insufficient players', { contestId });
    return;
  }

  await awardPrizes(contestId);
  await prisma.contest.update({
    where: { id: contestId },
    data: { status: ContestStatus.COMPLETED },
  });

  logger.info('Contest finalized', { contestId });
}

export async function getLeaderboard(
  contestId: string
): Promise<Array<{ rank: number; userId: string; name: string | null; score: number }>> {
  const participants = await prisma.participant.findMany({
    where: { contestId },
    include: { user: { select: { name: true } } },
    orderBy: { score: 'desc' },
  });

  return participants.map((p, idx) => ({
    rank: idx + 1,
    userId: p.userId,
    name: p.user.name,
    score: p.score,
  }));
}
