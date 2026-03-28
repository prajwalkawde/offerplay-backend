import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { qs } from '../utils/query';

export async function listGames(req: Request, res: Response): Promise<void> {
  const category = qs(req.query.category);

  const games = await prisma.game.findMany({
    where: { isActive: true, ...(category && { category }) },
    select: { id: true, name: true, description: true, icon: true, category: true, gameUrl: true },
    orderBy: { createdAt: 'desc' },
  });

  success(res, games);
}

export async function getGame(req: Request, res: Response): Promise<void> {
  const game = await prisma.game.findUnique({
    where: { id: req.params.id as string },
    select: {
      id: true, name: true, description: true, icon: true,
      category: true, gameUrl: true, gameHtml: true,
    },
  });

  if (!game) { error(res, 'Game not found', 404); return; }
  success(res, game);
}
