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

// ─── Helper: single Claude call for a batch of questions ─────────────────────
async function callClaudeBatch(prompt: string): Promise<GeneratedQuestion[]> {
  logger.info(`Claude batch call — API key set: ${!!process.env.ANTHROPIC_API_KEY}, key prefix: ${process.env.ANTHROPIC_API_KEY?.slice(0, 15)}...`);
  const response = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 6000,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  logger.info(`Claude batch response length: ${text.length} chars, stop_reason: ${response.stop_reason}`);
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    logger.error(`No JSON array found in Claude response. First 200 chars: ${text.slice(0, 200)}`);
    throw new Error('No JSON array in Claude response');
  }
  const parsed = JSON.parse(jsonMatch[0]) as GeneratedQuestion[];
  logger.info(`Claude batch parsed ${parsed.length} questions`);
  return parsed;
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
  const t1 = matchData.team1;
  const t2 = matchData.team2;
  const xi1 = matchData.team1Players?.join(', ') || 'Not announced';
  const xi2 = matchData.team2Players?.join(', ') || 'Not announced';
  const context = `MATCH: ${t1} vs ${t2} | DATE: ${matchData.date} | VENUE: ${matchData.venue}
${t1} XI: ${xi1}
${t2} XI: ${xi2}
${t1} Form: ${matchData.team1Form || 'No data'}
${t2} Form: ${matchData.team2Form || 'No data'}
H2H: ${matchData.h2h || 'No data'} | Toss: ${matchData.tossResult || 'Not done'}`;

  const rules = `RULES:
- ALL questions and options must be in ENGLISH ONLY — no Hindi, no Hinglish
- Each question has exactly 4 specific options (never just Yes/No)
- All correctAnswer must be "" (empty string)
- Add drama + emojis to questions
- Use real player names from the XI above
- questionContext = 1 short hype line in English
- Return ONLY a valid JSON array, no markdown`;

  const batch1Prompt = `You are India's top cricket prediction game designer. Create exactly 15 ENGAGING questions for Indian fans.

${context}

CREATE THESE 15 QUESTIONS:
🏆 MATCH OUTCOME (5 questions, 100 pts each)
  Q1: Who will win? Options: "${t1} by 20+ runs", "${t1} by <20 runs/wickets", "${t2} by 20+ runs", "${t2} by <20 runs/wickets"
  Q2: Winning margin? Options: "1-10 runs / 1-3 wickets", "11-25 runs / 4-6 wickets", "26-50 runs / 7-8 wickets", "51+ runs / 9-10 wickets"
  Q3: Match result method? Options: "Won by runs", "Won by wickets", "Super Over", "No Result / DLS"
  Q4: Total runs both teams combined? Options: "Under 300", "300-340", "341-380", "381+"
  Q5: Will there be a DLS situation? Options: "Yes, DLS applied", "No, full match", "Match abandoned", "Reduced overs both"

🏏 BATTING HEROES (6 questions, 150 pts each)
  Q6: Top scorer of the match? Options: 4 player names from both XIs
  Q7: Will ${t1}'s top batter score 50+? Options: "Yes, scores 50-74", "Yes, scores 75+", "No, out under 50", "Does not bat"
  Q8: Will ${t2}'s top batter score 50+? Options: same pattern
  Q9: Highest partnership in the match? Options: "Under 50 runs", "50-80 runs", "81-120 runs", "121+ runs"
  Q10: Total boundaries (4s+6s) in match? Options: "Under 30", "30-45", "46-60", "61+"
  Q11: First team to reach 100 runs? Options: "${t1} in PP (1-6 overs)", "${t1} in overs 7-12", "${t2} in PP (1-6 overs)", "${t2} in overs 7-12"

⚡ BOWLING ATTACK (4 questions, 150 pts each)
  Q12: Most wickets in the match? Options: 4 bowler names from both XIs
  Q13: Total wickets to fall in match? Options: "Under 12", "12-15", "16-18", "19-20"
  Q14: Best bowling economy (<7 runs/over)? Options: 4 bowler names from both XIs
  Q15: First wicket method? Options: "Caught", "Bowled", "LBW", "Run Out / Stumped"

${rules}`;

  const batch2Prompt = `You are India's top cricket prediction game designer. Create exactly 15 ENGAGING questions for Indian fans.

${context}

CREATE THESE 15 QUESTIONS:
🎯 POWERPLAY BATTLE (4 questions, 200 pts each)
  Q1: ${t1} powerplay score (overs 1-6)? Options: "Under 40", "40-55", "56-70", "71+"
  Q2: ${t2} powerplay score (overs 1-6)? Options: "Under 40", "40-55", "56-70", "71+"
  Q3: Wickets in powerplay (both innings combined)? Options: "0-1 wickets", "2-3 wickets", "4-5 wickets", "6+ wickets"
  Q4: Which team dominates powerplay? Options: "${t1} by 10+ runs", "${t1} by <10 runs", "${t2} by 10+ runs", "${t2} by <10 runs"

💥 DEATH OVERS DRAMA (4 questions, 200 pts each)
  Q5: Runs scored in last 4 overs by match winner? Options: "Under 40", "40-55", "56-70", "71+"
  Q6: Total sixes in the match? Options: "Under 10", "10-15", "16-22", "23+"
  Q7: Will there be a last-ball finish? Options: "Yes, last over decider", "No, won comfortably", "Second last over finish", "Super Over needed"
  Q8: Biggest six of the match (estimated meters)? Options: "Under 90m", "90-100m", "101-110m", "110m+"

🌟 PLAYER SPOTLIGHT (5 questions, 250 pts each)
  Q9-Q13: Use REAL player names from XIs. Create dramatic questions like:
  "🔥 Can [Player Name] silence the critics with a big knock today?"
  "⚡ Will [Bowler Name] be the match-winner with 3+ wickets?"
  "🏏 [Player Name] needs X runs for a milestone — will he get there?"
  Make these personal, dramatic, and exciting using actual players listed above.

🔥 VIRAL MOMENTS (2 questions, 300 pts each)
  Q14: Man of the Match will be? Options: 4 player names (mix of batters + bowlers)
  Q15: Most entertaining moment? Options: "A century", "A hat-trick", "A Super Over", "A last-ball six"

${rules}`;

  const allQuestions: GeneratedQuestion[] = [];

  // Run both batches — if one fails, use what we have from the other
  const [result1, result2] = await Promise.allSettled([
    callClaudeBatch(batch1Prompt),
    callClaudeBatch(batch2Prompt),
  ]);

  if (result1.status === 'fulfilled') {
    allQuestions.push(...result1.value);
  } else {
    logger.error('Batch 1 failed:', result1.reason);
  }

  if (result2.status === 'fulfilled') {
    allQuestions.push(...result2.value);
  } else {
    logger.error('Batch 2 failed:', result2.reason);
  }

  if (allQuestions.length >= 10) {
    logger.info(`Generated ${allQuestions.length} questions via 2-batch Claude call`);
    return allQuestions;
  }

  // Full fallback
  logger.error('Both Claude batches failed, using fallback questions');
  return getDefaultQuestions(matchData);
}
