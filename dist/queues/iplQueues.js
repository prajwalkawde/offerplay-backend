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
Object.defineProperty(exports, "__esModule", { value: true });
exports.iplNotifQueue = exports.iplScoreCalcQueue = exports.iplResultVerifyQueue = exports.iplMatchMonitorQueue = exports.iplContestUnlockQueue = exports.iplQuestionGenQueue = void 0;
exports.startIPLWorkers = startIPLWorkers;
exports.scheduleMatchJobs = scheduleMatchJobs;
const bullmq_1 = require("bullmq");
const database_1 = require("../config/database");
const logger_1 = require("../utils/logger");
const QUEUE_PREFIX = 'xyvmkurmut';
function getConn() {
    return {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        username: process.env.REDIS_USERNAME || undefined,
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    };
}
const defaultOpts = {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 50,
    removeOnFail: 200,
};
// ─── Queues ───────────────────────────────────────────────────────────────────
exports.iplQuestionGenQueue = new bullmq_1.Queue('ipl-question-generation', {
    connection: getConn(), prefix: QUEUE_PREFIX, defaultJobOptions: defaultOpts,
});
exports.iplContestUnlockQueue = new bullmq_1.Queue('ipl-contest-unlock', {
    connection: getConn(), prefix: QUEUE_PREFIX, defaultJobOptions: defaultOpts,
});
exports.iplMatchMonitorQueue = new bullmq_1.Queue('ipl-match-monitor', {
    connection: getConn(), prefix: QUEUE_PREFIX, defaultJobOptions: defaultOpts,
});
exports.iplResultVerifyQueue = new bullmq_1.Queue('ipl-result-verify', {
    connection: getConn(), prefix: QUEUE_PREFIX, defaultJobOptions: defaultOpts,
});
exports.iplScoreCalcQueue = new bullmq_1.Queue('ipl-score-calc', {
    connection: getConn(), prefix: QUEUE_PREFIX, defaultJobOptions: defaultOpts,
});
exports.iplNotifQueue = new bullmq_1.Queue('ipl-notifications', {
    connection: getConn(), prefix: QUEUE_PREFIX, defaultJobOptions: defaultOpts,
});
// ─── Log helper ───────────────────────────────────────────────────────────────
async function logJob(jobType, status, message, matchId, data) {
    try {
        await database_1.prisma.automationLog.create({ data: { jobType, status, message, matchId, data } });
    }
    catch { /* non-critical */ }
}
// ─── Workers ──────────────────────────────────────────────────────────────────
function startIPLWorkers() {
    const conn = getConn();
    // Question generation worker
    const qGenWorker = new bullmq_1.Worker('ipl-question-generation', async (job) => {
        const { matchId } = job.data;
        try {
            const match = await database_1.prisma.iplMatch.findUnique({ where: { id: matchId } });
            if (!match)
                throw new Error('Match not found');
            if (match.questionsGenerated) {
                logger_1.logger.info(`Questions already generated for match ${matchId}`);
                return;
            }
            const { generateQuestionsWithContext } = await Promise.resolve().then(() => __importStar(require('../services/claudeAiService')));
            const questions = await generateQuestionsWithContext({
                team1: match.team1, team2: match.team2,
                date: match.matchDate.toDateString(),
                venue: match.venue ?? 'TBD',
                team1Players: Array.isArray(match.team1Players) ? match.team1Players : undefined,
                team2Players: Array.isArray(match.team2Players) ? match.team2Players : undefined,
            });
            // Delete existing auto-generated and recreate
            await database_1.prisma.iplQuestion.deleteMany({ where: { matchId, isAutoGenerated: true } });
            for (let i = 0; i < questions.length; i++) {
                const q = questions[i];
                await database_1.prisma.iplQuestion.create({
                    data: {
                        matchId, question: q.question, options: q.options,
                        correctAnswer: q.correctAnswer || '',
                        points: q.points || 100,
                        category: q.category || 'prediction',
                        difficulty: q.difficulty || 'medium',
                        status: 'active', isAutoGenerated: true,
                        generatedBy: 'claude-ai', approved: false,
                        questionNumber: i + 1,
                        questionContext: q.questionContext || null,
                    },
                });
            }
            await database_1.prisma.iplMatch.update({
                where: { id: matchId },
                data: { questionsGenerated: true, lastSyncedAt: new Date() },
            });
            await logJob('QUESTION_GEN', 'SUCCESS', `Generated ${questions.length} questions`, matchId);
            logger_1.logger.info(`Generated ${questions.length} questions for match ${matchId}`);
        }
        catch (err) {
            await logJob('QUESTION_GEN', 'FAILED', err.message, matchId);
            throw err;
        }
    }, { connection: conn, prefix: QUEUE_PREFIX });
    // Contest unlock worker
    const unlockWorker = new bullmq_1.Worker('ipl-contest-unlock', async (job) => {
        const { matchId } = job.data;
        try {
            const contests = await database_1.prisma.iplContest.findMany({
                where: { matchId, status: 'draft' },
                include: { entries: { select: { userId: true } } },
            });
            for (const contest of contests) {
                await database_1.prisma.iplContest.update({
                    where: { id: contest.id },
                    data: { status: 'published' },
                });
                // Notify joined users
                if (contest.entries.length > 0) {
                    const { sendBulkNotification } = await Promise.resolve().then(() => __importStar(require('../services/notificationService')));
                    await sendBulkNotification(contest.entries.map(e => e.userId), 'Contest is LIVE!', `Predict now for ${contest.name}! Contest closes soon.`, 'CONTEST_UNLOCK').catch(() => { });
                }
            }
            await logJob('CONTEST_UNLOCK', 'SUCCESS', `Unlocked ${contests.length} contests`, matchId);
        }
        catch (err) {
            await logJob('CONTEST_UNLOCK', 'FAILED', err.message, matchId);
            throw err;
        }
    }, { connection: conn, prefix: QUEUE_PREFIX });
    // Result verification worker
    const resultWorker = new bullmq_1.Worker('ipl-result-verify', async (job) => {
        const { matchId } = job.data;
        try {
            const { verifyMatchResults } = await Promise.resolve().then(() => __importStar(require('../jobs/iplQuizJob')));
            await verifyMatchResults(matchId);
            await database_1.prisma.iplMatch.update({
                where: { id: matchId },
                data: { resultVerified: true, resultPostedAt: new Date(), autoProcessed: true },
            });
            // Trigger score calculation
            await exports.iplScoreCalcQueue.add('calculateScores', { matchId });
            await logJob('RESULT_VERIFY', 'SUCCESS', 'Results verified and scores queued', matchId);
        }
        catch (err) {
            await logJob('RESULT_VERIFY', 'FAILED', err.message, matchId);
            throw err;
        }
    }, { connection: conn, prefix: QUEUE_PREFIX });
    // Score calculation worker
    const scoreWorker = new bullmq_1.Worker('ipl-score-calc', async (job) => {
        const { matchId } = job.data;
        try {
            const entries = await database_1.prisma.iplContestEntry.findMany({
                where: { contest: { matchId } },
                include: { contest: true },
            });
            // Group by contest
            const byContest = new Map();
            for (const e of entries) {
                if (!byContest.has(e.contestId))
                    byContest.set(e.contestId, []);
                byContest.get(e.contestId).push(e);
            }
            for (const [contestId, contestEntries] of byContest) {
                // Get points per user (sum of correct predictions for this match)
                const matchPredictions = await database_1.prisma.iplPrediction.findMany({
                    where: { matchId, userId: { in: contestEntries.map(e => e.userId) } },
                });
                const userPoints = new Map();
                for (const p of matchPredictions) {
                    userPoints.set(p.userId, (userPoints.get(p.userId) || 0) + p.pointsEarned);
                }
                // Sort by points desc
                const sorted = contestEntries
                    .map(e => ({ ...e, pts: userPoints.get(e.userId) || 0 }))
                    .sort((a, b) => b.pts - a.pts);
                // Assign ranks and update
                for (let i = 0; i < sorted.length; i++) {
                    await database_1.prisma.iplContestEntry.update({
                        where: { id: sorted[i].id },
                        data: { totalPoints: sorted[i].pts, rank: i + 1 },
                    });
                }
                await database_1.prisma.iplContest.update({
                    where: { id: contestId }, data: { status: 'completed' },
                });
            }
            await logJob('SCORE_CALC', 'SUCCESS', `Scores calculated for ${entries.length} entries`, matchId);
        }
        catch (err) {
            await logJob('SCORE_CALC', 'FAILED', err.message, matchId);
            throw err;
        }
    }, { connection: conn, prefix: QUEUE_PREFIX });
    // Error handlers
    for (const w of [qGenWorker, unlockWorker, resultWorker, scoreWorker]) {
        w.on('failed', (job, err) => logger_1.logger.error(`IPL worker failed`, { queue: job?.queueName, err: err.message }));
    }
    logger_1.logger.info('IPL BullMQ workers started');
    return [qGenWorker, unlockWorker, resultWorker, scoreWorker];
}
// ─── Schedule helpers ─────────────────────────────────────────────────────────
async function scheduleMatchJobs(matchId, matchDate) {
    const now = Date.now();
    const matchTime = matchDate.getTime();
    // Generate questions 24hrs before match
    const qDelay = Math.max(0, matchTime - 24 * 3600 * 1000 - now);
    await exports.iplQuestionGenQueue.add('generateQuestions', { matchId }, { delay: qDelay });
    // Unlock contest 4hrs before match
    const unlockDelay = Math.max(0, matchTime - 4 * 3600 * 1000 - now);
    await exports.iplContestUnlockQueue.add('unlockContest', { matchId }, { delay: unlockDelay });
    // Monitor match starting from match time
    const monitorDelay = Math.max(0, matchTime - now);
    await exports.iplMatchMonitorQueue.add('monitorMatch', { matchId }, {
        delay: monitorDelay,
        repeat: { every: 5 * 60 * 1000, limit: 60 }, // every 5 mins, max 5hrs
    });
    logger_1.logger.info(`Scheduled jobs for match ${matchId} at ${matchDate.toISOString()}`);
}
