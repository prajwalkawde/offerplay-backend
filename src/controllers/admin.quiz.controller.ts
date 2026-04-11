import { Request, Response } from 'express';
import { success, error, paginated } from '../utils/response';
import { logger } from '../utils/logger';
import { prisma } from '../config/database';
import { generateQuestions } from '../services/quizAI.service';

// ─── getQuestions ─────────────────────────────────────────────────────────────

export async function adminGetQuestions(req: Request, res: Response): Promise<void> {
  try {
    const {
      page = '1',
      limit = '20',
      sport,
      difficulty,
      language,
      isActive,
      isAiGenerated,
      search,
    } = req.query as Record<string, string | undefined>;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const where: Record<string, unknown> = {};
    if (sport) where.sport = sport;
    if (difficulty) where.difficulty = difficulty;
    if (language) where.language = language;
    if (isActive !== undefined) where.isActive = isActive === 'true';
    if (isAiGenerated !== undefined) where.isAiGenerated = isAiGenerated === 'true';
    if (search) {
      where.question = { contains: search, mode: 'insensitive' };
    }

    const [questions, total] = await Promise.all([
      prisma.sportsQuestion.findMany({
        where,
        orderBy: { id: 'desc' },
        skip,
        take: limitNum,
      }),
      prisma.sportsQuestion.count({ where }),
    ]);

    paginated(res, questions, total, pageNum, limitNum);
  } catch (err) {
    logger.error('adminGetQuestions error', { err });
    error(res, 'Failed to get questions', 500);
  }
}

// ─── createQuestion ───────────────────────────────────────────────────────────

export async function adminCreateQuestion(req: Request, res: Response): Promise<void> {
  try {
    const { question, optionA, optionB, optionC, optionD, correctOption, sport, difficulty, language, explanation } =
      req.body as {
        question: string;
        optionA: string;
        optionB: string;
        optionC: string;
        optionD: string;
        correctOption: string;
        sport: string;
        difficulty: string;
        language?: string;
        explanation?: string;
      };

    if (!question || !optionA || !optionB || !optionC || !optionD || !correctOption || !sport || !difficulty) {
      error(res, 'All question fields are required', 400);
      return;
    }

    const created = await prisma.sportsQuestion.create({
      data: { question, optionA, optionB, optionC, optionD, correctOption: correctOption.toUpperCase(), sport, difficulty, language: language ?? 'en', explanation: explanation ?? null },
    });

    success(res, created, 'Question created', 201);
  } catch (err) {
    logger.error('adminCreateQuestion error', { err });
    error(res, 'Failed to create question', 500);
  }
}

// ─── updateQuestion ───────────────────────────────────────────────────────────

export async function adminUpdateQuestion(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { error(res, 'Invalid question id', 400); return; }

    const { question, optionA, optionB, optionC, optionD, correctOption, sport, difficulty, language, explanation, isActive } =
      req.body as Partial<{
        question: string;
        optionA: string;
        optionB: string;
        optionC: string;
        optionD: string;
        correctOption: string;
        sport: string;
        difficulty: string;
        language: string;
        explanation: string;
        isActive: boolean;
      }>;

    const updated = await prisma.sportsQuestion.update({
      where: { id },
      data: {
        ...(question !== undefined && { question }),
        ...(optionA !== undefined && { optionA }),
        ...(optionB !== undefined && { optionB }),
        ...(optionC !== undefined && { optionC }),
        ...(optionD !== undefined && { optionD }),
        ...(correctOption !== undefined && { correctOption: correctOption.toUpperCase() }),
        ...(sport !== undefined && { sport }),
        ...(difficulty !== undefined && { difficulty }),
        ...(language !== undefined && { language }),
        ...(explanation !== undefined && { explanation }),
        ...(isActive !== undefined && { isActive }),
      },
    });

    success(res, updated);
  } catch (err) {
    logger.error('adminUpdateQuestion error', { err });
    error(res, 'Failed to update question', 500);
  }
}

// ─── deleteQuestion (soft) ────────────────────────────────────────────────────

export async function adminDeleteQuestion(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { error(res, 'Invalid question id', 400); return; }

    await prisma.sportsQuestion.update({
      where: { id },
      data: { isActive: false },
    });

    success(res, null, 'Question deactivated');
  } catch (err) {
    logger.error('adminDeleteQuestion error', { err });
    error(res, 'Failed to delete question', 500);
  }
}

// ─── generateQuestions (AI) ───────────────────────────────────────────────────

export async function adminGenerateQuestions(req: Request, res: Response): Promise<void> {
  try {
    const { count = 10, sport = 'ipl', difficulty = 'easy' } = req.body as {
      count?: number;
      sport?: string;
      difficulty?: string;
    };

    await generateQuestions(Number(count), sport, difficulty);
    success(res, null, `${count} AI questions generated for ${sport} (${difficulty})`);
  } catch (err) {
    logger.error('adminGenerateQuestions error', { err });
    error(res, 'Failed to generate AI questions', 500);
  }
}

// ─── getSettings ──────────────────────────────────────────────────────────────

export async function adminGetSettings(req: Request, res: Response): Promise<void> {
  try {
    const settings = await prisma.quizSettings.upsert({
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
    success(res, settings);
  } catch (err) {
    logger.error('adminGetSettings error', { err });
    error(res, 'Failed to get settings', 500);
  }
}

// ─── updateSettings ───────────────────────────────────────────────────────────

export async function adminUpdateSettings(req: Request, res: Response): Promise<void> {
  try {
    const {
      ticketPerStage,
      bonusTicketEnabled,
      maxHintsPerStage,
      dailyTicketLimit,
      cooldownMinutes,
      sessionExpiryMinutes,
      minAnswerTimeMs,
      minSessionTimeMs,
      questionsPerStage,
      aiGenerationEnabled,
    } = req.body as Partial<{
      ticketPerStage: number;
      bonusTicketEnabled: boolean;
      maxHintsPerStage: number;
      dailyTicketLimit: number;
      cooldownMinutes: number;
      sessionExpiryMinutes: number;
      minAnswerTimeMs: number;
      minSessionTimeMs: number;
      questionsPerStage: number;
      aiGenerationEnabled: boolean;
    }>;

    const updated = await prisma.quizSettings.update({
      where: { id: 1 },
      data: {
        ...(ticketPerStage !== undefined && { ticketPerStage }),
        ...(bonusTicketEnabled !== undefined && { bonusTicketEnabled }),
        ...(maxHintsPerStage !== undefined && { maxHintsPerStage }),
        ...(dailyTicketLimit !== undefined && { dailyTicketLimit }),
        ...(cooldownMinutes !== undefined && { cooldownMinutes }),
        ...(sessionExpiryMinutes !== undefined && { sessionExpiryMinutes }),
        ...(minAnswerTimeMs !== undefined && { minAnswerTimeMs }),
        ...(minSessionTimeMs !== undefined && { minSessionTimeMs }),
        ...(questionsPerStage !== undefined && { questionsPerStage }),
        ...(aiGenerationEnabled !== undefined && { aiGenerationEnabled }),
      },
    });

    success(res, updated);
  } catch (err) {
    logger.error('adminUpdateSettings error', { err });
    error(res, 'Failed to update settings', 500);
  }
}

// ─── getAnalytics ─────────────────────────────────────────────────────────────

export async function adminGetAnalytics(req: Request, res: Response): Promise<void> {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [
      totalStages,
      completedStages,
      flaggedStages,
      ticketAgg,
      correctAgg,
      hintAgg,
      sportBreakdown,
      recentStages,
    ] = await Promise.all([
      prisma.quizStage.count(),
      prisma.quizStage.count({ where: { status: 'completed' } }),
      prisma.quizStage.count({ where: { isFlagged: true } }),
      prisma.quizStage.aggregate({ _sum: { ticketsAwarded: true } }),
      prisma.quizStage.aggregate({ _avg: { correctAnswers: true }, where: { status: 'completed' } }),
      prisma.quizStage.aggregate({ _avg: { hintsUsed: true }, where: { status: 'completed' } }),
      prisma.sportsQuestion.groupBy({
        by: ['sport'],
        _count: { _all: true },
        where: { isActive: true },
      }),
      prisma.quizStage.findMany({
        where: { createdAt: { gte: thirtyDaysAgo } },
        select: { createdAt: true, ticketsAwarded: true, status: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    // Build per-day stats
    const stagesPerDay: Record<string, number> = {};
    const ticketsPerDay: Record<string, number> = {};

    for (const stage of recentStages) {
      const day = stage.createdAt.toISOString().slice(0, 10);
      stagesPerDay[day] = (stagesPerDay[day] ?? 0) + 1;
      if (stage.status === 'completed') {
        ticketsPerDay[day] = (ticketsPerDay[day] ?? 0) + (stage.ticketsAwarded ?? 0);
      }
    }

    const avgScore = Math.round((correctAgg._avg.correctAnswers ?? 0) * 100) / 100;
    const avgHints = Math.round((hintAgg._avg.hintsUsed ?? 0) * 100) / 100;
    const totalTickets = ticketAgg._sum.ticketsAwarded ?? 0;
    const hintUsageRate = completedStages > 0 ? Math.round((avgHints / 3) * 100) / 100 : 0;

    success(res, {
      totalStages,
      completedStages,
      flaggedStages,
      totalTicketsAwarded: totalTickets,
      avgScore,
      avgHints,
      hintUsageRate,
      sportBreakdown: sportBreakdown.map((s) => ({ sport: s.sport, count: s._count._all })),
      stagesPerDay,
      ticketsPerDay,
    });
  } catch (err) {
    logger.error('adminGetAnalytics error', { err });
    error(res, 'Failed to get analytics', 500);
  }
}
