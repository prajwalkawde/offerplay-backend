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
exports.coinQueue = void 0;
exports.startCoinWorker = startCoinWorker;
exports.enqueueCoinCredit = enqueueCoinCredit;
exports.schedulePostbackRetry = schedulePostbackRetry;
const bullmq_1 = require("bullmq");
const node_cron_1 = __importDefault(require("node-cron"));
const coinService_1 = require("../services/coinService");
const logger_1 = require("../utils/logger");
const env_1 = require("../config/env");
function buildConnection() {
    const isTls = env_1.env.REDIS_URL.startsWith('rediss://');
    if (isTls) {
        // Upstash / TLS Redis — parse URL manually for BullMQ
        const url = new URL(env_1.env.REDIS_URL);
        return {
            host: url.hostname,
            port: parseInt(url.port || '6379', 10),
            password: url.password || undefined,
            username: url.username || undefined,
            tls: { rejectUnauthorized: false },
        };
    }
    const url = new URL(env_1.env.REDIS_URL);
    return {
        host: url.hostname,
        port: parseInt(url.port || '6379', 10),
        password: url.password || undefined,
    };
}
const connection = buildConnection();
exports.coinQueue = new bullmq_1.Queue('coin-operations', {
    connection,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 500,
    },
});
function startCoinWorker() {
    const worker = new bullmq_1.Worker('coin-operations', async (job) => {
        const { userId, amount, type, refId, description } = job.data;
        await (0, coinService_1.creditCoins)(userId, amount, type, refId, description);
        logger_1.logger.debug('Coin job processed', { jobId: job.id, userId, amount });
    }, { connection });
    worker.on('failed', (job, err) => {
        logger_1.logger.error('Coin job failed', { jobId: job?.id, err });
    });
    return worker;
}
async function enqueueCoinCredit(data) {
    await exports.coinQueue.add('credit', data);
}
// ─── Postback Retry Scheduler (every 5 minutes) ───────────────────────────────
function schedulePostbackRetry() {
    node_cron_1.default.schedule('*/5 * * * *', async () => {
        try {
            const { processRetryQueue } = await Promise.resolve().then(() => __importStar(require('../services/postbackService')));
            await processRetryQueue();
        }
        catch (err) {
            logger_1.logger.error('Postback retry job failed:', { message: err.message });
        }
    });
    logger_1.logger.info('Postback retry queue scheduler started (every 5 min)');
}
