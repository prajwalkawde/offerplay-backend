"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.io = void 0;
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const env_1 = require("./config/env");
const database_1 = require("./config/database");
const firebase_1 = require("./config/firebase");
const leaderboard_1 = require("./socket/leaderboard");
const coinQueue_1 = require("./queues/coinQueue");
const notifQueue_1 = require("./queues/notifQueue");
const iplQuizJob_1 = require("./jobs/iplQuizJob");
const logger_1 = require("./utils/logger");
const response_1 = require("./utils/response");
// Routes
const auth_1 = __importDefault(require("./routes/auth"));
const users_1 = __importDefault(require("./routes/users"));
const contests_1 = __importDefault(require("./routes/contests"));
const games_1 = __importDefault(require("./routes/games"));
const earn_1 = __importDefault(require("./routes/earn"));
const redeem_1 = __importDefault(require("./routes/redeem"));
const postback_1 = __importDefault(require("./routes/postback"));
const ipl_1 = __importDefault(require("./routes/ipl"));
const admin_1 = __importDefault(require("./routes/admin"));
const app_1 = __importDefault(require("./routes/app"));
const home_1 = __importDefault(require("./routes/home"));
const referral_1 = __importDefault(require("./routes/referral"));
const quests_1 = __importDefault(require("./routes/quests"));
const customOffers_1 = __importDefault(require("./routes/customOffers"));
const offerwall_1 = __importDefault(require("./routes/offerwall"));
const adjoeController_1 = require("./controllers/adjoeController");
const deepLinkController_1 = require("./controllers/deepLinkController");
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
// ─── Socket.io ────────────────────────────────────────────────────────────────
const io = new socket_io_1.Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
});
exports.io = io;
(0, leaderboard_1.setupLeaderboardSocket)(io);
// ─── Middleware ───────────────────────────────────────────────────────────────
const allowedOrigins = [
    'https://admin.offerplay.in',
    'https://phpstack-1554518-6313385.cloudwaysapps.com',
    'https://offerplay.in',
    'http://localhost:5173',
    'http://localhost:3000',
    process.env.ALLOWED_ORIGINS,
].filter(Boolean);
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        }
        else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
}));
app.use((0, compression_1.default)());
app.use(express_1.default.json({ limit: '1mb' }));
app.use(express_1.default.urlencoded({ extended: true }));
app.use('/uploads', express_1.default.static('public/uploads'));
// Trust proxy for rate limiting behind load balancer
app.set('trust proxy', 1);
// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString(), env: env_1.env.NODE_ENV });
});
// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth', auth_1.default);
app.use('/api/users', users_1.default);
app.use('/api/contests', contests_1.default);
app.use('/api/games', games_1.default);
app.use('/api/earn', earn_1.default);
app.use('/api/redeem', redeem_1.default);
app.use('/api/postback', postback_1.default);
app.use('/api/ipl', ipl_1.default);
app.use('/api/admin', admin_1.default);
app.use('/api/app', app_1.default);
app.use('/api/home', home_1.default);
app.use('/api/referral', referral_1.default);
app.use('/api/quests', quests_1.default);
app.use('/api/custom-offers', customOffers_1.default);
app.use('/api/offerwall', offerwall_1.default);
app.get('/api/adjoe/postback', adjoeController_1.handleAdjoePostback);
app.get('/r/:code', deepLinkController_1.handleReferralRedirect);
// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
    (0, response_1.error)(res, 'Route not found', 404);
});
// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    logger_1.logger.error('Unhandled error', { message: err.message, stack: err.stack });
    (0, response_1.error)(res, env_1.env.NODE_ENV === 'production' ? 'Internal server error' : err.message, 500);
});
// ─── Startup ──────────────────────────────────────────────────────────────────
async function bootstrap() {
    // Ensure logs directory exists
    const fs = await Promise.resolve().then(() => __importStar(require('fs')));
    if (!fs.existsSync('logs'))
        fs.mkdirSync('logs');
    await (0, database_1.connectDatabase)();
    (0, firebase_1.initFirebase)();
    // Start background workers (non-fatal if Redis unavailable)
    try {
        (0, coinQueue_1.startCoinWorker)();
        (0, notifQueue_1.startNotifWorker)();
        logger_1.logger.info('BullMQ workers started');
    }
    catch (err) {
        logger_1.logger.warn('BullMQ workers failed to start (Redis may be unavailable)', { err });
    }
    // Start IPL workers
    try {
        const { startIPLWorkers } = await Promise.resolve().then(() => __importStar(require('./queues/iplQueues')));
        startIPLWorkers();
        logger_1.logger.info('IPL BullMQ workers started');
    }
    catch (err) {
        logger_1.logger.warn('IPL workers failed to start', { err });
    }
    httpServer.listen(env_1.env.PORT, () => {
        logger_1.logger.info(`OfferPlay backend running on port ${env_1.env.PORT} [${env_1.env.NODE_ENV}]`);
    });
    (0, iplQuizJob_1.scheduleQuizGeneration)();
    (0, iplQuizJob_1.scheduleResultVerification)();
    (0, iplQuizJob_1.scheduleDailyBonusReminders)();
    (0, iplQuizJob_1.scheduleQuestionNotifications)();
    logger_1.logger.info('IPL quiz jobs scheduled');
    (0, coinQueue_1.schedulePostbackRetry)();
}
bootstrap().catch((err) => {
    logger_1.logger.error('Bootstrap failed', { err });
    process.exit(1);
});
