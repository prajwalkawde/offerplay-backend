"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listGames = listGames;
exports.getGame = getGame;
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const query_1 = require("../utils/query");
async function listGames(req, res) {
    const category = (0, query_1.qs)(req.query.category);
    const games = await database_1.prisma.game.findMany({
        where: { isActive: true, ...(category && { category }) },
        select: { id: true, name: true, description: true, icon: true, category: true, gameUrl: true },
        orderBy: { createdAt: 'desc' },
    });
    (0, response_1.success)(res, games);
}
async function getGame(req, res) {
    const game = await database_1.prisma.game.findUnique({
        where: { id: req.params.id },
        select: {
            id: true, name: true, description: true, icon: true,
            category: true, gameUrl: true, gameHtml: true,
        },
    });
    if (!game) {
        (0, response_1.error)(res, 'Game not found', 404);
        return;
    }
    (0, response_1.success)(res, game);
}
