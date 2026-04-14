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
  // Override helmet's strict CSP — this page needs inline JS + Firebase CDN + Google popup
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://www.google.com https://www.recaptcha.net; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self' https://api.offerplay.in https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com; " +
    "frame-src https://offerpay-87906.firebaseapp.com https://accounts.google.com https://www.google.com https://recaptcha.google.com https://www.recaptcha.net;"
  );
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
    .card{background:#1a0a2e;border-radius:24px;padding:28px;width:100%;max-width:440px;border:1px solid #FF444420}
    .tabs{display:flex;gap:0;margin-bottom:24px;border-radius:12px;overflow:hidden;border:1px solid #ffffff15}
    .tab{flex:1;padding:12px;text-align:center;cursor:pointer;font-size:14px;font-weight:600;background:#0d0818;color:#ffffff60;border:none;transition:all .2s}
    .tab.active{background:#7B2FBE;color:white}
    .panel{display:none}.panel.active{display:block}
    .step{display:none}.step.active{display:block}
    .icon{font-size:48px;text-align:center;margin-bottom:16px}
    h2{color:white;font-size:18px;font-weight:700;text-align:center;margin-bottom:8px}
    p{color:#ffffff70;font-size:14px;text-align:center;line-height:1.6;margin-bottom:20px}
    label{color:#ffffff80;font-size:13px;display:block;margin-bottom:6px}
    input[type=tel]{width:100%;background:#0d0818;border:1px solid #ffffff15;border-radius:12px;padding:14px 16px;color:white;font-size:15px;outline:none;transition:border .2s}
    input[type=tel]:focus{border-color:#7B2FBE50}
    .otp-row{display:flex;gap:8px;justify-content:center;margin:16px 0}
    .otp-box{width:44px;height:52px;background:#0d0818;border:1px solid #ffffff15;border-radius:10px;color:white;font-size:20px;font-weight:bold;text-align:center;outline:none;transition:border .2s}
    .otp-box:focus{border-color:#7B2FBE}
    .btn{width:100%;border:none;border-radius:14px;padding:16px;font-size:16px;font-weight:700;cursor:pointer;transition:opacity .2s;margin-top:12px}
    .btn-primary{background:linear-gradient(135deg,#7B2FBE,#9B4FDE);color:white}
    .btn-google{background:white;color:#333;display:flex;align-items:center;justify-content:center;gap:10px;font-size:15px}
    .btn-danger{background:linear-gradient(135deg,#FF4444,#CC2222);color:white}
    .btn-ghost{background:#ffffff10;color:#ffffff60;font-size:14px;margin-top:8px}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .err{color:#FF6666;font-size:13px;text-align:center;margin-top:10px;min-height:20px}
    .warn-box{background:#FF444415;border:1px solid #FF444430;border-radius:12px;padding:14px;margin-bottom:18px}
    .warn-box li{color:#FF9999;font-size:13px;line-height:1.8;margin-left:16px}
    .check-row{display:flex;gap:10px;align-items:flex-start;background:#ffffff08;border:1px solid #ffffff10;border-radius:12px;padding:14px;margin-bottom:16px;cursor:pointer}
    .check-box{width:20px;height:20px;border-radius:5px;border:2px solid #ffffff30;flex-shrink:0;margin-top:1px;display:flex;align-items:center;justify-content:center;font-size:13px;transition:all .2s}
    .check-box.checked{background:#FF4444;border-color:#FF4444;color:white}
    .check-label{color:#ffffff80;font-size:13px;line-height:1.5}
    .success-icon{font-size:72px;text-align:center;margin:8px 0 16px}
    .resend{color:#7B2FBE;font-size:13px;text-align:center;margin-top:14px;cursor:pointer;background:none;border:none;width:100%}
    .resend:disabled{color:#ffffff30;cursor:not-allowed}
    .spinner{display:inline-block;width:18px;height:18px;border:2px solid #ffffff30;border-top:2px solid white;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .google-icon{width:20px;height:20px}
    #recaptcha-container{margin:8px 0}
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

    <!-- Shared success step (shown after deletion regardless of method) -->
    <div class="step" id="stepSuccess">
      <div class="success-icon">✅</div>
      <h2>Account Deleted</h2>
      <p>Your OfferPlay account has been permanently deleted. All your data has been removed from our servers.</p>
      <p style="margin-top:12px;color:#ffffff40;font-size:12px">If you have any questions, contact us at support@offerplay.in</p>
    </div>

    <!-- Shared confirm step -->
    <div class="step" id="stepConfirm">
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
      <div class="check-row" onclick="toggleConfirm()">
        <div class="check-box" id="confirmBox"></div>
        <span class="check-label">I understand that deleting my account is permanent and cannot be reversed.</span>
      </div>
      <div class="err" id="errConfirm"></div>
      <button class="btn btn-danger" id="deleteBtn" onclick="deleteAccount()" disabled>Delete My Account Permanently</button>
      <button class="btn btn-ghost" onclick="cancelDelete()">Cancel — Keep My Account</button>
    </div>

    <!-- Main flow (tabs + steps) -->
    <div id="mainFlow">
      <!-- Tab switcher -->
      <div class="tabs">
        <button class="tab active" id="tabPhone" onclick="switchTab('phone')">📱 Phone Number</button>
        <button class="tab" id="tabGoogle" onclick="switchTab('google')">🔵 Google Account</button>
      </div>

      <!-- ── PHONE PANEL ── -->
      <div class="panel active" id="panelPhone">

        <!-- Phone Step 1: Enter number -->
        <div class="step active" id="phoneStep1">
          <div class="icon">📱</div>
          <h2>Enter Your Phone Number</h2>
          <p>We'll send an OTP via Firebase to verify it's really you.</p>
          <label>Phone Number (with country code)</label>
          <input id="phoneInput" type="tel" placeholder="+91 9876543210" autocomplete="tel"/>
          <div id="recaptcha-container" style="margin:14px 0"></div>
          <div class="err" id="errPhone1"></div>
          <button class="btn btn-primary" id="sendOtpBtn" onclick="sendPhoneOtp()" disabled>Send OTP</button>
        </div>

        <!-- Phone Step 2: Enter OTP -->
        <div class="step" id="phoneStep2">
          <div class="icon">🔐</div>
          <h2>Enter OTP</h2>
          <p id="otpSentTo">Enter the 6-digit OTP sent to your number.</p>
          <div class="otp-row">
            <input class="otp-box" maxlength="1" inputmode="numeric"/>
            <input class="otp-box" maxlength="1" inputmode="numeric"/>
            <input class="otp-box" maxlength="1" inputmode="numeric"/>
            <input class="otp-box" maxlength="1" inputmode="numeric"/>
            <input class="otp-box" maxlength="1" inputmode="numeric"/>
            <input class="otp-box" maxlength="1" inputmode="numeric"/>
          </div>
          <div class="err" id="errPhone2"></div>
          <button class="btn btn-primary" id="verifyOtpBtn" onclick="verifyPhoneOtp()">Verify &amp; Continue</button>
          <button class="resend" id="resendBtn" disabled onclick="resendOtp()">Resend OTP in <span id="resendTimer">60</span>s</button>
        </div>

      </div><!-- /panelPhone -->

      <!-- ── GOOGLE PANEL ── -->
      <div class="panel" id="panelGoogle">
        <div class="icon">🔵</div>
        <h2>Sign in with Google</h2>
        <p>Sign in with the Google account linked to your OfferPlay profile to verify your identity.</p>
        <div class="err" id="errGoogle"></div>
        <button class="btn btn-google" id="googleSignInBtn" onclick="signInWithGoogle()">
          <svg class="google-icon" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.7 2.5 30.2 0 24 0 14.8 0 6.9 5.4 2.9 13.3l7.8 6C12.4 13 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v8.7h12.4c-.5 2.8-2.1 5.2-4.5 6.8l7 5.4c4.1-3.8 6.5-9.4 6.5-16.3z"/><path fill="#FBBC05" d="M10.7 28.7A14.6 14.6 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.8-6A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l8.1-6z"/><path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7-5.4c-2 1.4-4.6 2.2-8.2 2.2-6.2 0-11.5-4.2-13.4-9.8l-8 6.1C6.8 42.5 14.8 48 24 48z"/><path fill="none" d="M0 0h48v48H0z"/></svg>
          Continue with Google
        </button>
      </div><!-- /panelGoogle -->

    </div><!-- /mainFlow -->

  </div>
</main>

<footer>&copy; ${new Date().getFullYear()} OfferPlay &nbsp;·&nbsp; <a href="/privacy">Privacy Policy</a> &nbsp;·&nbsp; <a href="/terms">Terms</a></footer>

<!-- Firebase JS SDK (compat) -->
<script src="https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/9.22.2/firebase-auth-compat.js"></script>
<script>
  // ── Firebase init ──────────────────────────────────────────────────────────
  firebase.initializeApp({
    apiKey:            'AIzaSyAQdjFdIEwxBcZXwLpIW4q7qKyZ0zKQdoY',
    authDomain:        'offerpay-87906.firebaseapp.com',
    databaseURL:       'https://offerpay-87906-default-rtdb.firebaseio.com',
    projectId:         'offerpay-87906',
    storageBucket:     'offerpay-87906.appspot.com',
    messagingSenderId: '449341693766',
    appId:             '1:449341693766:web:01930c72af552d1fb34f47',
    measurementId:     'G-YPCYXS94E9',
  });
  const auth = firebase.auth();
  auth.languageCode = 'en';

  // ── State ──────────────────────────────────────────────────────────────────
  const API = '${API}';
  let currentTab      = 'phone';
  let confirmed       = false;
  let pendingIdToken  = null;   // idToken waiting for confirm step
  let confirmResult   = null;   // Firebase phone confirmationResult
  let recaptchaVerifier = null;
  let resendInterval  = null;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function showStep(id) {
    // Hide all global steps + all panel steps
    document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
    // Hide/show the main flow wrapper
    const mainFlow = document.getElementById('mainFlow');
    if (id === 'stepSuccess' || id === 'stepConfirm') {
      mainFlow.style.display = 'none';
      el.style.display = 'block';
    } else {
      mainFlow.style.display = 'block';
    }
  }

  function setLoading(btnId, loading, defaultHtml) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = loading;
    btn.innerHTML = loading ? '<span class="spinner"></span>Please wait...' : defaultHtml;
  }

  function clearErrors() {
    document.querySelectorAll('.err').forEach(e => e.textContent = '');
  }

  // ── Tab switching ──────────────────────────────────────────────────────────
  function switchTab(tab) {
    currentTab = tab;
    document.getElementById('tabPhone').classList.toggle('active', tab === 'phone');
    document.getElementById('tabGoogle').classList.toggle('active', tab === 'google');
    document.getElementById('panelPhone').classList.toggle('active', tab === 'phone');
    document.getElementById('panelGoogle').classList.toggle('active', tab === 'google');
    clearErrors();
    // Reset phone steps back to step 1 when switching back
    if (tab === 'phone') {
      document.querySelectorAll('#panelPhone .step').forEach(s => s.classList.remove('active'));
      document.getElementById('phoneStep1').classList.add('active');
    }
  }

  // ── reCAPTCHA — render once on page load ──────────────────────────────────
  let recaptchaWidgetId = null;
  function setupRecaptcha() {
    recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', {
      size: 'normal',
      callback: () => {
        // reCAPTCHA solved — allow send
        document.getElementById('sendOtpBtn').disabled = false;
      },
      'expired-callback': () => {
        document.getElementById('sendOtpBtn').disabled = true;
      },
    });
    recaptchaVerifier.render().then(id => { recaptchaWidgetId = id; });
  }
  setupRecaptcha();

  // ── PHONE FLOW ─────────────────────────────────────────────────────────────
  async function sendPhoneOtp() {
    const raw = document.getElementById('phoneInput').value.trim();
    const errEl = document.getElementById('errPhone1');
    errEl.textContent = '';
    if (!raw || raw.replace(/\\D/g,'').length < 10) {
      errEl.textContent = 'Please enter a valid phone number with country code (e.g. +91 9876543210)';
      return;
    }
    const phone = raw.startsWith('+') ? raw : '+' + raw.replace(/\\D/g,'');
    setLoading('sendOtpBtn', true, 'Send OTP');
    try {
      confirmResult = await auth.signInWithPhoneNumber(phone, recaptchaVerifier);
      document.getElementById('otpSentTo').textContent = 'Enter the 6-digit OTP sent to ' + phone;
      document.querySelectorAll('#panelPhone .step').forEach(s => s.classList.remove('active'));
      document.getElementById('phoneStep2').classList.add('active');
      startResendTimer();
      document.querySelectorAll('.otp-box')[0].focus();
    } catch(e) {
      errEl.textContent = friendlyFirebaseError(e);
      // Reset reCAPTCHA so user can try again
      if (window.grecaptcha && recaptchaWidgetId !== null) {
        window.grecaptcha.reset(recaptchaWidgetId);
      }
    } finally {
      setLoading('sendOtpBtn', false, 'Send OTP');
    }
  }

  function getOtp() {
    return Array.from(document.querySelectorAll('.otp-box')).map(i => i.value).join('');
  }

  async function verifyPhoneOtp() {
    const otp = getOtp();
    const errEl = document.getElementById('errPhone2');
    errEl.textContent = '';
    if (otp.length !== 6) { errEl.textContent = 'Please enter all 6 digits.'; return; }
    if (!confirmResult) { errEl.textContent = 'Session expired. Please go back and request a new OTP.'; return; }
    setLoading('verifyOtpBtn', true, 'Verify &amp; Continue');
    try {
      const cred = await confirmResult.confirm(otp);
      pendingIdToken = await cred.user.getIdToken();
      clearInterval(resendInterval);
      showConfirmStep();
    } catch(e) {
      errEl.textContent = friendlyFirebaseError(e);
    } finally {
      setLoading('verifyOtpBtn', false, 'Verify &amp; Continue');
    }
  }

  async function resendOtp() {
    const raw = document.getElementById('phoneInput').value.trim();
    const phone = raw.startsWith('+') ? raw : '+' + raw.replace(/\\D/g,'');
    const btn = document.getElementById('resendBtn');
    btn.disabled = true;
    document.getElementById('errPhone2').textContent = '';
    try {
      confirmResult = await auth.signInWithPhoneNumber(phone, recaptchaVerifier);
      startResendTimer();
    } catch(e) {
      document.getElementById('errPhone2').textContent = friendlyFirebaseError(e);
      btn.disabled = false;
      if (window.grecaptcha && recaptchaWidgetId !== null) window.grecaptcha.reset(recaptchaWidgetId);
    }
  }

  function startResendTimer() {
    let t = 60;
    clearInterval(resendInterval);
    const btn = document.getElementById('resendBtn');
    const timer = document.getElementById('resendTimer');
    btn.disabled = true;
    btn.innerHTML = 'Resend OTP in <span id="resendTimer">' + t + '</span>s';
    resendInterval = setInterval(() => {
      t--;
      const timerEl = document.getElementById('resendTimer');
      if (timerEl) timerEl.textContent = t;
      if (t <= 0) {
        clearInterval(resendInterval);
        btn.innerHTML = 'Resend OTP';
        btn.disabled = false;
      }
    }, 1000);
  }

  // ── GOOGLE FLOW ────────────────────────────────────────────────────────────
  async function signInWithGoogle() {
    const errEl = document.getElementById('errGoogle');
    errEl.textContent = '';
    setLoading('googleSignInBtn', true, '<svg class="google-icon" viewBox="0 0 48 48">...</svg> Continue with Google');
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      const result = await auth.signInWithPopup(provider);
      pendingIdToken = await result.user.getIdToken();
      showConfirmStep();
    } catch(e) {
      errEl.textContent = friendlyFirebaseError(e);
    } finally {
      setLoading('googleSignInBtn', false,
        '<svg class="google-icon" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.7 2.5 30.2 0 24 0 14.8 0 6.9 5.4 2.9 13.3l7.8 6C12.4 13 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v8.7h12.4c-.5 2.8-2.1 5.2-4.5 6.8l7 5.4c4.1-3.8 6.5-9.4 6.5-16.3z"/><path fill="#FBBC05" d="M10.7 28.7A14.6 14.6 0 0 1 9.5 24c0-1.6.3-3.2.8-4.7l-7.8-6A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l8.1-6z"/><path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7-5.4c-2 1.4-4.6 2.2-8.2 2.2-6.2 0-11.5-4.2-13.4-9.8l-8 6.1C6.8 42.5 14.8 48 24 48z"/><path fill="none" d="M0 0h48v48H0z"/></svg> Continue with Google');
    }
  }

  // ── CONFIRM + DELETE ───────────────────────────────────────────────────────
  function showConfirmStep() {
    confirmed = false;
    document.getElementById('confirmBox').classList.remove('checked');
    document.getElementById('confirmBox').textContent = '';
    document.getElementById('deleteBtn').disabled = true;
    document.getElementById('errConfirm').textContent = '';
    showStep('stepConfirm');
  }

  function toggleConfirm() {
    confirmed = !confirmed;
    const box = document.getElementById('confirmBox');
    box.classList.toggle('checked', confirmed);
    box.textContent = confirmed ? '✓' : '';
    document.getElementById('deleteBtn').disabled = !confirmed;
  }

  async function deleteAccount() {
    if (!confirmed || !pendingIdToken) return;
    const errEl = document.getElementById('errConfirm');
    errEl.textContent = '';
    setLoading('deleteBtn', true, 'Delete My Account Permanently');
    try {
      const res = await fetch(API + '/api/auth/delete-account/firebase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: pendingIdToken }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        errEl.textContent = data.message || 'Failed to delete account. Please try again.';
        return;
      }
      pendingIdToken = null;
      showStep('stepSuccess');
    } catch {
      errEl.textContent = 'Network error. Please check your connection.';
    } finally {
      setLoading('deleteBtn', false, 'Delete My Account Permanently');
    }
  }

  function cancelDelete() {
    pendingIdToken = null;
    confirmed = false;
    // Restore main flow
    document.getElementById('mainFlow').style.display = 'block';
    document.getElementById('stepConfirm').style.display = 'none';
    // Reset to tab step 1
    switchTab(currentTab);
  }

  // ── Error messages ─────────────────────────────────────────────────────────
  function friendlyFirebaseError(e) {
    const code = e && e.code ? e.code : '';
    if (code === 'auth/invalid-phone-number')    return 'Invalid phone number. Include country code (e.g. +91 9876543210).';
    if (code === 'auth/too-many-requests')        return 'Too many attempts. Please try again later.';
    if (code === 'auth/invalid-verification-code') return 'Incorrect OTP. Please check and try again.';
    if (code === 'auth/code-expired')             return 'OTP expired. Please request a new one.';
    if (code === 'auth/popup-closed-by-user')     return 'Sign-in popup was closed. Please try again.';
    if (code === 'auth/popup-blocked')            return 'Popup was blocked by your browser. Please allow popups for this site.';
    if (code === 'auth/account-exists-with-different-credential') return 'This Google account is not linked to an OfferPlay account.';
    return e.message || 'Something went wrong. Please try again.';
  }

  // ── OTP box auto-advance ───────────────────────────────────────────────────
  document.querySelectorAll('.otp-box').forEach((box, i, boxes) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/[^0-9]/g, '');
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
    });
    box.addEventListener('paste', e => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '');
      boxes.forEach((b, j) => { b.value = text[j] || ''; });
      const last = Math.min(text.length, boxes.length) - 1;
      if (last >= 0) boxes[last].focus();
    });
  });

  document.getElementById('phoneInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendPhoneOtp();
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
