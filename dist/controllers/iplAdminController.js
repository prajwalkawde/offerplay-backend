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
exports.getAdminIPLMatches = getAdminIPLMatches;
exports.createAdminIPLMatch = createAdminIPLMatch;
exports.getMatchContests = getMatchContests;
exports.createIPLContest = createIPLContest;
exports.updateIPLContest = updateIPLContest;
exports.deleteIPLContest = deleteIPLContest;
exports.publishIPLContest = publishIPLContest;
exports.processIPLContestResults = processIPLContestResults;
exports.getContestParticipants = getContestParticipants;
exports.updateIPLMatch = updateIPLMatch;
exports.processIPLResults = processIPLResults;
exports.saveEditedQuestions = saveEditedQuestions;
exports.generateResultReport = generateResultReport;
exports.fetchTodayMatches = fetchTodayMatches;
exports.generateIPLQuestions = generateIPLQuestions;
exports.deleteAdminIPLMatch = deleteAdminIPLMatch;
exports.getIPLAnalytics = getIPLAnalytics;
exports.fetchIPLSchedule = fetchIPLSchedule;
const client_1 = require("@prisma/client");
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const logger_1 = require("../utils/logger");
const coinService_1 = require("../services/coinService");
const cricApiService_1 = require("../services/cricApiService");
// ─── Admin: List all matches with question + contest counts ───────────────────
async function getAdminIPLMatches(_req, res) {
    const matches = await database_1.prisma.iplMatch.findMany({
        include: {
            questions: { select: { id: true } },
            contests: { select: { id: true, status: true } },
        },
        orderBy: { matchDate: 'asc' },
    });
    const result = matches.map(m => ({
        ...m,
        questionCount: m.questions.length,
        contestCount: m.contests.length,
        publishedContests: m.contests.filter(c => c.status === 'published' || c.status === 'live').length,
    }));
    (0, response_1.success)(res, result);
}
// ─── Admin: Create a match ─────────────────────────────────────────────────────
async function createAdminIPLMatch(req, res) {
    const { team1, team2, matchDate, venue, matchNumber, youtubeUrl, matchStartTime, registrationCloseTime, resultDeclareTime, } = req.body;
    if (!team1 || !team2 || !matchDate) {
        (0, response_1.error)(res, 'team1, team2, matchDate required', 400);
        return;
    }
    if (team1 === team2) {
        (0, response_1.error)(res, 'Teams must be different', 400);
        return;
    }
    const match = await database_1.prisma.iplMatch.create({
        data: {
            team1, team2,
            matchDate: new Date(matchDate),
            venue: venue || 'TBD',
            matchNumber: parseInt(String(matchNumber)) || 1,
            youtubeUrl: youtubeUrl || null,
            matchStartTime: matchStartTime ? new Date(matchStartTime) : null,
            registrationCloseTime: registrationCloseTime ? new Date(registrationCloseTime) : null,
            resultDeclareTime: resultDeclareTime ? new Date(resultDeclareTime) : null,
            status: 'upcoming',
        },
    });
    (0, response_1.success)(res, match, 'Match created!', 201);
}
// ─── Get all contests for a match ─────────────────────────────────────────────
async function getMatchContests(req, res) {
    const { matchId } = req.params;
    const contests = await database_1.prisma.iplContest.findMany({
        where: { matchId },
        include: { _count: { select: { entries: true } } },
        orderBy: { createdAt: 'asc' },
    });
    const result = contests.map(c => ({
        ...c,
        currentPlayers: c._count.entries,
        _count: undefined,
    }));
    (0, response_1.success)(res, result);
}
// ─── Create a new contest for a match ─────────────────────────────────────────
async function createIPLContest(req, res) {
    const { matchId } = req.params;
    console.log('=== CREATE CONTEST REQUEST ===');
    console.log('prizeTiersConfig received:', JSON.stringify(req.body.prizeTiersConfig));
    console.log('winnersConfig received:', JSON.stringify(req.body.winnersConfig));
    console.log('questionsLockAt:', req.body.questionsLockAt);
    console.log('questionsAvailableAt:', req.body.questionsAvailableAt);
    console.log('==============================');
    const { name, contestType, battleType, maxPlayers, minPlayers, entryFee, isFree, prizeType, prizeCoins, prizeGiftName, prizeGiftImage, prizeGiftValue, rewardImageUrl, rewardImageType, questionCount, youtubeUrl, entryType, ticketCost, winnersConfig, prizeTiersConfig, sponsorId, sponsorName, sponsorLogo, maxEntriesPerUser, customFields, prizeDistribution, regCloseTime, questionsAvailableAt, questionsLockAt, } = req.body;
    if (!contestType || !battleType || entryFee === undefined) {
        (0, response_1.error)(res, 'contestType, battleType, entryFee required', 400);
        return;
    }
    const match = await database_1.prisma.iplMatch.findUnique({ where: { id: matchId } });
    if (!match) {
        (0, response_1.error)(res, 'Match not found', 404);
        return;
    }
    const resolvedMax = battleType === '1V1' ? 2 :
        battleType === 'SMALL' ? 4 :
            (maxPlayers ?? 1000);
    const resolvedName = name || `${battleType} Contest`;
    const contest = await database_1.prisma.iplContest.create({
        data: {
            matchId,
            name: resolvedName,
            contestType,
            battleType,
            maxPlayers: resolvedMax,
            minPlayers: minPlayers ?? 2,
            entryFee,
            entryType: entryType ?? 'TICKET',
            ticketCost: ticketCost ?? 1,
            isFree: isFree ?? (entryFee === 0),
            prizeType: prizeType ?? 'COINS',
            prizeCoins: prizeCoins ?? null,
            prizeGiftName: prizeGiftName ?? null,
            prizeGiftImage: prizeGiftImage ?? null,
            prizeGiftValue: prizeGiftValue ?? null,
            rewardImageUrl: rewardImageUrl ?? null,
            rewardImageType: rewardImageType ?? null,
            questionCount: questionCount ? parseInt(String(questionCount)) : 10,
            youtubeUrl: youtubeUrl ?? null,
            winnersConfig: (winnersConfig ?? []),
            prizeTiersConfig: (prizeTiersConfig ?? []),
            sponsorId: sponsorId ?? null,
            sponsorName: sponsorName ?? null,
            sponsorLogo: sponsorLogo ?? null,
            maxEntriesPerUser: maxEntriesPerUser ?? 3,
            customFields: customFields ?? undefined,
            prizeDistribution: (prizeDistribution ?? { '1': 40, '2': 25, '3': 15, '4-10': 20 }),
            regCloseTime: regCloseTime ? new Date(regCloseTime) : null,
            questionsAvailableAt: questionsAvailableAt ? new Date(questionsAvailableAt) : null,
            questionsLockAt: questionsLockAt ? new Date(questionsLockAt) : null,
            status: 'draft',
        },
    });
    console.log('Contest saved with tiers:', JSON.stringify(contest.prizeTiersConfig));
    console.log('questionsLockAt saved:', contest.questionsLockAt);
    (0, response_1.success)(res, contest, 'Contest created successfully!', 201);
}
// ─── Update contest ────────────────────────────────────────────────────────────
async function updateIPLContest(req, res) {
    const { contestId } = req.params;
    // Strip relational fields that Prisma won't accept
    const { entries: _entries, match: _match, ...safeData } = req.body;
    const contest = await database_1.prisma.iplContest.update({
        where: { id: contestId },
        data: safeData,
    });
    (0, response_1.success)(res, contest, 'Contest updated');
}
// ─── Delete contest ────────────────────────────────────────────────────────────
async function deleteIPLContest(req, res) {
    const { contestId } = req.params;
    const entryCount = await database_1.prisma.iplContestEntry.count({ where: { contestId } });
    if (entryCount > 0) {
        (0, response_1.error)(res, 'Cannot delete a contest that already has participants', 400);
        return;
    }
    await database_1.prisma.iplContest.delete({ where: { id: contestId } });
    (0, response_1.success)(res, null, 'Contest deleted');
}
// ─── Publish contest ───────────────────────────────────────────────────────────
async function publishIPLContest(req, res) {
    const { contestId } = req.params;
    const contest = await database_1.prisma.iplContest.update({
        where: { id: contestId },
        data: { status: 'published' },
        include: { match: true },
    });
    try {
        const { sendToAll } = await Promise.resolve().then(() => __importStar(require('../services/notificationService')));
        await sendToAll('🏏 New IPL Contest Live!', `${contest.match.team1} vs ${contest.match.team2} — ${contest.name} is open!`, 'ipl_contest_published');
    }
    catch (notifErr) {
        logger_1.logger.warn('Failed to send publish notification:', notifErr);
    }
    logger_1.logger.info(`IPL contest published: ${contest.name} (${contestId})`);
    (0, response_1.success)(res, contest, '🚀 Contest published! Users notified.');
}
async function processIPLContestResults(req, res) {
    const { contestId } = req.params;
    const contest = await database_1.prisma.iplContest.findUnique({
        where: { id: contestId },
        include: { entries: true, match: true },
    });
    if (!contest) {
        (0, response_1.error)(res, 'Contest not found', 404);
        return;
    }
    if (contest.status === 'completed') {
        (0, response_1.error)(res, 'Contest already processed', 400);
        return;
    }
    const entryUserIds = contest.entries.map(e => e.userId);
    const [predictions, questions] = await Promise.all([
        database_1.prisma.iplPrediction.findMany({
            where: { matchId: contest.matchId, userId: { in: entryUserIds } },
        }),
        database_1.prisma.iplQuestion.findMany({ where: { matchId: contest.matchId } }),
    ]);
    // Score each user
    const userScores = {};
    for (const entry of contest.entries)
        userScores[entry.userId] = 0;
    for (const pred of predictions) {
        if (!pred.isCorrect)
            continue;
        const question = questions.find(q => q.id === pred.questionId);
        if (question)
            userScores[pred.userId] = (userScores[pred.userId] ?? 0) + question.points;
    }
    const rankings = Object.entries(userScores)
        .sort(([, a], [, b]) => b - a)
        .map(([userId, score], i) => ({ userId, score, rank: i + 1 }));
    const prizeTiers = contest.prizeTiers || [];
    const hasPrizeTiers = prizeTiers.length > 0;
    const totalPool = contest.entries.length * contest.entryFee;
    const prizePool = Math.floor(totalPool * 0.85);
    const dist = contest.prizeDistribution;
    let coinsDistributed = 0;
    let giftClaimsCreated = 0;
    for (const { userId, rank } of rankings) {
        let coinsAward = 0;
        let giftTier;
        if (hasPrizeTiers) {
            // Find matching tier from admin-configured prize tiers
            const tier = prizeTiers.find(t => {
                if (t.rankFrom !== undefined && t.rankTo !== undefined) {
                    return rank >= t.rankFrom && rank <= t.rankTo;
                }
                return t.rank === rank;
            });
            if (tier) {
                if (tier.type === 'gift') {
                    giftTier = tier;
                }
                else {
                    coinsAward = tier.coins ?? 0;
                }
            }
        }
        else if (contest.prizeType === 'COINS' && contest.prizeCoins && rank === 1) {
            coinsAward = contest.prizeCoins;
        }
        else {
            // Default percentage distribution
            if (rank === 1)
                coinsAward = Math.floor(prizePool * (dist['1'] ?? 40) / 100);
            else if (rank === 2)
                coinsAward = Math.floor(prizePool * (dist['2'] ?? 25) / 100);
            else if (rank === 3)
                coinsAward = Math.floor(prizePool * (dist['3'] ?? 15) / 100);
            else if (rank <= 10)
                coinsAward = Math.floor(prizePool * (dist['4-10'] ?? 20) / 100 / 7);
        }
        // Award coins
        if (coinsAward > 0) {
            await (0, coinService_1.creditCoins)(userId, coinsAward, client_1.TransactionType.EARN_IPL_WIN, contestId, `IPL Contest Win — ${contest.name} — Rank #${rank}`);
            await database_1.prisma.iplContestEntry.updateMany({
                where: { contestId, userId },
                data: { rank, coinsWon: coinsAward, totalPoints: userScores[userId] ?? 0 },
            });
            coinsDistributed += coinsAward;
        }
        // Award gift prize — create an IplPrizeClaim
        if (giftTier) {
            await database_1.prisma.iplPrizeClaim.create({
                data: {
                    userId,
                    iplContestId: contestId,
                    rank,
                    prizeType: 'gift',
                    prizeName: giftTier.name || 'Gift Prize',
                    prizeValue: giftTier.value ?? 0,
                    prizeImageUrl: giftTier.imageUrl || '',
                    inventoryId: giftTier.inventoryId || null,
                    status: 'pending',
                },
            });
            await database_1.prisma.iplContestEntry.updateMany({
                where: { contestId, userId },
                data: { rank, totalPoints: userScores[userId] ?? 0 },
            });
            giftClaimsCreated++;
        }
        // Update rank+points for non-winners
        if (coinsAward === 0 && !giftTier) {
            await database_1.prisma.iplContestEntry.updateMany({
                where: { contestId, userId },
                data: { rank, totalPoints: userScores[userId] ?? 0 },
            });
        }
    }
    await database_1.prisma.iplContest.update({
        where: { id: contestId },
        data: { status: 'completed' },
    });
    logger_1.logger.info(`IPL contest processed: ${contest.name} — ${rankings.length} participants, ${coinsDistributed} coins, ${giftClaimsCreated} gift claims`);
    (0, response_1.success)(res, {
        totalParticipants: contest.entries.length,
        coinsDistributed,
        giftClaimsCreated,
        rankings: rankings.slice(0, 10),
    }, 'Results processed! Prizes distributed to winners.');
}
// ─── Get contest participants ──────────────────────────────────────────────────
async function getContestParticipants(req, res) {
    const { contestId } = req.params;
    const entries = await database_1.prisma.iplContestEntry.findMany({
        where: { contestId },
        include: {
            user: { select: { id: true, name: true, phone: true, coinBalance: true } },
        },
        orderBy: { totalPoints: 'desc' },
    });
    (0, response_1.success)(res, { participants: entries, total: entries.length });
}
// ─── Update IPL match ─────────────────────────────────────────────────────────
async function updateIPLMatch(req, res) {
    const { id } = req.params;
    const { youtubeUrl, status, venue, matchNumber, matchStartTime, registrationCloseTime, resultDeclareTime, } = req.body;
    const match = await database_1.prisma.iplMatch.update({
        where: { id },
        data: {
            ...(youtubeUrl !== undefined && { youtubeUrl }),
            ...(status !== undefined && { status }),
            ...(venue !== undefined && { venue }),
            ...(matchNumber !== undefined && { matchNumber }),
            ...(matchStartTime !== undefined && { matchStartTime: matchStartTime ? new Date(matchStartTime) : null }),
            ...(registrationCloseTime !== undefined && { registrationCloseTime: registrationCloseTime ? new Date(registrationCloseTime) : null }),
            ...(resultDeclareTime !== undefined && { resultDeclareTime: resultDeclareTime ? new Date(resultDeclareTime) : null }),
        },
    });
    (0, response_1.success)(res, match, 'Match updated!');
}
// ─── Process results for all contests in a match (with smart answer auto-fill) ─
async function processIPLResults(req, res) {
    const { matchId, winner, team1Score, team2Score, manOfMatch, } = req.body;
    if (!matchId || !winner) {
        (0, response_1.error)(res, 'matchId and winner are required', 400);
        return;
    }
    // Step 1: Update match result
    await database_1.prisma.iplMatch.update({
        where: { id: matchId },
        data: {
            status: 'completed',
            contestStatus: 'processing',
            result: `${winner} won. ${team1Score || ''} vs ${team2Score || ''}`.trim(),
            winnerId: winner,
            ...(team1Score && { team1Score }),
            ...(team2Score && { team2Score }),
            ...(manOfMatch && { manOfMatch }),
        },
    });
    // Step 2: Auto-fill correct answers via smart keyword matching
    const questions = await database_1.prisma.iplQuestion.findMany({ where: { matchId } });
    for (const q of questions) {
        const qLower = q.question.toLowerCase();
        let correctAnswer = q.correctAnswer;
        if (!correctAnswer) {
            if (qLower.includes('who will win') || qLower.includes('winner') || qLower.includes('which team will win')) {
                correctAnswer = winner;
            }
            else if (qLower.includes('man of the match') || qLower.includes('motm') ||
                qLower.includes('player of the match') || qLower.includes('best player')) {
                correctAnswer = manOfMatch || '';
            }
            // Toss and other questions remain empty — admin sets manually
        }
        if (correctAnswer && correctAnswer !== q.correctAnswer) {
            await database_1.prisma.iplQuestion.update({
                where: { id: q.id },
                data: { correctAnswer },
            });
        }
    }
    // Step 3: Process each contest for this match
    const contests = await database_1.prisma.iplContest.findMany({
        where: { matchId, status: { in: ['published', 'live'] } },
        include: { entries: true },
    });
    let totalCoinsDistributed = 0;
    let totalWinners = 0;
    for (const contest of contests) {
        const userIds = contest.entries.map(e => e.userId);
        const [predictions, updatedQuestions] = await Promise.all([
            database_1.prisma.iplPrediction.findMany({
                where: { matchId, userId: { in: userIds } },
            }),
            database_1.prisma.iplQuestion.findMany({ where: { matchId } }),
        ]);
        const userScores = {};
        for (const entry of contest.entries)
            userScores[entry.userId] = 0;
        for (const pred of predictions) {
            const q = updatedQuestions.find(q => q.id === pred.questionId);
            if (!q?.correctAnswer)
                continue;
            if (pred.answer === q.correctAnswer) {
                userScores[pred.userId] = (userScores[pred.userId] ?? 0) + q.points;
            }
        }
        const rankings = Object.entries(userScores)
            .sort(([, a], [, b]) => b - a)
            .map(([userId, score], i) => ({ userId, score, rank: i + 1 }));
        const winnersConfig = contest.winnersConfig || [];
        const totalPool = contest.entries.length * contest.entryFee;
        const prizePool = Math.floor(totalPool * 0.85);
        for (const { userId, rank } of rankings) {
            let coinsToAward = 0;
            if (winnersConfig.length > 0) {
                const winnerRule = winnersConfig
                    .find(w => {
                    if (w.rankFrom !== undefined && w.rankTo !== undefined) {
                        return rank >= w.rankFrom && rank <= w.rankTo;
                    }
                    return w.rank === rank;
                });
                coinsToAward = winnerRule?.coins || 0;
            }
            else {
                if (rank === 1)
                    coinsToAward = Math.floor(prizePool * 0.40);
                else if (rank === 2)
                    coinsToAward = Math.floor(prizePool * 0.25);
                else if (rank === 3)
                    coinsToAward = Math.floor(prizePool * 0.15);
                else if (rank <= 10)
                    coinsToAward = Math.floor(prizePool * 0.20 / 7);
            }
            if (coinsToAward > 0) {
                await (0, coinService_1.creditCoins)(userId, coinsToAward, client_1.TransactionType.EARN_IPL_WIN, contest.id, `IPL Contest Win - Rank #${rank} - ${contest.name}`);
                await database_1.prisma.iplContestEntry.updateMany({
                    where: { contestId: contest.id, userId },
                    data: { rank, coinsWon: coinsToAward, totalPoints: userScores[userId] ?? 0 },
                });
                totalCoinsDistributed += coinsToAward;
                totalWinners++;
            }
            else {
                await database_1.prisma.iplContestEntry.updateMany({
                    where: { contestId: contest.id, userId },
                    data: { rank, totalPoints: userScores[userId] ?? 0 },
                });
            }
        }
        await database_1.prisma.iplContest.update({
            where: { id: contest.id },
            data: { status: 'completed' },
        });
    }
    await database_1.prisma.iplMatch.update({
        where: { id: matchId },
        data: { contestStatus: 'completed' },
    });
    // Step 4: Send push notifications to all participants
    try {
        const match = await database_1.prisma.iplMatch.findUnique({ where: { id: matchId } });
        const allParticipantIds = [...new Set(contests.flatMap(c => c.entries.map(e => e.userId)))];
        if (allParticipantIds.length > 0 && match) {
            // Collect all rankings across contests for notification text
            const allRankings = {};
            for (const contest of contests) {
                const userIds = contest.entries.map(e => e.userId);
                const predictions = await database_1.prisma.iplPrediction.findMany({
                    where: { matchId, userId: { in: userIds } },
                });
                const updatedQuestions = await database_1.prisma.iplQuestion.findMany({ where: { matchId } });
                const scores = {};
                for (const e of contest.entries)
                    scores[e.userId] = 0;
                for (const pred of predictions) {
                    const q = updatedQuestions.find(x => x.id === pred.questionId);
                    if (q?.correctAnswer && pred.answer === q.correctAnswer) {
                        scores[pred.userId] = (scores[pred.userId] ?? 0) + q.points;
                    }
                }
                Object.entries(scores)
                    .sort(([, a], [, b]) => b - a)
                    .forEach(([uid], i) => { allRankings[uid] = Math.min(allRankings[uid] ?? 999, i + 1); });
            }
            await database_1.prisma.notification.createMany({
                data: allParticipantIds.map(userId => {
                    const rank = allRankings[userId];
                    const isWinner = rank !== undefined && rank <= 10;
                    return {
                        userId,
                        title: `🏏 ${match.team1} vs ${match.team2} Results!`,
                        body: isWinner
                            ? `🎉 You won! Rank #${rank}. Coins credited to your account!`
                            : `${winner} won the match! Check your results in the app.`,
                        type: 'IPL_RESULT',
                    };
                }),
                skipDuplicates: true,
            });
            logger_1.logger.info(`processIPLResults: sent ${allParticipantIds.length} result notifications`);
        }
    }
    catch (notifErr) {
        logger_1.logger.warn('Notification sending failed:', notifErr);
    }
    logger_1.logger.info(`processIPLResults: match ${matchId}, ${contests.length} contests, ${totalWinners} winners, ${totalCoinsDistributed} coins`);
    (0, response_1.success)(res, {
        matchId,
        winner,
        totalContests: contests.length,
        totalWinners,
        totalCoinsDistributed,
    }, 'Results processed! Coins credited to winners.');
}
// ─── Save edited questions for a match ────────────────────────────────────────
async function saveEditedQuestions(req, res) {
    const { matchId } = req.params;
    const { questions } = req.body;
    if (!questions || !Array.isArray(questions)) {
        (0, response_1.error)(res, 'Questions array required', 400);
        return;
    }
    let saved = 0;
    for (const q of questions) {
        if (q.id) {
            await database_1.prisma.iplQuestion.update({
                where: { id: q.id },
                data: {
                    question: q.question,
                    options: q.options,
                    correctAnswer: q.correctAnswer || '',
                    points: q.points ?? 100,
                    status: 'active',
                    ...(q.category && { category: q.category }),
                    ...(q.difficulty && { difficulty: q.difficulty }),
                },
            }).catch(() => { });
        }
        else {
            await database_1.prisma.iplQuestion.create({
                data: {
                    matchId,
                    question: q.question,
                    options: q.options,
                    correctAnswer: q.correctAnswer || '',
                    points: q.points ?? 100,
                    category: q.category ?? 'prediction',
                    difficulty: q.difficulty ?? 'medium',
                    status: 'active',
                    isAutoGenerated: false,
                },
            }).catch(() => { });
        }
        saved++;
    }
    (0, response_1.success)(res, { saved }, `${saved} questions saved!`);
}
// ─── Generate AI result report (auto-detect correct answers) ──────────────────
async function generateResultReport(req, res) {
    try {
        const { matchId, winner, team1Score, team2Score, manOfMatch, questions } = req.body;
        const match = await database_1.prisma.iplMatch.findUnique({ where: { id: matchId } });
        if (!match) {
            (0, response_1.error)(res, 'Match not found', 404);
            return;
        }
        // Attempt Claude AI to auto-detect correct answers
        let autoAnswers = [];
        try {
            const Anthropic = require('@anthropic-ai/sdk').default;
            const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const response = await claude.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 1000,
                messages: [{
                        role: 'user',
                        content: `Match Result:
Winner: ${winner}
${match.team1} Score: ${team1Score || 'N/A'}
${match.team2} Score: ${team2Score || 'N/A'}
Man of Match: ${manOfMatch || 'Unknown'}

For each question below, determine the correct answer based on the match result.

Questions:
${JSON.stringify((questions || []).map(q => ({ id: q.id, question: q.question, options: q.options })))}

Return ONLY a JSON array with no extra text:
[{"id": "question_id", "correctAnswer": "exact option text or empty string if unknown"}]

Rules:
- correctAnswer MUST exactly match one of the options, or be empty string
- If about winner/winning team: ${winner}
- If about man of the match: ${manOfMatch || ''}
- If about scores: ${team1Score} vs ${team2Score}
- If uncertain, return empty string`,
                    }],
            });
            const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                autoAnswers = JSON.parse(jsonMatch[0]);
            }
        }
        catch (aiErr) {
            logger_1.logger.warn('AI report generation failed, using keyword fallback:', aiErr);
        }
        // Apply AI answers + keyword fallback
        const updatedQuestions = (questions || []).map(q => {
            const autoAnswer = autoAnswers.find(a => a.id === q.id);
            if (autoAnswer?.correctAnswer)
                return { ...q, correctAnswer: autoAnswer.correctAnswer };
            // Keyword fallback
            const qLower = q.question.toLowerCase();
            if (qLower.includes('who will win') || qLower.includes('winner') || qLower.includes('which team')) {
                const match = q.options?.find(o => o.toLowerCase().includes(winner?.toLowerCase()));
                if (match)
                    return { ...q, correctAnswer: match };
            }
            if ((qLower.includes('man of') || qLower.includes('player of')) && manOfMatch) {
                const firstName = manOfMatch.toLowerCase().split(' ')[0];
                const match = q.options?.find(o => o.toLowerCase().includes(firstName));
                if (match)
                    return { ...q, correctAnswer: match };
            }
            return q;
        });
        (0, response_1.success)(res, {
            winner, team1Score, team2Score, manOfMatch,
            updatedQuestions,
            autoAnswers,
            autoAnsweredCount: updatedQuestions.filter(q => q.correctAnswer).length,
        });
    }
    catch (err) {
        logger_1.logger.error('generateResultReport error:', err);
        (0, response_1.error)(res, 'Failed to generate report', 500);
    }
}
// ─── Fetch today's IPL matches from Cricbuzz and upsert into DB ───────────────
async function fetchTodayMatches(req, res) {
    const matches = await (0, cricApiService_1.getTodayIPLMatches)();
    if (matches.length === 0) {
        (0, response_1.success)(res, [], 'No IPL matches today');
        return;
    }
    const savedMatches = [];
    for (const match of matches) {
        if (!match.team1 || !match.team2)
            continue;
        const cricApiId = match.id?.toString();
        const existing = cricApiId
            ? await database_1.prisma.iplMatch.findFirst({ where: { cricApiId } })
            : null;
        if (existing) {
            savedMatches.push(existing);
        }
        else {
            const saved = await database_1.prisma.iplMatch.create({
                data: {
                    team1: match.team1,
                    team2: match.team2,
                    matchDate: match.startTime ? new Date(parseInt(match.startTime)) : new Date(),
                    venue: match.venue || match.city || 'TBD',
                    status: 'upcoming',
                    cricApiId: cricApiId ?? null,
                    matchNumber: savedMatches.length + 1,
                },
            });
            savedMatches.push(saved);
        }
    }
    logger_1.logger.info(`fetchTodayMatches: ${savedMatches.length} IPL matches upserted`);
    (0, response_1.success)(res, savedMatches, `${savedMatches.length} IPL matches fetched`);
}
// ─── Generate AI questions for a match ────────────────────────────────────────
async function generateIPLQuestions(req, res) {
    const { matchId } = req.body;
    if (!matchId) {
        (0, response_1.error)(res, 'matchId required', 400);
        return;
    }
    const match = await database_1.prisma.iplMatch.findUnique({ where: { id: matchId } });
    if (!match) {
        (0, response_1.error)(res, 'Match not found', 404);
        return;
    }
    const { generateIPLQuestions: generateQs } = await Promise.resolve().then(() => __importStar(require('../services/claudeAiService')));
    const questions = await generateQs({
        team1: match.team1, team2: match.team2,
        date: match.matchDate.toDateString(), venue: match.venue ?? 'TBD',
    });
    // Delete existing auto-generated questions to avoid duplicates on re-generation
    await database_1.prisma.iplQuestion.deleteMany({
        where: { matchId: match.id, isAutoGenerated: true },
    });
    const created = await Promise.all(questions.map(q => database_1.prisma.iplQuestion.create({
        data: {
            matchId: match.id, question: q.question, options: q.options,
            correctAnswer: q.correctAnswer ?? '', points: q.points ?? 100,
            category: q.category ?? 'prediction', difficulty: q.difficulty ?? 'medium',
            status: 'active', isAutoGenerated: true, generatedBy: 'claude-ai', approved: false,
        },
    })));
    (0, response_1.success)(res, created, `${created.length} questions generated!`);
}
// ─── IPL analytics ────────────────────────────────────────────────────────────
async function deleteAdminIPLMatch(req, res) {
    const id = req.params.id;
    // Cascade delete in order: entries → predictions (via questions) → contests → questions → match
    await database_1.prisma.iplContestEntry.deleteMany({ where: { contest: { matchId: id } } });
    await database_1.prisma.iplPrediction.deleteMany({ where: { question: { matchId: id } } });
    await database_1.prisma.iplContest.deleteMany({ where: { matchId: id } });
    await database_1.prisma.iplQuestion.deleteMany({ where: { matchId: id } });
    await database_1.prisma.iplMatch.delete({ where: { id } });
    (0, response_1.success)(res, { message: 'Match deleted successfully' });
}
async function getIPLAnalytics(_req, res) {
    const [matches, totalContestEntries, totalCoinsDistributed] = await Promise.all([
        database_1.prisma.iplMatch.findMany({
            include: {
                contests: { include: { _count: { select: { entries: true } } } },
                _count: { select: { predictions: true } },
            },
            orderBy: { matchDate: 'asc' },
        }),
        database_1.prisma.iplContestEntry.count(),
        database_1.prisma.transaction.aggregate({
            where: { type: 'EARN_IPL_WIN' },
            _sum: { amount: true },
        }),
    ]);
    const matchStats = matches.map(m => ({
        id: m.id,
        team1: m.team1,
        team2: m.team2,
        matchDate: m.matchDate,
        status: m.status,
        predictions: m._count.predictions,
        totalContests: m.contests.length,
        totalEntries: m.contests.reduce((sum, c) => sum + c._count.entries, 0),
    }));
    (0, response_1.success)(res, {
        totalMatches: matches.length,
        totalContestEntries,
        totalCoinsDistributed: totalCoinsDistributed._sum.amount ?? 0,
        matches: matchStats,
    });
}
// ─── Fetch / sync IPL 2026 schedule ──────────────────────────────────────────
async function fetchIPLSchedule(req, res) {
    try {
        const ipl2026Matches = [
            { matchNumber: 1, team1: 'KKR', team2: 'RCB', matchDate: new Date('2026-03-22T14:00:00Z'), venue: 'Eden Gardens, Kolkata' },
            { matchNumber: 2, team1: 'SRH', team2: 'RR', matchDate: new Date('2026-03-23T10:00:00Z'), venue: 'Rajiv Gandhi Intl. Stadium, Hyderabad' },
            { matchNumber: 3, team1: 'DC', team2: 'LSG', matchDate: new Date('2026-03-23T14:00:00Z'), venue: 'Arun Jaitley Stadium, Delhi' },
            { matchNumber: 4, team1: 'GT', team2: 'PBKS', matchDate: new Date('2026-03-24T14:00:00Z'), venue: 'Narendra Modi Stadium, Ahmedabad' },
            { matchNumber: 5, team1: 'MI', team2: 'CSK', matchDate: new Date('2026-03-25T14:00:00Z'), venue: 'Wankhede Stadium, Mumbai' },
            { matchNumber: 6, team1: 'RR', team2: 'KKR', matchDate: new Date('2026-03-26T14:00:00Z'), venue: 'Sawai Mansingh Stadium, Jaipur' },
            { matchNumber: 7, team1: 'LSG', team2: 'SRH', matchDate: new Date('2026-03-27T14:00:00Z'), venue: 'BRSABV Ekana Cricket Stadium, Lucknow' },
            { matchNumber: 8, team1: 'RCB', team2: 'DC', matchDate: new Date('2026-03-28T14:00:00Z'), venue: 'M Chinnaswamy Stadium, Bengaluru' },
            { matchNumber: 9, team1: 'PBKS', team2: 'MI', matchDate: new Date('2026-03-29T10:00:00Z'), venue: 'Maharaja Yadavindra Singh Cricket Stadium, Mullanpur' },
            { matchNumber: 10, team1: 'CSK', team2: 'GT', matchDate: new Date('2026-03-29T14:00:00Z'), venue: 'MA Chidambaram Stadium, Chennai' },
            { matchNumber: 11, team1: 'KKR', team2: 'SRH', matchDate: new Date('2026-03-30T14:00:00Z'), venue: 'Eden Gardens, Kolkata' },
            { matchNumber: 12, team1: 'DC', team2: 'RR', matchDate: new Date('2026-03-31T14:00:00Z'), venue: 'Arun Jaitley Stadium, Delhi' },
            { matchNumber: 13, team1: 'RCB', team2: 'LSG', matchDate: new Date('2026-04-01T14:00:00Z'), venue: 'M Chinnaswamy Stadium, Bengaluru' },
            { matchNumber: 14, team1: 'MI', team2: 'GT', matchDate: new Date('2026-04-02T14:00:00Z'), venue: 'Wankhede Stadium, Mumbai' },
            { matchNumber: 15, team1: 'PBKS', team2: 'KKR', matchDate: new Date('2026-04-03T14:00:00Z'), venue: 'Maharaja Yadavindra Singh Cricket Stadium, Mullanpur' },
            { matchNumber: 16, team1: 'CSK', team2: 'SRH', matchDate: new Date('2026-04-04T10:00:00Z'), venue: 'MA Chidambaram Stadium, Chennai' },
            { matchNumber: 17, team1: 'GT', team2: 'DC', matchDate: new Date('2026-04-04T14:00:00Z'), venue: 'Narendra Modi Stadium, Ahmedabad' },
            { matchNumber: 18, team1: 'RR', team2: 'MI', matchDate: new Date('2026-04-05T14:00:00Z'), venue: 'Sawai Mansingh Stadium, Jaipur' },
            { matchNumber: 19, team1: 'LSG', team2: 'PBKS', matchDate: new Date('2026-04-06T14:00:00Z'), venue: 'BRSABV Ekana Cricket Stadium, Lucknow' },
            { matchNumber: 20, team1: 'KKR', team2: 'CSK', matchDate: new Date('2026-04-07T14:00:00Z'), venue: 'Eden Gardens, Kolkata' },
        ];
        let created = 0;
        let updated = 0;
        for (const m of ipl2026Matches) {
            const cricApiId = `ipl2026-match-${m.matchNumber}`;
            const existing = await database_1.prisma.iplMatch.findUnique({ where: { cricApiId } });
            if (existing) {
                await database_1.prisma.iplMatch.update({
                    where: { cricApiId },
                    data: {
                        team1: m.team1, team2: m.team2,
                        matchDate: m.matchDate,
                        matchStartTime: m.matchDate,
                        venue: m.venue,
                        matchNumber: m.matchNumber,
                    },
                });
                updated++;
            }
            else {
                await database_1.prisma.iplMatch.create({
                    data: {
                        cricApiId,
                        matchNumber: m.matchNumber,
                        team1: m.team1,
                        team2: m.team2,
                        matchDate: m.matchDate,
                        matchStartTime: m.matchDate,
                        venue: m.venue,
                        status: 'upcoming',
                    },
                });
                created++;
            }
        }
        (0, response_1.success)(res, { created, updated, total: ipl2026Matches.length }, `${created} created, ${updated} updated`);
    }
    catch (err) {
        logger_1.logger.error('fetchIPLSchedule error:', err);
        (0, response_1.error)(res, 'Failed to fetch schedule', 500);
    }
}
