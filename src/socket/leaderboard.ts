import { Server, Socket } from 'socket.io';
import { getLeaderboard } from '../services/contestService';
import { logger } from '../utils/logger';

export function setupLeaderboardSocket(io: Server): void {
  const leaderboardNs = io.of('/leaderboard');

  leaderboardNs.on('connection', (socket: Socket) => {
    logger.debug('Socket connected', { id: socket.id });

    socket.on('join:contest', async (contestId: string) => {
      await socket.join(`contest:${contestId}`);
      const lb = await getLeaderboard(contestId);
      socket.emit('leaderboard:update', { contestId, leaderboard: lb });
    });

    socket.on('leave:contest', (contestId: string) => {
      socket.leave(`contest:${contestId}`);
    });

    socket.on('disconnect', () => {
      logger.debug('Socket disconnected', { id: socket.id });
    });
  });
}

export async function broadcastLeaderboard(io: Server, contestId: string): Promise<void> {
  const lb = await getLeaderboard(contestId);
  io.of('/leaderboard').to(`contest:${contestId}`).emit('leaderboard:update', {
    contestId,
    leaderboard: lb,
  });
}
