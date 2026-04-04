import { Request, Response } from 'express';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import * as quizService from '../services/quiz.service';

// ─── startStage ───────────────────────────────────────────────────────────────

export async function startStage(req: Request, res: Response): Promise<void> {
  try {
    const uid = req.userId!;
    const { deviceId } = (req.body ?? {}) as { deviceId?: string };
    const result = await quizService.startStage(uid, deviceId);
    success(res, result, 'Quiz stage started');
  } catch (err: unknown) {
    const e = err as { message?: string; code?: string; remainingMinutes?: number; stack?: string };
    logger.error('startStage error', { message: e.message, code: e.code, stack: e.stack });
    if (e.code === 'DAILY_LIMIT') { error(res, e.message ?? 'Daily limit reached', 429); return; }
    if (e.code === 'COOLDOWN') { error(res, e.message ?? 'Cooldown active', 429, { remainingMinutes: e.remainingMinutes }); return; }
    if (e.code === 'ACTIVE_STAGE') { error(res, e.message ?? 'Active stage exists', 409); return; }
    error(res, 'Failed to start stage', 500);
  }
}

// ─── getQuestions ─────────────────────────────────────────────────────────────

export async function getQuestions(req: Request, res: Response): Promise<void> {
  try {
    const uid = req.userId!;
    const { session_id } = req.body as { session_id?: string };
    if (!session_id) { error(res, 'session_id is required', 400); return; }
    const result = await quizService.getQuestions(uid, session_id);
    success(res, result);
  } catch (err: unknown) {
    const e = err as { message?: string; code?: string };
    logger.error('getQuestions error', { err });
    if (e.code === 'NOT_FOUND') { error(res, e.message ?? 'Stage not found', 404); return; }
    if (e.code === 'UNAUTHORIZED') { error(res, 'Unauthorized', 403); return; }
    if (e.code === 'EXPIRED') { error(res, e.message ?? 'Stage expired', 410); return; }
    if (e.code === 'INVALID_STATUS') { error(res, e.message ?? 'Stage not active', 400); return; }
    error(res, 'Failed to get questions', 500);
  }
}

// ─── useHint ──────────────────────────────────────────────────────────────────

export async function useHint(req: Request, res: Response): Promise<void> {
  try {
    const uid = req.userId!;
    const { session_id, question_id } = req.body as { session_id?: string; question_id?: number };
    if (!session_id || !question_id) { error(res, 'session_id and question_id are required', 400); return; }
    const result = await quizService.useHint(uid, session_id, Number(question_id));
    success(res, result);
  } catch (err: unknown) {
    const e = err as { message?: string; code?: string };
    logger.error('useHint error', { err });
    if (e.code === 'NO_HINTS') { error(res, e.message ?? 'No hints remaining', 400); return; }
    if (e.code === 'NOT_FOUND') { error(res, e.message ?? 'Not found', 404); return; }
    if (e.code === 'UNAUTHORIZED') { error(res, 'Unauthorized', 403); return; }
    if (e.code === 'EXPIRED') { error(res, e.message ?? 'Stage expired', 410); return; }
    error(res, 'Failed to use hint', 500);
  }
}

// ─── claimStage ───────────────────────────────────────────────────────────────

export async function claimStage(req: Request, res: Response): Promise<void> {
  try {
    const uid = req.userId!;
    const { session_id, stage_token, answers, session_duration_ms } = req.body as {
      session_id?: string;
      stage_token?: string;
      answers?: Array<{ questionId: number; selectedOption: string; timeTakenMs: number; hintWatched: boolean }>;
      session_duration_ms?: number;
    };
    if (!session_id || !stage_token || !Array.isArray(answers) || !session_duration_ms) {
      error(res, 'session_id, stage_token, answers, and session_duration_ms are required', 400);
      return;
    }
    const result = await quizService.claimStage(uid, session_id, stage_token, answers, session_duration_ms);
    success(res, result, 'Stage claimed successfully');
  } catch (err: unknown) {
    const e = err as { message?: string; code?: string };
    logger.error('claimStage error', { err });
    if (e.code === 'INVALID_TOKEN') { error(res, 'Invalid stage token', 403); return; }
    if (e.code === 'BOT_DETECTED') { error(res, 'Suspicious activity detected', 403); return; }
    if (e.code === 'NOT_FOUND') { error(res, e.message ?? 'Stage not found', 404); return; }
    if (e.code === 'UNAUTHORIZED') { error(res, 'Unauthorized', 403); return; }
    if (e.code === 'EXPIRED') { error(res, e.message ?? 'Stage expired', 410); return; }
    if (e.code === 'INVALID_STATUS') { error(res, e.message ?? 'Stage not active', 400); return; }
    error(res, 'Failed to claim stage', 500);
  }
}

// ─── claimBonusTicket ─────────────────────────────────────────────────────────

export async function claimBonusTicket(req: Request, res: Response): Promise<void> {
  try {
    const uid = req.userId!;
    const { session_id, perfect_score } = req.body as { session_id?: string; perfect_score?: boolean };
    if (!session_id) { error(res, 'session_id is required', 400); return; }
    const bonusAmount = perfect_score === true ? 2 : 1;
    const result = await quizService.claimBonusTicket(uid, session_id, bonusAmount);
    success(res, result, 'Bonus ticket claimed');
  } catch (err: unknown) {
    const e = err as { message?: string; code?: string };
    logger.error('claimBonusTicket error', { err });
    if (e.code === 'ALREADY_CLAIMED') { error(res, e.message ?? 'Already claimed', 409); return; }
    if (e.code === 'DISABLED') { error(res, e.message ?? 'Disabled', 400); return; }
    if (e.code === 'DAILY_LIMIT') { error(res, e.message ?? 'Daily limit reached', 429); return; }
    if (e.code === 'NOT_FOUND') { error(res, e.message ?? 'Stage not found', 404); return; }
    if (e.code === 'UNAUTHORIZED') { error(res, 'Unauthorized', 403); return; }
    error(res, 'Failed to claim bonus ticket', 500);
  }
}

// ─── getQuizStatus ────────────────────────────────────────────────────────────

export async function getQuizStatus(req: Request, res: Response): Promise<void> {
  try {
    const uid = req.userId!;
    const result = await quizService.getStatus(uid);
    success(res, result);
  } catch (err) {
    logger.error('getQuizStatus error', { err });
    error(res, 'Failed to get quiz status', 500);
  }
}
