import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';

import { env } from './config/env';
import { connectDatabase } from './config/database';
import { initFirebase } from './config/firebase';
import { setupLeaderboardSocket } from './socket/leaderboard';
import { startCoinWorker, schedulePostbackRetry } from './queues/coinQueue';
import { startNotifWorker } from './queues/notifQueue';
import { scheduleQuizGeneration, scheduleResultVerification, scheduleDailyBonusReminders, scheduleQuestionNotifications } from './jobs/iplQuizJob';
import { startSuperOfferNotificationJob } from './jobs/superOfferNotification.job';
import { logger } from './utils/logger';
import { error } from './utils/response';

// Routes
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import contestRoutes from './routes/contests';
import gameRoutes from './routes/games';
import earnRoutes from './routes/earn';
import redeemRoutes from './routes/redeem';
import postbackRoutes from './routes/postback';
import iplRoutes from './routes/ipl';
import adminRoutes from './routes/admin';
import appRoutes from './routes/app';
import superOfferRoutes from './routes/superOffer.routes';
import adminSuperOfferRoutes from './routes/admin.superOffer.routes';

const app = express();
const httpServer = createServer(app);

// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new SocketServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});
setupLeaderboardSocket(io);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: '*', credentials: true }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('public/uploads'));

// Trust proxy for rate limiting behind load balancer
app.set('trust proxy', 1);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString(), env: env.NODE_ENV });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/contests', contestRoutes);
app.use('/api/games', gameRoutes);
app.use('/api/earn', earnRoutes);
app.use('/api/redeem', redeemRoutes);
app.use('/api/postback', postbackRoutes);
app.use('/api/ipl', iplRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/app', appRoutes);
app.use('/api/superoffers', superOfferRoutes);
app.use('/api/admin', adminSuperOfferRoutes);

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  error(res, 'Route not found', 404);
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', { message: err.message, stack: err.stack });
  error(res, env.NODE_ENV === 'production' ? 'Internal server error' : err.message, 500);
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  // Ensure logs directory exists
  const fs = await import('fs');
  if (!fs.existsSync('logs')) fs.mkdirSync('logs');

  await connectDatabase();
  initFirebase();

  // Start background workers (non-fatal if Redis unavailable)
  try {
    startCoinWorker();
    startNotifWorker();
    logger.info('BullMQ workers started');
  } catch (err) {
    logger.warn('BullMQ workers failed to start (Redis may be unavailable)', { err });
  }

  httpServer.listen(env.PORT, () => {
    logger.info(`OfferPlay backend running on port ${env.PORT} [${env.NODE_ENV}]`);
  });

  scheduleQuizGeneration();
  scheduleResultVerification();
  scheduleDailyBonusReminders();
  scheduleQuestionNotifications();
  logger.info('IPL quiz jobs scheduled');
  schedulePostbackRetry();
  startSuperOfferNotificationJob();
}

bootstrap().catch((err) => {
  logger.error('Bootstrap failed', { err });
  process.exit(1);
});

export { io };
