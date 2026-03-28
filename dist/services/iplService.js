"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitPrediction = submitPrediction;
exports.scoreMatch = scoreMatch;
exports.getLeaderboard = getLeaderboard;
const database_1 = require("../config/database");
const coinService_1 = require("./coinService");
const client_1 = require("@prisma/client");
const logger_1 = require("../utils/logger");
async function submitPrediction(userId, matchId, questionId, answer) {
    const match = await database_1.prisma.iplMatch.findUnique({ where: { id: matchId } });
    if (!match)
        throw new Error('Match not found');
    if (match.status !== 'upcoming' && match.status !== 'live')
        throw new Error('Predictions closed');
    const question = await database_1.prisma.iplQuestion.findUnique({ where: { id: questionId } });
    if (!question || question.matchId !== matchId)
        throw new Error('Invalid question');
    if (question.status !== 'active')
        throw new Error('Question not accepting answers');
    const options = question.options;
    if (!options.includes(answer))
        throw new Error('Invalid answer option');
    await database_1.prisma.iplPrediction.upsert({
        where: { userId_questionId: { userId, questionId } },
        create: { userId, matchId, questionId, answer },
        update: { answer },
    });
}
async function scoreMatch(matchId, results) {
    const questions = await database_1.prisma.iplQuestion.findMany({ where: { matchId } });
    for (const question of questions) {
        const correctAnswer = results[question.id];
        if (!correctAnswer)
            continue;
        await database_1.prisma.iplQuestion.update({
            where: { id: question.id },
            data: { correctAnswer, status: 'closed' },
        });
        const predictions = await database_1.prisma.iplPrediction.findMany({
            where: { questionId: question.id },
        });
        for (const pred of predictions) {
            const isCorrect = pred.answer === correctAnswer;
            const pointsEarned = isCorrect ? question.points : 0;
            await database_1.prisma.iplPrediction.update({
                where: { id: pred.id },
                data: { isCorrect, pointsEarned },
            });
            if (isCorrect && pointsEarned > 0) {
                await (0, coinService_1.creditCoins)(pred.userId, pointsEarned, client_1.TransactionType.EARN_IPL_WIN, matchId, `IPL prediction correct — ${question.question}`);
            }
        }
    }
    await database_1.prisma.iplMatch.update({ where: { id: matchId }, data: { status: 'completed' } });
    logger_1.logger.info('IPL match scored', { matchId });
}
async function getLeaderboard(limit = 50) {
    const result = await database_1.prisma.iplPrediction.groupBy({
        by: ['userId'],
        _sum: { pointsEarned: true },
        orderBy: { _sum: { pointsEarned: 'desc' } },
        take: limit,
    });
    const userIds = result.map((r) => r.userId);
    const users = await database_1.prisma.user.findMany({
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
