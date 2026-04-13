import 'dotenv/config';
import path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';

import { env } from './config/env';
import { connectDatabase, prisma } from './config/database';
import { initFirebase } from './config/firebase';
import { setupLeaderboardSocket } from './socket/leaderboard';
import { startCoinWorker, schedulePostbackRetry } from './queues/coinQueue';
import { startNotifWorker } from './queues/notifQueue';
import { scheduleQuizGeneration, scheduleResultVerification, scheduleDailyBonusReminders, scheduleQuestionNotifications } from './jobs/iplQuizJob';
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
import homeRoutes from './routes/home';
import referralRoutes from './routes/referral';
import questRoutes from './routes/quests';
import customOfferRoutes from './routes/customOffers';
import offerwallRoutes from './routes/offerwall';
import { handleAdjoePostback } from './controllers/adjoeController';
import { handleReferralRedirect } from './controllers/deepLinkController';
import superOfferRoutes from './routes/superOffer.routes';
import adminSuperOfferRoutes from './routes/admin.superOffer.routes';
import { startSuperOfferNotificationJob } from './jobs/superOfferNotification.job';
import quizRoutes from './routes/quiz.routes';
import adminQuizRoutes from './routes/admin.quiz.routes';
import { startQuizAIJob } from './jobs/quizAI.job';
import adminSecurityRoutes from './routes/admin.security.routes';

const app = express();
const httpServer = createServer(app);

// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new SocketServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});
setupLeaderboardSocket(io);

// ─── Middleware ───────────────────────────────────────────────────────────────
const allowedOrigins = [
  'https://admin.offerplay.in',
  'https://phpstack-1554518-6313385.cloudwaysapps.com',
  'https://offerplay.in',
  'http://localhost:5173',
  'http://localhost:3000',
  process.env.ALLOWED_ORIGINS,
].filter(Boolean) as string[];

// Trust proxy — must be set before any middleware that reads req.ip or req.protocol
app.set('trust proxy', 1);

// ─── HTTPS redirect (Cloudways nginx sets X-Forwarded-Proto on external requests) ──
app.use((req: Request, res: Response, next: NextFunction) => {
  const proto = req.headers['x-forwarded-proto'] as string | undefined;
  // Only redirect when header is explicitly 'http' — avoids loop on internal nginx proxy traffic
  if (proto === 'http') {
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
  next();
});

// ─── Request Logger ───────────────────────────────────────────────────────────
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info(`[REQ] ${req.method} ${req.path} | ip=${req.ip}`);
  next();
});

app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// ─── Landing page (offerplay.in) ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

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
app.use('/api/home', homeRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/quests', questRoutes);
app.use('/api/custom-offers', customOfferRoutes);
app.use('/api/offerwall', offerwallRoutes);
app.get('/api/adjoe/postback', handleAdjoePostback);
app.get('/r/:code', handleReferralRedirect);
app.use('/api/superoffers', superOfferRoutes);
app.use('/api/admin', adminSuperOfferRoutes);
app.use('/api/quiz', quizRoutes);
app.use('/api/admin/quiz', adminQuizRoutes);
app.use('/api/admin/security', adminSecurityRoutes);

// ─── Public policy pages (offerplay.in/privacy, /terms, /payment-policy) ──────

function renderPolicyHtml(type: string, title: string, icon: string, content: string, updatedAt?: Date): string {
  const mdToHtml = (md: string) =>
    md
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .split('\n')
      .map(line => {
        if (line.startsWith('# '))  return `<h1>${line.slice(2)}</h1>`;
        if (line.startsWith('## ')) return `<h2>${line.slice(3)}</h2>`;
        if (line.startsWith('- '))  return `<li>${line.slice(2)}</li>`;
        if (line.trim() === '')     return '<br>';
        return `<p>${line}</p>`;
      })
      .join('\n');

  const updated = updatedAt ? new Date(updatedAt).toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' }) : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — OfferPlay</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d0818; color: #e0e0e0; min-height: 100vh; }
    header { background: linear-gradient(135deg, #1a0a2e, #2d0a5e); padding: 24px 20px; text-align: center; border-bottom: 1px solid #7B2FBE30; }
    .brand { color: #7B2FBE; font-size: 13px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 12px; }
    .page-icon { font-size: 40px; display: block; margin-bottom: 8px; }
    h1.page-title { color: #fff; font-size: 24px; font-weight: 800; }
    .updated { color: #ffffff50; font-size: 12px; margin-top: 8px; }
    main { max-width: 780px; margin: 0 auto; padding: 32px 20px 60px; }
    .card { background: #1a0a2e; border-radius: 20px; padding: 28px; border: 1px solid #ffffff10; }
    h1 { color: #fff; font-size: 22px; font-weight: 800; margin: 24px 0 14px; }
    h2 { color: #FFD700; font-size: 16px; font-weight: 700; margin: 22px 0 10px; padding-left: 10px; border-left: 3px solid #FFD700; }
    p { color: #ffffffcc; font-size: 14px; line-height: 1.7; margin-bottom: 8px; }
    li { color: #ffffffcc; font-size: 14px; line-height: 1.7; margin: 4px 0 4px 20px; list-style: disc; }
    br { display: block; height: 6px; }
    footer { text-align: center; padding: 20px; color: #ffffff30; font-size: 12px; border-top: 1px solid #ffffff10; }
    a { color: #7B2FBE; text-decoration: none; }
    @media (max-width: 600px) { main { padding: 20px 14px 48px; } .card { padding: 20px; } }
  </style>
</head>
<body>
  <header>
    <div class="brand">OfferPlay</div>
    <span class="page-icon">${icon}</span>
    <h1 class="page-title">${title}</h1>
    ${updated ? `<div class="updated">Last updated: ${updated}</div>` : ''}
  </header>
  <main>
    <div class="card">
      ${mdToHtml(content)}
    </div>
  </main>
  <footer>
    &copy; ${new Date().getFullYear()} OfferPlay &nbsp;·&nbsp;
    <a href="/privacy">Privacy Policy</a> &nbsp;·&nbsp;
    <a href="/terms">Terms &amp; Conditions</a> &nbsp;·&nbsp;
    <a href="/payment-policy">Payment Policy</a>
  </footer>
</body>
</html>`;
}

async function servePolicyPage(req: Request, res: Response, type: string, title: string, icon: string) {
  try {
    const key = `POLICY_${type}`;
    const setting = await prisma.appSettings.findUnique({ where: { key } });
    const content = setting?.value || `# ${title}\n\nContent coming soon.`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderPolicyHtml(type, title, icon, content, setting?.updatedAt));
  } catch {
    res.status(500).send('<h1>Error loading page</h1>');
  }
}

app.get('/privacy',        (req, res) => servePolicyPage(req, res, 'PRIVACY', 'Privacy Policy',    '🔒'));
app.get('/terms',          (req, res) => servePolicyPage(req, res, 'TERMS',   'Terms & Conditions','📋'));
app.get('/payment-policy', (req, res) => servePolicyPage(req, res, 'PAYMENT', 'Payment Policy',    '💳'));

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

  // Start IPL workers
  try {
    const { startIPLWorkers } = await import('./queues/iplQueues');
    startIPLWorkers();
    logger.info('IPL BullMQ workers started');
  } catch (err) {
    logger.warn('IPL workers failed to start', { err });
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
  startQuizAIJob();
  logger.info('Sports Quiz AI job scheduled');
}

bootstrap().catch((err) => {
  logger.error('Bootstrap failed', { err });
  process.exit(1);
});

export { io };
