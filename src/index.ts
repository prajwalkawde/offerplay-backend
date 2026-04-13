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

// ─── Delete Account web page (Play Store / App Store requirement) ─────────────
app.get('/delete-account', (_req: Request, res: Response) => {
  const API = 'https://api.offerplay.in';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Delete Account — OfferPlay</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0818;color:#e0e0e0;min-height:100vh;display:flex;flex-direction:column}
    header{background:linear-gradient(135deg,#1a0a2e,#2d0a5e);padding:20px;text-align:center;border-bottom:1px solid #7B2FBE30}
    .brand{color:#7B2FBE;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px}
    h1{color:#FF6666;font-size:22px;font-weight:800}
    .sub{color:#ffffff60;font-size:13px;margin-top:6px}
    main{flex:1;display:flex;align-items:center;justify-content:center;padding:32px 16px}
    .card{background:#1a0a2e;border-radius:24px;padding:28px;width:100%;max-width:420px;border:1px solid #FF444420}
    .step{display:none}.step.active{display:block}
    .icon{font-size:48px;text-align:center;margin-bottom:16px}
    h2{color:white;font-size:18px;font-weight:700;text-align:center;margin-bottom:8px}
    p{color:#ffffff70;font-size:14px;text-align:center;line-height:1.6;margin-bottom:20px}
    label{color:#ffffff80;font-size:13px;display:block;margin-bottom:6px}
    input{width:100%;background:#0d0818;border:1px solid #ffffff15;border-radius:12px;padding:14px 16px;color:white;font-size:15px;outline:none;transition:border .2s}
    input:focus{border-color:#7B2FBE50}
    .otp-row{display:flex;gap:8px;justify-content:center;margin:16px 0}
    .otp-box{width:44px;height:52px;background:#0d0818;border:1px solid #ffffff15;border-radius:10px;color:white;font-size:20px;font-weight:bold;text-align:center;outline:none;transition:border .2s}
    .otp-box:focus{border-color:#7B2FBE}
    .btn{width:100%;border:none;border-radius:14px;padding:16px;font-size:16px;font-weight:700;cursor:pointer;transition:opacity .2s;margin-top:12px}
    .btn-primary{background:linear-gradient(135deg,#7B2FBE,#9B4FDE);color:white}
    .btn-danger{background:linear-gradient(135deg,#FF4444,#CC2222);color:white}
    .btn-ghost{background:#ffffff10;color:#ffffff60;font-size:14px;margin-top:8px}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .err{color:#FF6666;font-size:13px;text-align:center;margin-top:10px;min-height:20px}
    .warn-box{background:#FF444415;border:1px solid #FF444430;border-radius:12px;padding:14px;margin-bottom:18px}
    .warn-box li{color:#FF9999;font-size:13px;line-height:1.8;margin-left:16px}
    .check-row{display:flex;gap:10px;align-items:flex-start;background:#ffffff08;border:1px solid #ffffff10;border-radius:12px;padding:14px;margin-bottom:16px;cursor:pointer}
    .check-box{width:20px;height:20px;border-radius:5px;border:2px solid #ffffff30;flex-shrink:0;margin-top:1px;display:flex;align-items:center;justify-content:center;transition:all .2s}
    .check-box.checked{background:#FF4444;border-color:#FF4444}
    .check-label{color:#ffffff80;font-size:13px;line-height:1.5}
    .success-icon{font-size:72px;text-align:center;margin:8px 0 16px}
    .resend{color:#7B2FBE;font-size:13px;text-align:center;margin-top:14px;cursor:pointer;background:none;border:none;width:100%}
    .resend:disabled{color:#ffffff30;cursor:not-allowed}
    .spinner{display:inline-block;width:18px;height:18px;border:2px solid #ffffff30;border-top:2px solid white;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px}
    @keyframes spin{to{transform:rotate(360deg)}}
    footer{text-align:center;padding:16px;color:#ffffff20;font-size:12px}
    a{color:#7B2FBE}
  </style>
</head>
<body>
<header>
  <div class="brand">OfferPlay</div>
  <h1>🗑️ Delete Account</h1>
  <div class="sub">Permanently delete your OfferPlay account and all data</div>
</header>

<main>
  <div class="card">

    <!-- Step 1: Enter phone -->
    <div class="step active" id="step1">
      <div class="icon">📱</div>
      <h2>Enter Your Phone Number</h2>
      <p>We'll send an OTP to verify it's really you before deleting your account.</p>
      <label>Phone Number (with country code)</label>
      <input id="phoneInput" type="tel" placeholder="+91 9876543210" autocomplete="tel"/>
      <div class="err" id="err1"></div>
      <button class="btn btn-primary" id="sendOtpBtn" onclick="sendOtp()">Send OTP</button>
    </div>

    <!-- Step 2: Verify OTP -->
    <div class="step" id="step2">
      <div class="icon">🔐</div>
      <h2>Enter OTP</h2>
      <p id="otpSentTo">Enter the 6-digit OTP sent to your number.</p>
      <div class="otp-row" id="otpRow">
        <input class="otp-box" maxlength="1" inputmode="numeric" pattern="[0-9]"/>
        <input class="otp-box" maxlength="1" inputmode="numeric" pattern="[0-9]"/>
        <input class="otp-box" maxlength="1" inputmode="numeric" pattern="[0-9]"/>
        <input class="otp-box" maxlength="1" inputmode="numeric" pattern="[0-9]"/>
        <input class="otp-box" maxlength="1" inputmode="numeric" pattern="[0-9]"/>
        <input class="otp-box" maxlength="1" inputmode="numeric" pattern="[0-9]"/>
      </div>
      <div class="err" id="err2"></div>
      <button class="btn btn-primary" id="verifyOtpBtn" onclick="verifyOtp()">Verify OTP</button>
      <button class="resend" id="resendBtn" disabled onclick="resendOtp()">Resend OTP in <span id="resendTimer">30</span>s</button>
    </div>

    <!-- Step 3: Confirm deletion -->
    <div class="step" id="step3">
      <div class="icon">⚠️</div>
      <h2>Confirm Account Deletion</h2>
      <div class="warn-box">
        <ul>
          <li>Your coin balance will be permanently lost</li>
          <li>All contest entries and winnings will be removed</li>
          <li>Pending redemptions will be cancelled</li>
          <li>This action cannot be undone</li>
        </ul>
      </div>
      <div class="check-row" id="confirmRow" onclick="toggleConfirm()">
        <div class="check-box" id="confirmBox"></div>
        <span class="check-label">I understand that deleting my account is permanent and cannot be reversed.</span>
      </div>
      <div class="err" id="err3"></div>
      <button class="btn btn-danger" id="deleteBtn" onclick="deleteAccount()" disabled>Delete My Account Permanently</button>
      <button class="btn btn-ghost" onclick="goBack()">Cancel — Keep My Account</button>
    </div>

    <!-- Step 4: Success -->
    <div class="step" id="step4">
      <div class="success-icon">✅</div>
      <h2>Account Deleted</h2>
      <p>Your OfferPlay account has been permanently deleted. All your data has been removed from our servers.</p>
      <p style="margin-top:12px;color:#ffffff40;font-size:12px">If you have any questions, contact us at support@offerplay.in</p>
    </div>

  </div>
</main>

<footer>&copy; ${new Date().getFullYear()} OfferPlay &nbsp;·&nbsp; <a href="/privacy">Privacy Policy</a> &nbsp;·&nbsp; <a href="/terms">Terms</a></footer>

<script>
  const API = '${API}';
  let phone = '';
  let confirmed = false;
  let resendInterval = null;

  function showStep(n) {
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    document.getElementById('step' + n).classList.add('active');
  }

  function setLoading(btnId, loading, defaultText) {
    const btn = document.getElementById(btnId);
    btn.disabled = loading;
    btn.innerHTML = loading ? '<span class="spinner"></span>Please wait...' : defaultText;
  }

  async function sendOtp() {
    const input = document.getElementById('phoneInput').value.trim();
    const errEl = document.getElementById('err1');
    errEl.textContent = '';
    if (!input || input.replace(/\\D/g,'').length < 10) {
      errEl.textContent = 'Please enter a valid phone number with country code (e.g. +91 9876543210)';
      return;
    }
    phone = input;
    setLoading('sendOtpBtn', true, 'Send OTP');
    try {
      const res = await fetch(API + '/api/auth/delete-account/request', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ phone })
      });
      const data = await res.json();
      if (!res.ok || data.error === 'true' || data.error === true) {
        errEl.textContent = data.message || 'Failed to send OTP. Please try again.';
        return;
      }
      document.getElementById('otpSentTo').textContent = 'Enter the 6-digit OTP sent to ' + phone;
      showStep(2);
      startResendTimer();
      document.querySelectorAll('.otp-box')[0].focus();
    } catch {
      errEl.textContent = 'Network error. Please check your connection.';
    } finally {
      setLoading('sendOtpBtn', false, 'Send OTP');
    }
  }

  function getOtp() {
    return Array.from(document.querySelectorAll('.otp-box')).map(i => i.value).join('');
  }

  async function verifyOtp() {
    const otp = getOtp();
    const errEl = document.getElementById('err2');
    errEl.textContent = '';
    if (otp.length !== 6) { errEl.textContent = 'Please enter all 6 digits.'; return; }
    setLoading('verifyOtpBtn', true, 'Verify OTP');
    const errEl2 = document.getElementById('err2');
    try {
      // Validate format only — actual deletion + OTP check happens in step 3
      if (otp.length === 6 && /^[0-9]{6}$/.test(otp)) {
        clearInterval(resendInterval);
        showStep(3);
      } else {
        errEl2.textContent = 'Please enter a valid 6-digit OTP.';
      }
    } finally {
      setLoading('verifyOtpBtn', false, 'Verify OTP');
    }
  }

  function toggleConfirm() {
    confirmed = !confirmed;
    document.getElementById('confirmBox').classList.toggle('checked', confirmed);
    document.getElementById('confirmBox').innerHTML = confirmed ? '✓' : '';
    document.getElementById('deleteBtn').disabled = !confirmed;
  }

  async function deleteAccount() {
    if (!confirmed) return;
    const otp = getOtp();
    const errEl = document.getElementById('err3');
    errEl.textContent = '';
    setLoading('deleteBtn', true, 'Delete My Account Permanently');
    try {
      const res = await fetch(API + '/api/auth/delete-account/confirm', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ phone, otp })
      });
      const data = await res.json();
      if (!res.ok || data.error === 'true' || data.error === true) {
        errEl.textContent = data.message || 'Failed to delete account. Please try again.';
        return;
      }
      showStep(4);
    } catch {
      errEl.textContent = 'Network error. Please check your connection.';
    } finally {
      setLoading('deleteBtn', false, 'Delete My Account Permanently');
    }
  }

  function goBack() { showStep(1); }

  async function resendOtp() {
    document.getElementById('err2').textContent = '';
    const btn = document.getElementById('resendBtn');
    btn.disabled = true;
    try {
      await fetch(API + '/api/auth/delete-account/request', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ phone })
      });
      startResendTimer();
    } catch { btn.disabled = false; }
  }

  function startResendTimer() {
    let t = 30;
    clearInterval(resendInterval);
    const btn = document.getElementById('resendBtn');
    const timer = document.getElementById('resendTimer');
    btn.disabled = true;
    resendInterval = setInterval(() => {
      t--;
      timer.textContent = t;
      if (t <= 0) {
        clearInterval(resendInterval);
        btn.innerHTML = 'Resend OTP';
        btn.disabled = false;
      }
    }, 1000);
  }

  // OTP box auto-advance
  document.querySelectorAll('.otp-box').forEach((box, i, boxes) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/[^0-9]/g,'');
      if (box.value && i < boxes.length - 1) boxes[i+1].focus();
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i-1].focus();
    });
    box.addEventListener('paste', e => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g,'');
      boxes.forEach((b, j) => { b.value = text[j] || ''; });
      const last = Math.min(text.length, boxes.length) - 1;
      if (last >= 0) boxes[last].focus();
    });
  });

  document.getElementById('phoneInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendOtp();
  });
</script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

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
