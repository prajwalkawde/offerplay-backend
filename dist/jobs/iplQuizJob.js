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
exports.scheduleQuizGeneration = scheduleQuizGeneration;
exports.scheduleDailyBonusReminders = scheduleDailyBonusReminders;
exports.scheduleResultVerification = scheduleResultVerification;
exports.generateQuestionsForTodayMatches = generateQuestionsForTodayMatches;
exports.verifyMatchResults = verifyMatchResults;
exports.scheduleQuestionNotifications = scheduleQuestionNotifications;
const node_cron_1 = __importDefault(require("node-cron"));
const database_1 = require("../config/database");
const cricApiService_1 = require("../services/cricApiService");
const claudeAiService_1 = require("../services/claudeAiService");
const coinService_1 = require("../services/coinService");
const logger_1 = require("../utils/logger");
const oneSignalService_1 = require("../services/oneSignalService");
// Runs every day at 8 AM — generates quiz questions for today's IPL matches
function scheduleQuizGeneration() {
    node_cron_1.default.schedule('0 8 * * *', async () => {
        logger_1.logger.info('Starting IPL quiz generation job...');
        try {
            await generateQuestionsForTodayMatches();
        }
        catch (err) {
            logger_1.logger.error('Quiz generation job failed:', err);
        }
    });
    logger_1.logger.info('IPL quiz generation job scheduled (daily at 08:00)');
}
// Runs at 9 AM and 7 PM daily — reminds users to claim their daily bonus
function scheduleDailyBonusReminders() {
    node_cron_1.default.schedule('0 9 * * *', async () => {
        logger_1.logger.info('Sending daily bonus reminders (9 AM)...');
        await (0, oneSignalService_1.sendDailyBonusReminders)();
    });
    node_cron_1.default.schedule('0 19 * * *', async () => {
        logger_1.logger.info('Sending daily bonus reminders (7 PM)...');
        await (0, oneSignalService_1.sendDailyBonusReminders)();
    });
    logger_1.logger.info('Daily bonus reminder jobs scheduled (09:00 and 19:00)');
}
// Runs every hour — checks completed matches and credits coins to correct predictors
function scheduleResultVerification() {
    node_cron_1.default.schedule('0 * * * *', async () => {
        logger_1.logger.info('Checking IPL match results...');
        try {
            await verifyCompletedMatches();
        }
        catch (err) {
            logger_1.logger.error('Result verification job failed:', err);
        }
    });
    logger_1.logger.info('IPL result verification job scheduled (hourly)');
}
// ─── Core Logic (also called from admin controller for manual triggers) ────────
async function generateQuestionsForTodayMatches() {
    const matches = await (0, cricApiService_1.getTodayIPLMatches)();
    let generated = 0;
    for (const match of matches) {
        if (!match.team1 || !match.team2)
            continue;
        // Skip if questions already exist for this Cricbuzz match
        const existing = await database_1.prisma.iplQuestion.findFirst({
            where: { match: { cricApiId: match.id?.toString() } },
        });
        if (existing)
            continue;
        // Find or create match record in DB
        let dbMatch = await database_1.prisma.iplMatch.findFirst({
            where: { cricApiId: match.id?.toString() },
        });
        if (!dbMatch) {
            dbMatch = await database_1.prisma.iplMatch.create({
                data: {
                    matchNumber: 0,
                    team1: match.team1,
                    team2: match.team2,
                    matchDate: match.startTime ? new Date(parseInt(match.startTime)) : new Date(),
                    venue: match.venue || match.city || 'TBD',
                    status: 'upcoming',
                    cricApiId: match.id?.toString(),
                },
            });
        }
        // Generate questions with Claude AI
        const questions = await (0, claudeAiService_1.generateIPLQuestions)({
            team1: dbMatch.team1,
            team2: dbMatch.team2,
            date: dbMatch.matchDate.toDateString(),
            venue: dbMatch.venue ?? 'TBD',
        });
        // Save to DB
        for (const q of questions) {
            await database_1.prisma.iplQuestion.create({
                data: {
                    matchId: dbMatch.id,
                    question: q.question,
                    options: q.options,
                    correctAnswer: q.correctAnswer || '',
                    points: q.points || 100,
                    status: 'active',
                    isAutoGenerated: true,
                    generatedBy: 'claude-ai',
                },
            });
        }
        logger_1.logger.info(`Generated ${questions.length} questions for ${dbMatch.team1} vs ${dbMatch.team2}`);
        generated += questions.length;
    }
    return generated;
}
async function verifyMatchResults(matchId) {
    const match = await database_1.prisma.iplMatch.findUnique({
        where: { id: matchId },
        include: { questions: true },
    });
    if (!match || !match.cricApiId) {
        throw new Error('Match not found or has no CricAPI ID');
    }
    const scoreData = await (0, cricApiService_1.getMatchScore)(match.cricApiId);
    // Cricbuzz hscard: matchHeader.state === 'Complete' when done
    const matchHeader = scoreData?.matchHeader;
    const isComplete = matchHeader?.state === 'Complete' ||
        matchHeader?.state === 'complete' ||
        matchHeader?.complete === true;
    if (!isComplete) {
        throw new Error('Match has not ended yet');
    }
    const winner = matchHeader?.result?.winningTeam || '';
    const manOfMatch = matchHeader?.playersOfTheMatch?.[0]?.fullName || '';
    // scoreCard array: each element is an innings
    const innings = scoreData?.scoreCard || [];
    const team1Score = innings[0]?.scoreDetails?.runs
        ? `${innings[0].scoreDetails.runs}/${innings[0].scoreDetails.wickets}`
        : undefined;
    const team2Score = innings[1]?.scoreDetails?.runs
        ? `${innings[1].scoreDetails.runs}/${innings[1].scoreDetails.wickets}`
        : undefined;
    // Update match status
    await database_1.prisma.iplMatch.update({
        where: { id: match.id },
        data: {
            status: 'completed',
            result: matchHeader?.result?.resultDescription || winner,
            winnerId: winner,
            team1Score,
            team2Score,
            manOfMatch,
        },
    });
    // Verify answers with Claude AI
    const verifiedQuestions = await (0, claudeAiService_1.verifyAnswersWithAI)(match.questions, {
        winner,
        manOfMatch,
        topScorer: '',
        team1Score: innings[0]?.scoreDetails?.runs,
        team2Score: innings[1]?.scoreDetails?.runs,
    });
    // Update correct answers
    for (const q of verifiedQuestions) {
        if (q.id && q.correctAnswer) {
            await database_1.prisma.iplQuestion.update({
                where: { id: q.id },
                data: { correctAnswer: q.correctAnswer },
            });
        }
    }
    // Credit coins to correct predictors
    const predictions = await database_1.prisma.iplPrediction.findMany({
        where: { matchId: match.id },
    });
    for (const pred of predictions) {
        const question = verifiedQuestions.find((q) => q.id === pred.questionId);
        if (!question?.correctAnswer)
            continue;
        const isCorrect = pred.answer === question.correctAnswer;
        const pointsEarned = isCorrect ? question.points : 0;
        await database_1.prisma.iplPrediction.update({
            where: { id: pred.id },
            data: { isCorrect, pointsEarned },
        });
        if (isCorrect) {
            await (0, coinService_1.creditCoins)(pred.userId, pointsEarned, 'EARN_IPL_WIN', pred.id, `IPL prediction correct: ${question.question}`);
        }
    }
    logger_1.logger.info(`Results processed for match: ${match.team1} vs ${match.team2}`);
}
// Runs every minute — notifies users when contest questions go live
function scheduleQuestionNotifications() {
    node_cron_1.default.schedule('* * * * *', async () => {
        try {
            const now = new Date();
            const oneMinuteAgo = new Date(now.getTime() - 60000);
            const contests = await database_1.prisma.iplContest.findMany({
                where: {
                    questionsAvailableAt: { gte: oneMinuteAgo, lte: now },
                    status: 'published',
                },
                include: {
                    match: true,
                    entries: { select: { userId: true } },
                },
            });
            for (const contest of contests) {
                if (contest.entries.length === 0)
                    continue;
                const userIds = contest.entries.map(e => e.userId);
                try {
                    const { sendBulkNotification } = await Promise.resolve().then(() => __importStar(require('../services/notificationService')));
                    await sendBulkNotification(userIds, 'Questions are LIVE!', `Predict now for ${contest.match.team1} vs ${contest.match.team2}! Contest: ${contest.name}`, 'IPL_QUESTIONS_LIVE');
                }
                catch { /* non-critical */ }
                logger_1.logger.info(`Question notifications sent for contest: ${contest.name}`);
            }
        }
        catch (err) {
            logger_1.logger.error('Question notification job error:', err);
        }
    });
    logger_1.logger.info('Question notification job scheduled (every minute)');
}
async function verifyCompletedMatches() {
    const liveMatches = await database_1.prisma.iplMatch.findMany({
        where: { status: 'live', cricApiId: { not: null } },
        include: { questions: true },
    });
    for (const match of liveMatches) {
        try {
            await verifyMatchResults(match.id);
        }
        catch (err) {
            // Log but continue processing other matches
            logger_1.logger.warn(`Result verification skipped for match ${match.id}:`, err);
        }
    }
}
