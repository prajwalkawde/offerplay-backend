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
    { question: `🏏 Who will win ${matchData.team1} vs ${matchData.team2}?`, options: [matchData.team1, matchData.team2, 'No Result', 'Super Over'], correctAnswer: '', points: 100, difficulty: 'easy', category: 'prediction', explanation: 'Updated after match ends', isPreMatch: true },
    { question: `🎯 Who will win the toss?`, options: [matchData.team1, matchData.team2], correctAnswer: '', points: 50, difficulty: 'easy', category: 'prediction', explanation: 'Updated after toss', isPreMatch: true },
    { question: `💥 Will there be a century in this match?`, options: ['Yes', 'No'], correctAnswer: '', points: 100, difficulty: 'medium', category: 'prediction', explanation: 'Updated after match', isPreMatch: true },
    { question: `🏆 How many sixes will be hit in total?`, options: ['0-10', '11-20', '21-30', '31+'], correctAnswer: '', points: 120, difficulty: 'medium', category: 'prediction', explanation: 'Updated after match', isPreMatch: true },
    { question: `⚡ Which team will score more in the powerplay?`, options: [matchData.team1, matchData.team2, 'Equal'], correctAnswer: '', points: 100, difficulty: 'medium', category: 'prediction', explanation: 'Updated after powerplay', isPreMatch: true },
    { question: `📊 What will be the total runs scored in the match?`, options: ['Under 300', '300-350', '351-400', 'Over 400'], correctAnswer: '', points: 120, difficulty: 'hard', category: 'prediction', explanation: 'Updated after match', isPreMatch: true },
    { question: `🎲 Will ${matchData.team1} win by more than 20 runs or 2+ wickets?`, options: ['Yes, convincingly', 'No, close finish'], correctAnswer: '', points: 150, difficulty: 'hard', category: 'prediction', explanation: 'Updated after match', isPreMatch: true },
    { question: `🏏 Will the match have a 50+ partnership?`, options: ['Yes', 'No'], correctAnswer: 'Yes', points: 100, difficulty: 'easy', category: 'trivia', explanation: 'Most T20 matches have a 50+ partnership', isPreMatch: false },
    { question: `👑 Who will be Man of the Match?`, options: [`${matchData.team1} player`, `${matchData.team2} player`, 'All-rounder'], correctAnswer: '', points: 150, difficulty: 'hard', category: 'prediction', explanation: 'Updated after match', isPreMatch: true },
    { question: `🎯 Will there be a five-wicket haul in this match?`, options: ['Yes', 'No'], correctAnswer: 'No', points: 150, difficulty: 'hard', category: 'prediction', explanation: 'Five-wicket hauls are rare in T20', isPreMatch: false },
  ];
}

export interface MatchResult {
  winner: string;
  manOfMatch?: string;
  topScorer?: string;
  team1Score?: number | string;
  team2Score?: number | string;
}

export interface VerifiedAnswer {
  questionId: string;
  correctAnswer: string;
  confidence: number;
  reason: string;
}

export async function verifyAnswersWithAI(
  questions: any[],
  matchResult: MatchResult
): Promise<any[]> {
  try {
    const prompt = `You are verifying IPL prediction contest answers based on the actual match result.

MATCH RESULT:
Winner: ${matchResult.winner}
Man of Match: ${matchResult.manOfMatch || 'Unknown'}
Team 1 Score: ${matchResult.team1Score || 'Unknown'}
Team 2 Score: ${matchResult.team2Score || 'Unknown'}

QUESTIONS TO VERIFY:
${JSON.stringify(questions.map(q => ({ id: q.id, question: q.question, options: q.options, correctAnswer: q.correctAnswer })), null, 2)}

For each question, determine the correct answer based ONLY on the match result above.

Rules:
- If you cannot determine the answer from the scorecard, set confidence below 0.7
- For prediction questions with no clear answer, set confidence to 0.5
- Base ALL answers strictly on the match result data provided

Return ONLY a valid JSON array, no markdown, no other text:
[
  {
    "questionId": "xxx",
    "correctAnswer": "option text here",
    "confidence": 0.95,
    "reason": "brief reason"
  }
]`;

    const response = await claude.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return questions;

    const verified: VerifiedAnswer[] = JSON.parse(jsonMatch[0]);

    // Only apply answers with high confidence
    return questions.map(q => {
      const v = verified.find(r => r.questionId === q.id);
      if (!v || v.confidence < 0.85) return q; // keep original, flag for review
      return { ...q, correctAnswer: v.correctAnswer, claudeConfidence: v.confidence };
    });
  } catch (err) {
    logger.error('Claude AI verifyAnswersWithAI error:', err);
    return questions;
  }
}

export async function generateQuestionsWithContext(matchData: IplMatchData & {
  team1Players?: string[];
  team2Players?: string[];
  team1Form?: string;
  team2Form?: string;
  h2h?: string;
  tossResult?: string;
}): Promise<GeneratedQuestion[]> {
  try {
    const prompt = `You are India's top IPL cricket analyst creating prediction questions for a mobile game.

MATCH DETAILS:
Teams: ${matchData.team1} vs ${matchData.team2}
Date: ${matchData.date}
Venue: ${matchData.venue}
${matchData.team1} Playing XI: ${matchData.team1Players?.join(', ') || 'Not announced yet'}
${matchData.team2} Playing XI: ${matchData.team2Players?.join(', ') || 'Not announced yet'}
Recent Form ${matchData.team1}: ${matchData.team1Form || 'No data'}
Recent Form ${matchData.team2}: ${matchData.team2Form || 'No data'}
Head to Head: ${matchData.h2h || 'No data'}
Toss: ${matchData.tossResult || 'Not done yet'}

Create exactly 10 prediction questions. STRICTLY follow this mix:
- Q1-2: EASY (100 pts) - Match winner, Toss
- Q3-4: MEDIUM (150 pts) - Top scorer, powerplay
- Q5-6: MEDIUM (200 pts) - Score range, wickets
- Q7-8: HARD (250 pts) - Player milestones
- Q9-10: HARD (300 pts) - Special/fun viral question

RULES:
1. Use REAL PLAYER NAMES from Playing XI if available
2. Add context/story to each question (why it matters)
3. Make options specific (not just Yes/No)
4. correctAnswer must be empty string (set after match)

Return ONLY valid JSON array:
[
  {
    "question": "question text with context story",
    "questionContext": "why this question matters",
    "options": ["opt1", "opt2", "opt3", "opt4"],
    "correctAnswer": "",
    "points": 100,
    "difficulty": "easy",
    "category": "prediction",
    "explanation": "will be updated after match",
    "isPreMatch": true
  }
]`;

    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in response');

    return JSON.parse(jsonMatch[0]) as GeneratedQuestion[];
  } catch (err) {
    logger.error('generateQuestionsWithContext error:', err);
    return generateIPLQuestions(matchData); // fallback to existing function
  }
}
