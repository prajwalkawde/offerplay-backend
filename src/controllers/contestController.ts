import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { joinContest, submitScore, getLeaderboard } from '../services/contestService';
import { success, error, paginated } from '../utils/response';
import { qs } from '../utils/query';
import { ContestStatus, ContestType } from '@prisma/client';

export async function listContests(req: Request, res: Response): Promise<void> {
  const status = qs(req.query.status) as ContestStatus | undefined;
  const type = qs(req.query.type) as ContestType | undefined;
  const page = parseInt(qs(req.query.page) ?? '1', 10);
  const limit = Math.min(parseInt(qs(req.query.limit) ?? '20', 10), 100);
  const skip = (page - 1) * limit;

  const where = {
    ...(status && { status }),
    ...(type && { type }),
  };

  const [contests, total] = await Promise.all([
    prisma.contest.findMany({
      where,
      include: { game: { select: { id: true, name: true, icon: true } } },
      orderBy: { regStartTime: 'desc' },
      skip,
      take: limit,
    }),
    prisma.contest.count({ where }),
  ]);

  paginated(res, contests, total, page, limit);
}

export async function getContest(req: Request, res: Response): Promise<void> {
  const contest = await prisma.contest.findUnique({
    where: { id: req.params.id as string },
    include: {
      game: true,
      participants: {
        include: { user: { select: { id: true, name: true } } },
        orderBy: { score: 'desc' },
        take: 10,
      },
    },
  });

  if (!contest) { error(res, 'Contest not found', 404); return; }
  success(res, contest);
}

export async function joinContestHandler(req: Request, res: Response): Promise<void> {
  try {
    const result = await joinContest(req.params.id as string, req.userId!);
    success(res, result, 'Joined contest successfully', 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to join contest';
    error(res, msg, 400);
  }
}

export async function submitScoreHandler(req: Request, res: Response): Promise<void> {
  const { score } = req.body as { score: number };

  try {
    const result = await submitScore(req.params.id as string, req.userId!, score);
    success(res, result, 'Score submitted');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to submit score';
    error(res, msg, 400);
  }
}

export async function getContestLeaderboard(req: Request, res: Response): Promise<void> {
  const leaderboard = await getLeaderboard(req.params.id as string);
  success(res, leaderboard);
}
