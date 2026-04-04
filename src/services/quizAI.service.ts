/**
 * quizAI.service.ts
 *
 * Generates sports quiz questions via Claude AI and persists them to SportsQuestion.
 */

import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface AiQuestion {
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctOption: string;
  explanation: string;
  sport: string;
  difficulty: string;
}

const VALID_OPTIONS = new Set(['A', 'B', 'C', 'D']);
const VALID_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const VALID_SPORTS = new Set(['ipl', 'cricket', 'football', 'kabaddi', 'badminton', 'tennis', 'other']);

function isValidQuestion(q: unknown): q is AiQuestion {
  if (!q || typeof q !== 'object') return false;
  const obj = q as Record<string, unknown>;
  return (
    typeof obj.question === 'string' && obj.question.trim().length > 0 &&
    typeof obj.optionA === 'string' && obj.optionA.trim().length > 0 &&
    typeof obj.optionB === 'string' && obj.optionB.trim().length > 0 &&
    typeof obj.optionC === 'string' && obj.optionC.trim().length > 0 &&
    typeof obj.optionD === 'string' && obj.optionD.trim().length > 0 &&
    typeof obj.correctOption === 'string' && VALID_OPTIONS.has(obj.correctOption.toUpperCase()) &&
    typeof obj.sport === 'string' &&
    typeof obj.difficulty === 'string'
  );
}

export async function generateQuestions(
  count: number,
  sport: string,
  difficulty: string
): Promise<void> {
  const sportLabel = VALID_SPORTS.has(sport) ? sport : 'other';
  const diffLabel = VALID_DIFFICULTIES.has(difficulty) ? difficulty : 'easy';

  const prompt = `You are a sports quiz expert. Generate exactly ${count} multiple-choice quiz questions about ${sportLabel} at ${diffLabel} difficulty level for Indian sports fans.

Return ONLY a valid JSON array with no markdown, no explanation, no other text:
[
  {
    "question": "Question text here?",
    "optionA": "Option A text",
    "optionB": "Option B text",
    "optionC": "Option C text",
    "optionD": "Option D text",
    "correctOption": "A",
    "explanation": "Brief explanation of why this is correct",
    "sport": "${sportLabel}",
    "difficulty": "${diffLabel}"
  }
]

Rules:
- correctOption must be exactly "A", "B", "C", or "D"
- All 4 options must be distinct and plausible
- Questions should be factual and verifiable
- Keep questions relevant to Indian audience interests
- difficulty="${diffLabel}": ${diffLabel === 'easy' ? 'basic knowledge, widely known facts' : diffLabel === 'medium' ? 'moderate knowledge, some research needed' : 'expert knowledge, detailed stats and history'}
- Generate exactly ${count} questions`;

  try {
    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in Claude response');

    const parsed: unknown[] = JSON.parse(jsonMatch[0]);
    const valid = parsed.filter(isValidQuestion);

    if (valid.length === 0) throw new Error('No valid questions in Claude response');

    await prisma.sportsQuestion.createMany({
      data: valid.map((q) => ({
        question: q.question.trim(),
        optionA: q.optionA.trim(),
        optionB: q.optionB.trim(),
        optionC: q.optionC.trim(),
        optionD: q.optionD.trim(),
        correctOption: q.correctOption.toUpperCase(),
        explanation: q.explanation?.trim() ?? null,
        sport: VALID_SPORTS.has(q.sport) ? q.sport : sportLabel,
        difficulty: VALID_DIFFICULTIES.has(q.difficulty) ? q.difficulty : diffLabel,
        isAiGenerated: true,
      })),
      skipDuplicates: true,
    });

    logger.info(`quizAI: saved ${valid.length} AI questions`, { sport: sportLabel, difficulty: diffLabel });
  } catch (err) {
    logger.error('quizAI.generateQuestions error', { err, sport: sportLabel, difficulty: diffLabel });
    throw err;
  }
}

export async function generateQuestionsIfNeeded(): Promise<void> {
  const settings = await prisma.quizSettings.findUnique({ where: { id: 1 } });
  if (!settings?.aiGenerationEnabled) {
    logger.info('quizAI: AI generation disabled, skipping');
    return;
  }

  const sports: string[] = ['ipl', 'cricket', 'football', 'kabaddi', 'badminton', 'tennis', 'other'];

  for (const sport of sports) {
    const count = await prisma.sportsQuestion.count({
      where: { sport, isActive: true },
    });

    if (count < 20) {
      logger.info(`quizAI: sport="${sport}" has ${count} active questions (< 20), generating 10 more`);
      try {
        // mix of easy and medium
        await generateQuestions(5, sport, 'easy');
        await generateQuestions(5, sport, 'medium');
      } catch (err) {
        logger.error(`quizAI: failed to generate for sport="${sport}"`, { err });
      }
    } else {
      logger.debug(`quizAI: sport="${sport}" has ${count} active questions, no generation needed`);
    }
  }
}
