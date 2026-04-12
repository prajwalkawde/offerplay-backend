/**
 * quiz.service.ts
 *
 * Core Sports Quiz game logic.
 * Handles stage lifecycle: start → questions → hints → claim → bonus.
 */

import crypto from 'crypto';
import { prisma } from '../config/database';
import { creditGems } from './gems.service';
import { logger } from '../utils/logger';

const GAME_SECRET = process.env.GAME_SECRET ?? 'offerplay_quiz_secret';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StartStageResult {
  stageId: string;
  stageToken: string;
  dailyGemsEarned: number;
  dailyGemsLimit: number;
  remainingDailyGems: number;
  cooldownMinutes: number;
  hintsPerStage: number;
}

interface QuestionForClient {
  id: number;
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  sport: string;
  difficulty: string;
}

interface HintResult {
  correctOption: string;
  explanation: string | null;
  hintsRemaining: number;
}

interface AnswerInput {
  questionId: number;
  selectedOption: string;
  timeTakenMs: number;
  hintWatched: boolean;
}

interface ClaimResult {
  correctAnswers: number;
  totalQuestions: number;
  isPassed: boolean;
  passThreshold: number;
  gemsAwarded: number;
  isFlagged: boolean;
  flagReason: string | null;
  nextStageAvailableAt: Date;
  answers: Array<{
    questionId: number;
    selectedOption: string;
    isCorrect: boolean;
    correctOption: string;
    explanation: string | null;
  }>;
}

interface StatusResult {
  canPlay: boolean;
  dailyGemsEarned: number;
  dailyGemsLimit: number;
  remainingDailyGems: number;
  cooldownRemainingMinutes: number;
  nextStageAvailableAt: Date | null;
  showDailyLimitMessage: boolean;
  resetsAt: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStageToken(stageId: string, uid: string, ts: number): string {
  return crypto
    .createHmac('sha256', GAME_SECRET)
    .update(`${stageId}:${uid}:${ts}`)
    .digest('hex');
}

async function getSettings() {
  return prisma.quizSettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      ticketPerStage: 1,
      bonusTicketEnabled: true,
      maxHintsPerStage: 3,
      dailyTicketLimit: 20,
      cooldownMinutes: 30,
      sessionExpiryMinutes: 15,
      minAnswerTimeMs: 2000,
      minSessionTimeMs: 20000,
      questionsPerStage: 10,
      aiGenerationEnabled: true,
    },
  });
}

function startOfTodayUTC(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function tomorrowMidnightUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// ─── startStage ───────────────────────────────────────────────────────────────

export async function startStage(uid: string, _deviceId?: string): Promise<StartStageResult> {
  const settings = await getSettings();
  const now = new Date();

  // Daily ticket limit check — local midnight
  // ticketsAwarded counts base + extra tickets (claimExtraTicket increments the same field)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const dailyAgg = await prisma.quizStage.aggregate({
    where: { uid, ticketsAwarded: { gt: 0 }, completedAt: { gte: todayStart } },
    _sum: { ticketsAwarded: true },
  });
  const dailyTicketsEarned = dailyAgg._sum?.ticketsAwarded ?? 0;

  if (dailyTicketsEarned >= settings.dailyTicketLimit) {
    throw Object.assign(new Error('Daily ticket limit reached. Come back tomorrow!'), {
      code: 'DAILY_LIMIT_REACHED',
      resetsAt: tomorrowMidnightUTC(),
    });
  }

  // Active stage check — auto-expire if past expiry, resume if still valid
  const activeStage = await prisma.quizStage.findFirst({
    where: { uid, status: 'started' },
    select: { stageId: true, stageToken: true, expiresAt: true },
  });
  if (activeStage) {
    if (activeStage.expiresAt < now) {
      // Session has expired — auto-expire it and fall through to create a new one
      await prisma.quizStage.update({
        where: { stageId: activeStage.stageId },
        data: { status: 'expired' },
      });
      logger.info('Auto-expired stuck quiz stage', { uid, stageId: activeStage.stageId });
    } else {
      // Session is still valid — resume it instead of blocking the user
      logger.info('Resuming active quiz stage', { uid, stageId: activeStage.stageId });
      return {
        stageId: activeStage.stageId,
        stageToken: activeStage.stageToken,
        dailyGemsEarned: dailyTicketsEarned,
        dailyGemsLimit: settings.dailyTicketLimit,
        remainingDailyGems: settings.dailyTicketLimit - dailyTicketsEarned,
        cooldownMinutes: 0,
        hintsPerStage: settings.maxHintsPerStage,
      };
    }
  }

  // Create stage immediately — no cooldown between stages
  const stageId = crypto.randomUUID();
  const ts = now.getTime();
  const stageToken = makeStageToken(stageId, uid, ts);
  const expiresAt = new Date(now.getTime() + settings.sessionExpiryMinutes * 60 * 1000);

  await prisma.quizStage.create({
    data: {
      stageId,
      stageToken,
      uid,
      status: 'started',
      startedAt: now,
      expiresAt,
      totalQuestions: settings.questionsPerStage,
    },
  });

  logger.info('Quiz stage started', { uid, stageId });

  return {
    stageId,
    stageToken,
    dailyGemsEarned: dailyTicketsEarned,
    dailyGemsLimit: settings.dailyTicketLimit,
    remainingDailyGems: settings.dailyTicketLimit - dailyTicketsEarned,
    cooldownMinutes: 0,
    hintsPerStage: settings.maxHintsPerStage,
  };
}

// ─── getQuestions ─────────────────────────────────────────────────────────────

export async function getQuestions(uid: string, stageId: string): Promise<{ questions: QuestionForClient[] }> {
  const now = new Date();

  const stage = await prisma.quizStage.findUnique({ where: { stageId } });
  if (!stage) throw Object.assign(new Error('Stage not found'), { code: 'NOT_FOUND' });
  if (stage.uid !== uid) throw Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' });
  if (stage.status !== 'started') throw Object.assign(new Error('Stage is not active'), { code: 'INVALID_STATUS' });
  if (now > stage.expiresAt) throw Object.assign(new Error('Stage has expired'), { code: 'EXPIRED' });

  // Fetch question mix: 4 IPL, 2 cricket, 1 football, 1 kabaddi, 1 badminton, 1 other
  const distribution: Array<[string, number]> = [
    ['ipl', 4],
    ['cricket', 2],
    ['football', 1],
    ['kabaddi', 1],
    ['badminton', 1],
    ['other', 1],
  ];

  const fetchedIds: number[] = [];
  const fetchedQuestions: QuestionForClient[] = [];

  for (const [sport, needed] of distribution) {
    const pool = await prisma.sportsQuestion.findMany({
      where: { sport, isActive: true },
      orderBy: { usageCount: 'asc' },
      take: needed * 3,
      select: { id: true, question: true, optionA: true, optionB: true, optionC: true, optionD: true, sport: true, difficulty: true },
    });

    // Random subset from pool
    const shuffled = pool.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(needed, shuffled.length));
    fetchedIds.push(...selected.map((q) => q.id));
    fetchedQuestions.push(...selected);
  }

  // Increment usageCount
  if (fetchedIds.length > 0) {
    await prisma.sportsQuestion.updateMany({
      where: { id: { in: fetchedIds } },
      data: { usageCount: { increment: 1 } },
    });
  }

  return { questions: fetchedQuestions };
}

// ─── useHint ──────────────────────────────────────────────────────────────────

export async function useHint(uid: string, stageId: string, questionId: number): Promise<HintResult> {
  const now = new Date();
  const settings = await getSettings();

  const stage = await prisma.quizStage.findUnique({ where: { stageId } });
  if (!stage) throw Object.assign(new Error('Stage not found'), { code: 'NOT_FOUND' });
  if (stage.uid !== uid) throw Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' });
  if (stage.status !== 'started') throw Object.assign(new Error('Stage is not active'), { code: 'INVALID_STATUS' });
  if (now > stage.expiresAt) throw Object.assign(new Error('Stage has expired'), { code: 'EXPIRED' });

  if (stage.hintsUsed >= settings.maxHintsPerStage) {
    throw Object.assign(new Error('No hints remaining'), { code: 'NO_HINTS' });
  }

  const question = await prisma.sportsQuestion.findUnique({ where: { id: questionId } });
  if (!question) throw Object.assign(new Error('Question not found'), { code: 'NOT_FOUND' });

  const [updatedStage] = await Promise.all([
    prisma.quizStage.update({
      where: { stageId },
      data: { hintsUsed: { increment: 1 } },
      select: { hintsUsed: true },
    }),
    prisma.sportsQuestion.update({
      where: { id: questionId },
      data: { hintUsedCount: { increment: 1 } },
    }),
  ]);

  return {
    correctOption: question.correctOption,
    explanation: question.explanation,
    hintsRemaining: settings.maxHintsPerStage - updatedStage.hintsUsed,
  };
}

// ─── claimStage ───────────────────────────────────────────────────────────────

export async function claimStage(
  uid: string,
  stageId: string,
  stageToken: string,
  answers: AnswerInput[],
  sessionDurationMs: number
): Promise<ClaimResult> {
  const now = new Date();
  const settings = await getSettings();

  const stage = await prisma.quizStage.findUnique({ where: { stageId } });
  if (!stage) throw Object.assign(new Error('Stage not found'), { code: 'NOT_FOUND' });
  if (stage.uid !== uid) throw Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' });
  if (stage.status !== 'started') throw Object.assign(new Error('Stage already claimed or not active'), { code: 'INVALID_STATUS' });
  if (now > stage.expiresAt) throw Object.assign(new Error('Stage has expired'), { code: 'EXPIRED' });

  // Timing-safe token comparison
  const providedBuf = Buffer.from(stageToken.padEnd(64, '0').slice(0, 64));
  const storedBuf = Buffer.from(stage.stageToken.padEnd(64, '0').slice(0, 64));
  if (providedBuf.length !== storedBuf.length || !crypto.timingSafeEqual(providedBuf, storedBuf)) {
    throw Object.assign(new Error('Invalid stage token'), { code: 'INVALID_TOKEN' });
  }

  // IMMEDIATELY mark as completed to prevent double-claim
  await prisma.quizStage.update({
    where: { stageId },
    data: { status: 'completed', completedAt: now },
  });
  console.log('[Quiz] claimStage complete:', stageId, uid);

  // Bot detection: all answers within 200ms of each other
  if (answers.length > 1) {
    const times = answers.map((a) => a.timeTakenMs);
    const maxTime = Math.max(...times);
    const minTime = Math.min(...times);
    if (maxTime - minTime < 200) {
      await prisma.quizStage.update({
        where: { stageId },
        data: { status: 'flagged', isFlagged: true, flagReason: 'bot_uniform_timing' },
      });
      throw Object.assign(new Error('Suspicious activity detected'), { code: 'BOT_DETECTED' });
    }
  }

  // Server-side answer evaluation
  const questionIds = answers.map((a) => a.questionId);
  const questions = await prisma.sportsQuestion.findMany({
    where: { id: { in: questionIds } },
    select: { id: true, correctOption: true, explanation: true },
  });
  const questionMap = new Map(questions.map((q) => [q.id, q]));

  let correctAnswers = 0;
  const stageAnswers = answers.map((a) => {
    const q = questionMap.get(a.questionId);
    const isCorrectAnswer = q ? a.selectedOption.toUpperCase() === q.correctOption : false;
    if (isCorrectAnswer) correctAnswers++;
    return {
      stageId,
      questionId: a.questionId,
      selectedOption: a.selectedOption,
      isCorrect: isCorrectAnswer,
      timeTakenMs: a.timeTakenMs,
      hintWatched: a.hintWatched,
    };
  });

  // Create StageAnswer records
  await prisma.stageAnswer.createMany({ data: stageAnswers });

  // Update correctCount on questions answered correctly
  const correctQuestionIds = stageAnswers.filter((a) => a.isCorrect).map((a) => a.questionId);
  if (correctQuestionIds.length > 0) {
    await prisma.sportsQuestion.updateMany({
      where: { id: { in: correctQuestionIds } },
      data: { correctCount: { increment: 1 } },
    });
  }

  // Anti-abuse: session too short
  let isFlagged = false;
  let flagReason: string | null = null;
  if (sessionDurationMs < settings.minSessionTimeMs) {
    isFlagged = true;
    flagReason = 'session_too_short';
  }

  // Pass threshold: 50% correct required to earn ticket
  const totalQuestions = answers.length;
  const passThreshold = Math.ceil(totalQuestions / 2);
  const isPassed = correctAnswers >= passThreshold;

  // Award gem ONLY if passed and not flagged as bot
  let gemsAwarded = 0;
  if (isPassed && !isFlagged) {
    await creditGems(
      uid,
      1,
      'earned_game',
      `Sports Quiz Stage 🏆 - ${correctAnswers}/${totalQuestions} correct`,
      stageId
    );
    gemsAwarded = 1;
  }

  // Update stage with final data (ticketsAwarded field reused as gems counter)
  await prisma.quizStage.update({
    where: { stageId },
    data: {
      correctAnswers,
      hintsUsed: stage.hintsUsed,
      ticketsAwarded: gemsAwarded,
      sessionDurationMs,
      isFlagged,
      flagReason,
    },
  });

  logger.info('Quiz stage claimed', { uid, stageId, correctAnswers, isPassed, gemsAwarded, isFlagged });

  return {
    correctAnswers,
    totalQuestions,
    isPassed,
    passThreshold,
    gemsAwarded,
    isFlagged,
    flagReason,
    nextStageAvailableAt: now,
    answers: stageAnswers.map((a) => {
      const q = questionMap.get(a.questionId);
      return {
        questionId: a.questionId,
        selectedOption: a.selectedOption,
        isCorrect: a.isCorrect,
        correctOption: q?.correctOption ?? '',
        explanation: q?.explanation ?? null,
        hintWatched: a.hintWatched,
      };
    }),
  };
}

// ─── claimBonusTicket ─────────────────────────────────────────────────────────

export async function claimBonusTicket(uid: string, stageId: string, bonusAmount: number = 1): Promise<{ gemsAwarded: number; newBalance: number }> {
  const settings = await getSettings();

  if (!settings.bonusTicketEnabled) {
    throw Object.assign(new Error('Bonus tickets are disabled'), { code: 'DISABLED' });
  }

  const stage = await prisma.quizStage.findUnique({ where: { stageId } });
  if (!stage) throw Object.assign(new Error('Stage not found'), { code: 'NOT_FOUND' });
  if (stage.uid !== uid) throw Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' });
  if (stage.status !== 'completed') throw Object.assign(new Error('Stage not completed'), { code: 'INVALID_STATUS' });
  if (stage.bonusTicketClaimed) throw Object.assign(new Error('Bonus ticket already claimed'), { code: 'ALREADY_CLAIMED' });

  // Check daily limit
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const dailyAgg = await prisma.quizStage.aggregate({
    where: { uid, ticketsAwarded: { gt: 0 }, completedAt: { gte: todayStart } },
    _sum: { ticketsAwarded: true },
  });
  const dailyTicketsEarned = dailyAgg._sum?.ticketsAwarded ?? 0;
  const amount = Math.min(bonusAmount, Math.max(0, settings.dailyTicketLimit - dailyTicketsEarned));

  if (amount <= 0) {
    throw Object.assign(new Error('Daily ticket limit reached'), { code: 'DAILY_LIMIT' });
  }

  await prisma.quizStage.update({
    where: { stageId },
    data: { bonusTicketClaimed: true },
  });

  const label = bonusAmount >= 2 ? 'Sports Quiz Perfect Score Bonus 🏆🏆' : 'Sports Quiz Bonus Gems';
  const newBalance = await creditGems(uid, amount, 'earned_game', label, stageId);

  logger.info('Bonus gems claimed', { uid, stageId, amount, newBalance });

  return { gemsAwarded: amount, newBalance };
}

// ─── getStatus ────────────────────────────────────────────────────────────────

export async function getStatus(uid: string): Promise<StatusResult> {
  const settings = await getSettings();
  const todayStartLocal = new Date();
  todayStartLocal.setHours(0, 0, 0, 0);
  const [dailyAgg, activeStage] = await Promise.all([
    prisma.quizStage.aggregate({
      where: { uid, ticketsAwarded: { gt: 0 }, completedAt: { gte: todayStartLocal } },
      _sum: { ticketsAwarded: true },
    }),
    prisma.quizStage.findFirst({
      where: { uid, status: 'started' },
      select: { stageId: true },
    }),
  ]);

  const dailyTicketsEarned = dailyAgg._sum?.ticketsAwarded ?? 0;
  const remainingDailyTickets = Math.max(0, settings.dailyTicketLimit - dailyTicketsEarned);
  const dailyLimitReached = dailyTicketsEarned >= settings.dailyTicketLimit;

  // canPlay: no daily limit hit AND no active stage in progress
  const canPlay = !dailyLimitReached && !activeStage;
  const showDailyLimitMessage = dailyLimitReached;

  return {
    canPlay,
    dailyGemsEarned: dailyTicketsEarned,
    dailyGemsLimit: settings.dailyTicketLimit,
    remainingDailyGems: remainingDailyTickets,
    cooldownRemainingMinutes: 0,
    nextStageAvailableAt: null,
    showDailyLimitMessage,
    resetsAt: tomorrowMidnightUTC(),
  };
}

// ─── claimExtraTicket ─────────────────────────────────────────────────────────

export async function claimExtraTicket(
  uid: string,
  stageId: string
): Promise<{ gemsAwarded: number; newBalance: number }> {
  const stage = await prisma.quizStage.findUnique({ where: { stageId } });
  if (!stage) throw Object.assign(new Error('Stage not found'), { code: 'NOT_FOUND' });
  if (stage.uid !== uid) throw Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' });
  if (stage.status !== 'completed') throw Object.assign(new Error('Stage not completed'), { code: 'INVALID_STATUS' });
  if (stage.extraTicketClaimed) throw Object.assign(new Error('Extra ticket already claimed'), { code: 'ALREADY_CLAIMED' });

  // Daily limit check
  const settings = await getSettings();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const dailyAgg = await prisma.quizStage.aggregate({
    where: { uid, ticketsAwarded: { gt: 0 }, completedAt: { gte: todayStart } },
    _sum: { ticketsAwarded: true },
  });
  const dailyTicketsEarned = dailyAgg._sum?.ticketsAwarded ?? 0;
  if (dailyTicketsEarned >= settings.dailyTicketLimit) {
    throw Object.assign(new Error('Daily ticket limit reached'), { code: 'DAILY_LIMIT_REACHED' });
  }

  // Atomically mark claimed, increment ticketsAwarded, and award ticket
  // ticketsAwarded must be incremented so daily limit query counts this ticket
  const newBalance = await prisma.$transaction(async (tx) => {
    await tx.quizStage.update({
      where: { stageId },
      data: { extraTicketClaimed: true, ticketsAwarded: { increment: 1 } },
    });
    return creditGems(uid, 1, 'earned_game', 'Sports Quiz Extra Gem 📺', stageId, tx);
  });

  logger.info('Extra gem claimed', { uid, stageId, newBalance });
  return { gemsAwarded: 1, newBalance };
}
