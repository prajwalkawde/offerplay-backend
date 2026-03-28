"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const router = (0, express_1.Router)();
// GET /api/offerwall/featured
// Returns active custom/partner offers enriched for display, excluding maxed-out ones
router.get('/featured', auth_1.authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = Math.min(parseInt(req.query.limit) || 10, 20);
        const customOffers = await database_1.prisma.customOffer.findMany({
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
            const c = o.completions.find((cp) => cp.userId === userId);
            return !c || c.status !== 'completed';
        })
            .map(o => {
            const totalTickets = o.stages.reduce((sum, stage) => sum + stage.tasks.reduce((s, t) => s + (t.rewardTickets || 0), 0), 0);
            const totalCoins = o.stages.reduce((sum, stage) => sum + stage.tasks.reduce((s, t) => s + (t.rewardCoins || 0), 0), 0);
            return {
                id: o.id,
                offerId: o.id,
                name: o.title,
                title: o.title,
                description: o.description,
                icon_url: o.logoUrl,
                coins: totalCoins > 0 ? totalCoins : null,
                payout_coins: totalCoins > 0 ? totalCoins : null,
                rewardTickets: totalTickets > 0 ? totalTickets : null,
                rewardCoins: totalCoins > 0 ? totalCoins : null,
                difficulty: 'Easy',
                time_estimate: `${o.stages.length} stage${o.stages.length !== 1 ? 's' : ''}`,
                category: 'PARTNER',
                isCustomOffer: true,
                partnerName: o.partnerName,
                badgeText: o.badgeText || '🔥 PARTNER',
                badgeColor: o.badgeColor || '#FF6B35',
            };
        });
        return (0, response_1.success)(res, featured);
    }
    catch (e) {
        return (0, response_1.error)(res, e.message, 500);
    }
});
exports.default = router;
