import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const claude = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

export interface IplMatchData {
  team1: string;
  team2: string;
  date: string;
  venue: string;
  team1Form?: string;
  team2Form?: string;
  headToHead?: string;
}

export interface GeneratedQuestion {
  question: string;
  options: string[];
  correctAnswer: string;
  points: number;
  difficulty: string;
  category: string;
  explanation: string;
  isPreMatch: boolean;
}

export async function generateIPLQuestions(
  matchData: IplMatchData
): Promise<GeneratedQuestion[]> {
  try {
    const prompt = `You are an expert cricket analyst and quiz master creating an exciting IPL quiz for Indian fans on the OfferPlay app.

MATCH DETAILS:
Teams: ${matchData.team1} vs ${matchData.team2}
Date: ${matchData.date}
Venue: ${matchData.venue}
Series: IPL 2026

TEAM CONTEXT:
${matchData.team1} recent form: ${matchData.team1Form || 'Good form'}
${matchData.team2} recent form: ${matchData.team2Form || 'Good form'}

HEAD TO HEAD:
${matchData.team1} vs ${matchData.team2}: ${matchData.headToHead || 'Closely contested series'}

INSTRUCTIONS:
Create exactly 10 quiz questions:
1. 4 prediction questions (about today's match outcome)
2. 3 player trivia questions (interesting facts)
3. 2 stats questions (records/history)
4. 1 fun fan question (engaging, light-hearted)

Make questions:
- Exciting and engaging for Indian cricket fans
- Mix difficulty: 5 easy + 3 medium + 2 hard
- Include specific stats and numbers
- Add interesting explanations
- Use emojis in questions to make them fun

IMPORTANT: Return ONLY a valid JSON array, no markdown, no other text:
[
  {
    "question": "🏏 Who will win today's match?",
    "options": ["${matchData.team1}", "${matchData.team2}", "Match will be tied", "Match abandoned due to rain"],
    "correctAnswer": "",
    "points": 100,
    "difficulty": "easy",
    "category": "prediction",
    "explanation": "Results will be updated after match ends",
    "isPreMatch": true
  }
]

Note: For prediction questions leave correctAnswer empty string. For trivia/stats questions fill correctAnswer with the correct option text.`;

    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in Claude response');

    return JSON.parse(jsonMatch[0]) as GeneratedQuestion[];
  } catch (err) {
    logger.error('Claude AI generateIPLQuestions error:', err);
    return getDefaultQuestions(matchData);
  }
}

function getDefaultQuestions(matchData: IplMatchData): GeneratedQuestion[] {
  return [
    {
      question: `🏏 Who will win ${matchData.team1} vs ${matchData.team2}?`,
      options: [matchData.team1, matchData.team2, 'No result', 'Super Over'],
      correctAnswer: '',
      points: 100,
      difficulty: 'easy',
      category: 'prediction',
      explanation: 'Updated after match',
      isPreMatch: true,
    },
  ];
}

export interface MatchResult {
  winner: string;
  manOfMatch?: string;
  topScorer?: string;
  team1Score?: number;
  team2Score?: number;
}

export async function verifyAnswersWithAI(
  questions: any[],
  matchResult: MatchResult
): Promise<any[]> {
  try {
    const prompt = `Given these IPL match prediction questions and the actual match result, determine which answers are correct.

MATCH RESULT:
Winner: ${matchResult.winner}
Man of Match: ${matchResult.manOfMatch || 'Unknown'}
Top Scorer runs: ${matchResult.topScorer || 'Unknown'}
Team 1 Score: ${matchResult.team1Score || 'Unknown'}
Team 2 Score: ${matchResult.team2Score || 'Unknown'}

QUESTIONS TO VERIFY:
${JSON.stringify(questions, null, 2)}

Return ONLY a valid JSON array with correctAnswer filled in for each question based on the actual result. Preserve ALL existing fields including the "id" field. Only return the JSON array, no markdown, no other text.`;

    const response = await claude.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return questions;

    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    logger.error('Claude AI verifyAnswersWithAI error:', err);
    return questions;
  }
}
