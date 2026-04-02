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
      max_tokens: 8000,
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
  questionCount?: number;
}): Promise<GeneratedQuestion[]> {
  const count = matchData.questionCount || 30;
  try {
    const prompt = `You are India's most popular cricket prediction game designer (like Dream11/My11Circle). Create ${count} HIGHLY ENGAGING prediction questions for Indian cricket fans.

MATCH: ${matchData.team1} vs ${matchData.team2}
DATE: ${matchData.date} | VENUE: ${matchData.venue}
${matchData.team1} XI: ${matchData.team1Players?.join(', ') || 'Not announced'}
${matchData.team2} XI: ${matchData.team2Players?.join(', ') || 'Not announced'}
${matchData.team1} Form: ${matchData.team1Form || 'Recent form data unavailable'}
${matchData.team2} Form: ${matchData.team2Form || 'Recent form data unavailable'}
Head to Head: ${matchData.h2h || 'Historical data unavailable'}
Toss: ${matchData.tossResult || 'Not done yet'}

CREATE EXACTLY ${count} QUESTIONS in this distribution:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏆 MATCH OUTCOME (5 questions) — 100pts each
  - Winner, margin of victory, method (runs/wickets), total overs bowled, DLS chance

🏏 BATTING HEROES (6 questions) — 150pts each
  - Top scorer team1, top scorer team2, highest partnership, first to 50, century prediction, most boundaries

⚡ BOWLING ATTACK (5 questions) — 150pts each
  - Most wickets team1, most wickets team2, best economy, first wicket method (bowled/caught/LBW), dot ball king

🎯 POWERPLAY BATTLE (4 questions) — 200pts each
  - PP score team1, PP score team2, PP wickets, which team scores more in PP

💥 DEATH OVERS DRAMA (4 questions) — 200pts each
  - Overs 17-20 runs team1, death wickets, most sixes in death, last over runs

🌟 PLAYER SPOTLIGHT (4 questions) — 250pts each
  - Use REAL player names from Playing XI
  - Specific milestones: "Will [Player] score 40+?", "Will [Player] take 2+ wickets?"
  - These should feel personal and exciting

🔥 VIRAL MOMENTS (2 questions) — 300pts each
  - Fun/unique: Most sixes in match, super over prediction, biggest six distance, crowd moment
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

QUALITY RULES (this is what makes questions addictive):
1. ✅ Use real player names wherever possible
2. ✅ Each question must have 4 specific options (not vague like "Yes/No")
3. ✅ Add drama to question text — "🔥 Can [Player] silence the critics today?"
4. ✅ Options must be believable ranges — for runs use "0-30", "31-50", "51-75", "75+"
5. ✅ All correctAnswer = "" (filled after match ends)
6. ✅ Mix emojis naturally in questions
7. ✅ questionContext = short hype line like "He's been in devastating form last 3 matches"

Return ONLY a valid JSON array, zero markdown, zero explanation:
[
  {
    "question": "🏆 Who will win the ${matchData.team1} vs ${matchData.team2} thriller?",
    "questionContext": "Both teams desperately need a win for playoff qualification",
    "options": ["${matchData.team1} by 20+ runs", "${matchData.team1} by <20 runs / wickets", "${matchData.team2} by 20+ runs", "${matchData.team2} by <20 runs / wickets"],
    "correctAnswer": "",
    "points": 100,
    "difficulty": "easy",
    "category": "prediction",
    "explanation": "Updated after match ends",
    "isPreMatch": true
  }
]`;

    const response = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10000,
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
