/**
 * quiz.service.ts
 *
 * Core Sports Quiz game logic.
 * Handles stage lifecycle: start → questions → hints → claim → bonus.
 */

import crypto from 'crypto';
import { prisma } from '../config/database';
import { creditTickets } from './ticket.service';
import { logger } from '../utils/logger';

const GAME_SECRET = process.env.GAME_SECRET ?? 'offerplay_quiz_secret';

// ─── Types ────────────────────────────────────────────────────────────────────

interface StartStageResult {
  stageId: string;
  stageToken: string;
  dailyTicketsEarned: number;
  dailyTicketLimit: number;
  remainingDailyTickets: number;
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
  ticketsAwarded: number;
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
  dailyTicketsEarned: number;
  dailyTicketLimit: number;
  remainingDailyTickets: number;
  cooldownRemainingMinutes: number;
  nextStageAvailableAt: Date | null;
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

// ─── startStage ───────────────────────────────────────────────────────────────

export async function startStage(uid: string, _deviceId?: string): Promise<StartStageResult> {
  const settings = await getSettings();
  const now = new Date();

  // Daily ticket limit check
  const todayStart = startOfTodayUTC();
  const dailyAgg = await prisma.quizStage.aggregate({
    where: { uid, status: 'completed', completedAt: { gte: todayStart } },
    _sum: { ticketsAwarded: true },
  });
  const dailyTicketsEarned = dailyAgg._sum.ticketsAwarded ?? 0;

  if (dailyTicketsEarned >= settings.dailyTicketLimit) {
    throw Object.assign(new Error('Daily ticket limit reached'), { code: 'DAILY_LIMIT' });
  }

  // Cooldown check
  const lastCompleted = await prisma.quizStage.findFirst({
    where: { uid, status: 'completed' },
    orderBy: { completedAt: 'desc' },
    select: { completedAt: true },
  });

  if (lastCompleted?.completedAt) {
    const cooldownMs = settings.cooldownMinutes * 60 * 1000;
    const elapsed = now.getTime() - lastCompleted.completedAt.getTime();
    if (elapsed < cooldownMs) {
      const remainingMinutes = Math.ceil((cooldownMs - elapsed) / 60000);
      throw Object.assign(
        new Error(`Cooldown active. Try again in ${remainingMinutes} minutes`),
        { code: 'COOLDOWN', remainingMinutes }
      );
    }
  }

  // No active stage check
  const activeStage = await prisma.quizStage.findFirst({
    where: { uid, status: 'started' },
  });
  if (activeStage) {
    throw Object.assign(new Error('You already have an active quiz stage'), { code: 'ACTIVE_STAGE' });
  }

  // Create stage
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
    dailyTicketsEarned,
    dailyTicketLimit: settings.dailyTicketLimit,
    remainingDailyTickets: settings.dailyTicketLimit - dailyTicketsEarned,
    cooldownMinutes: settings.cooldownMinutes,
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

  // Award ticket
  const newBalance = await creditTickets(
    uid,
    1,
    'earned_game',
    `Sports Quiz - ${correctAnswers}/${answers.length} correct`,
    stageId
  );

  // Update stage with final data
  await prisma.quizStage.update({
    where: { stageId },
    data: {
      correctAnswers,
      hintsUsed: stage.hintsUsed,
      ticketsAwarded: 1,
      sessionDurationMs,
      isFlagged,
      flagReason,
    },
  });

  logger.info('Quiz stage claimed', { uid, stageId, correctAnswers, isFlagged, newBalance });

  const nextStageAvailableAt = new Date(now.getTime() + settings.cooldownMinutes * 60 * 1000);

  return {
    correctAnswers,
    totalQuestions: answers.length,
    ticketsAwarded: 1,
    isFlagged,
    flagReason,
    nextStageAvailableAt,
    answers: stageAnswers.map((a) => {
      const q = questionMap.get(a.questionId);
      return {
        questionId: a.questionId,
        selectedOption: a.selectedOption,
        isCorrect: a.isCorrect,
        correctOption: q?.correctOption ?? '',
        explanation: q?.explanation ?? null,
      };
    }),
  };
}

// ─── claimBonusTicket ─────────────────────────────────────────────────────────

export async function claimBonusTicket(uid: string, stageId: string): Promise<{ ticketsAwarded: number; newBalance: number }> {
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
  const todayStart = startOfTodayUTC();
  const dailyAgg = await prisma.quizStage.aggregate({
    where: { uid, status: 'completed', completedAt: { gte: todayStart } },
    _sum: { ticketsAwarded: true },
  });
  const dailyTicketsEarned = (dailyAgg._sum.ticketsAwarded ?? 0) + (stage.bonusTicketClaimed ? 0 : 0);

  if (dailyTicketsEarned >= settings.dailyTicketLimit) {
    throw Object.assign(new Error('Daily ticket limit reached'), { code: 'DAILY_LIMIT' });
  }

  await prisma.quizStage.update({
    where: { stageId },
    data: { bonusTicketClaimed: true },
  });

  const newBalance = await creditTickets(uid, 1, 'earned_game', 'Sports Quiz Bonus Ticket', stageId);

  logger.info('Bonus ticket claimed', { uid, stageId, newBalance });

  return { ticketsAwarded: 1, newBalance };
}

// ─── getStatus ────────────────────────────────────────────────────────────────

export async function getStatus(uid: string): Promise<StatusResult> {
  const settings = await getSettings();
  const now = new Date();
  const todayStart = startOfTodayUTC();

  const [dailyAgg, lastCompleted] = await Promise.all([
    prisma.quizStage.aggregate({
      where: { uid, status: 'completed', completedAt: { gte: todayStart } },
      _sum: { ticketsAwarded: true },
    }),
    prisma.quizStage.findFirst({
      where: { uid, status: 'completed' },
      orderBy: { completedAt: 'desc' },
      select: { completedAt: true },
    }),
  ]);

  const dailyTicketsEarned = dailyAgg._sum.ticketsAwarded ?? 0;
  const remainingDailyTickets = Math.max(0, settings.dailyTicketLimit - dailyTicketsEarned);
  const dailyLimitReached = dailyTicketsEarned >= settings.dailyTicketLimit;

  let cooldownRemainingMinutes = 0;
  let nextStageAvailableAt: Date | null = null;

  if (lastCompleted?.completedAt) {
    const cooldownMs = settings.cooldownMinutes * 60 * 1000;
    const elapsed = now.getTime() - lastCompleted.completedAt.getTime();
    if (elapsed < cooldownMs) {
      cooldownRemainingMinutes = Math.ceil((cooldownMs - elapsed) / 60000);
      nextStageAvailableAt = new Date(lastCompleted.completedAt.getTime() + cooldownMs);
    }
  }

  const canPlay = !dailyLimitReached && cooldownRemainingMinutes === 0;

  return {
    canPlay,
    dailyTicketsEarned,
    dailyTicketLimit: settings.dailyTicketLimit,
    remainingDailyTickets,
    cooldownRemainingMinutes,
    nextStageAvailableAt,
  };
}
