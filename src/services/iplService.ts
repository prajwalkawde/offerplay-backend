import { prisma } from '../config/database';
import { creditCoins } from './coinService';
import { TransactionType } from '@prisma/client';
import { logger } from '../utils/logger';

export async function submitPrediction(
  userId: string,
  matchId: string,
  questionId: string,
  answer: string
): Promise<void> {
  const match = await prisma.iplMatch.findUnique({ where: { id: matchId } });
  if (!match) throw new Error('Match not found');
  if (match.status !== 'upcoming' && match.status !== 'live') throw new Error('Predictions closed');

  const question = await prisma.iplQuestion.findUnique({ where: { id: questionId } });
  if (!question || question.matchId !== matchId) throw new Error('Invalid question');
  if (question.status !== 'active') throw new Error('Question not accepting answers');

  const options = question.options as string[];
  if (!options.includes(answer)) throw new Error('Invalid answer option');

  await prisma.iplPrediction.upsert({
    where: { userId_questionId: { userId, questionId } },
    create: { userId, matchId, questionId, answer },
    update: { answer },
  });
}

export async function scoreMatch(matchId: string, results: Record<string, string>): Promise<void> {
  const questions = await prisma.iplQuestion.findMany({ where: { matchId } });

  for (const question of questions) {
    const correctAnswer = results[question.id];
    if (!correctAnswer) continue;

    await prisma.iplQuestion.update({
      where: { id: question.id },
      data: { correctAnswer, status: 'closed' },
    });

    const predictions = await prisma.iplPrediction.findMany({
      where: { questionId: question.id },
    });

    for (const pred of predictions) {
      const isCorrect = pred.answer === correctAnswer;
      const pointsEarned = isCorrect ? question.points : 0;

      await prisma.iplPrediction.update({
        where: { id: pred.id },
        data: { isCorrect, pointsEarned },
      });

      if (isCorrect && pointsEarned > 0) {
        await creditCoins(
          pred.userId,
          pointsEarned,
          TransactionType.EARN_IPL_WIN,
          matchId,
          `IPL prediction correct — ${question.question}`
        );
      }
    }
  }

  await prisma.iplMatch.update({ where: { id: matchId }, data: { status: 'completed' } });
  logger.info('IPL match scored', { matchId });
}

export async function getLeaderboard(
  limit = 50
): Promise<Array<{ userId: string; name: string | null; totalPoints: number }>> {
  const result = await prisma.iplPrediction.groupBy({
    by: ['userId'],
    _sum: { pointsEarned: true },
    orderBy: { _sum: { pointsEarned: 'desc' } },
    take: limit,
  });

  const userIds = result.map((r) => r.userId);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true },
  });

  const userMap = new Map(users.map((u) => [u.id, u.name]));

  return result.map((r) => ({
    userId: r.userId,
    name: userMap.get(r.userId) ?? null,
    totalPoints: r._sum.pointsEarned ?? 0,
  }));
}
