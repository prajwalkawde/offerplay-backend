import { Router, Request, Response } from 'express';
import { authMiddleware as auth } from '../middleware/auth';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';

const router = Router();

// GET /api/offerwall/featured
// Returns active custom/partner offers enriched for display, excluding maxed-out ones
router.get('/featured', auth, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const limit  = Math.min(parseInt(req.query.limit as string) || 10, 20);

    const customOffers = await prisma.customOffer.findMany({
      where: { isActive: true, isFeatured: true },
      include: {
        stages: { include: { tasks: true } },
        completions: true,
      },
      take: limit,
      orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }],
    });

    const featured = customOffers
      .filter(o => {
        const c = o.completions.find((cp: any) => cp.userId === userId);
        return !c || c.status !== 'completed';
      })
      .map(o => {
        const totalTickets = o.stages.reduce(
          (sum: number, stage: any) =>
            sum + stage.tasks.reduce(
              (s: number, t: any) => s + (t.rewardTickets || 0), 0
            ), 0
        );
        const totalCoins = o.stages.reduce(
          (sum: number, stage: any) =>
            sum + stage.tasks.reduce(
              (s: number, t: any) => s + (t.rewardCoins || 0), 0
            ), 0
        );
        return {
          id:           o.id,
          offerId:      o.id,
          name:         o.title,
          title:        o.title,
          description:  o.description,
          icon_url:     o.logoUrl,
          coins:        totalCoins > 0 ? totalCoins : null,
          payout_coins: totalCoins > 0 ? totalCoins : null,
          rewardTickets: totalTickets > 0 ? totalTickets : null,
          rewardCoins:  totalCoins > 0 ? totalCoins : null,
          difficulty:   'Easy',
          time_estimate: `${o.stages.length} stage${o.stages.length !== 1 ? 's' : ''}`,
          category:     'PARTNER',
          isCustomOffer: true,
          partnerName:  o.partnerName,
          badgeText:    o.badgeText || '🔥 PARTNER',
          badgeColor:   o.badgeColor || '#FF6B35',
        };
      });

    return success(res, featured);
  } catch (e: any) {
    return error(res, e.message, 500);
  }
});

export default router;
