"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupLeaderboardSocket = setupLeaderboardSocket;
exports.broadcastLeaderboard = broadcastLeaderboard;
const contestService_1 = require("../services/contestService");
const logger_1 = require("../utils/logger");
function setupLeaderboardSocket(io) {
    const leaderboardNs = io.of('/leaderboard');
    leaderboardNs.on('connection', (socket) => {
        logger_1.logger.debug('Socket connected', { id: socket.id });
        socket.on('join:contest', async (contestId) => {
            await socket.join(`contest:${contestId}`);
            const lb = await (0, contestService_1.getLeaderboard)(contestId);
            socket.emit('leaderboard:update', { contestId, leaderboard: lb });
        });
        socket.on('leave:contest', (contestId) => {
            socket.leave(`contest:${contestId}`);
        });
        socket.on('disconnect', () => {
            logger_1.logger.debug('Socket disconnected', { id: socket.id });
        });
    });
}
async function broadcastLeaderboard(io, contestId) {
    const lb = await (0, contestService_1.getLeaderboard)(contestId);
    io.of('/leaderboard').to(`contest:${contestId}`).emit('leaderboard:update', {
        contestId,
        leaderboard: lb,
    });
}
