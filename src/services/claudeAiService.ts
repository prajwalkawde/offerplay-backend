import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const claude = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ─── IPL 2026 Squad Data ──────────────────────────────────────────────────────
// Key players per team — used as fallback when match.team1Players is not set
const IPL_SQUADS: Record<string, { batters: string[]; bowlers: string[]; allRounders: string[] }> = {
  'Mumbai Indians': {
    batters:     ['Rohit Sharma', 'Suryakumar Yadav', 'Ishan Kishan', 'Tilak Varma', 'Tim David'],
    bowlers:     ['Jasprit Bumrah', 'Mohammad Nabi', 'Piyush Chawla', 'Trent Boult', 'Jason Behrendorff'],
    allRounders: ['Hardik Pandya', 'Kieron Pollard', 'Romario Shepherd'],
  },
  'Chennai Super Kings': {
    batters:     ['Ruturaj Gaikwad', 'Devon Conway', 'Shivam Dube', 'Ajinkya Rahane', 'Rachin Ravindra'],
    bowlers:     ['Deepak Chahar', 'Tushar Deshpande', 'Matheesha Pathirana', 'Noor Ahmad', 'Simarjeet Singh'],
    allRounders: ['MS Dhoni', 'Ravindra Jadeja', 'Moeen Ali', 'Sameer Rizvi'],
  },
  'Royal Challengers Bangalore': {
    batters:     ['Virat Kohli', 'Faf du Plessis', 'Rajat Patidar', 'Dinesh Karthik', 'Cameron Green'],
    bowlers:     ['Mohammed Siraj', 'Harshal Patel', 'Alzarri Joseph', 'Karn Sharma', 'Reece Topley'],
    allRounders: ['Glenn Maxwell', 'Shahbaz Ahmed', 'Mahipal Lomror'],
  },
  'Kolkata Knight Riders': {
    batters:     ['Shreyas Iyer', 'Rinku Singh', 'Venkatesh Iyer', 'Phil Salt', 'Angkrish Raghuvanshi'],
    bowlers:     ['Varun Chakravarthy', 'Harshit Rana', 'Mitchell Starc', 'Suyash Sharma', 'Spencer Johnson'],
    allRounders: ['Andre Russell', 'Sunil Narine', 'Anukul Roy'],
  },
  'Delhi Capitals': {
    batters:     ['Rishabh Pant', 'David Warner', 'Jake Fraser-McGurk', 'Prithvi Shaw', 'Shai Hope'],
    bowlers:     ['Kuldeep Yadav', 'Anrich Nortje', 'Ishant Sharma', 'Mukesh Kumar', 'Khaleel Ahmed'],
    allRounders: ['Mitchell Marsh', 'Axar Patel', 'Tristan Stubbs'],
  },
  'Rajasthan Royals': {
    batters:     ['Sanju Samson', 'Jos Buttler', 'Yashasvi Jaiswal', 'Shimron Hetmyer', 'Riyan Parag'],
    bowlers:     ['Trent Boult', 'Yuzvendra Chahal', 'Sandeep Sharma', 'Avesh Khan', 'Nandre Burger'],
    allRounders: ['Ravichandran Ashwin', 'Dhruv Jurel', 'Donovan Ferreira'],
  },
  'Sunrisers Hyderabad': {
    batters:     ['Travis Head', 'Abhishek Sharma', 'Heinrich Klaasen', 'Aiden Markram', 'Rahul Tripathi'],
    bowlers:     ['Bhuvneshwar Kumar', 'T Natarajan', 'Shahbaz Ahmed', 'Jaydev Unadkat', 'Marco Jansen'],
    allRounders: ['Pat Cummins', 'Washington Sundar', 'Mayank Markande'],
  },
  'Punjab Kings': {
    batters:     ['Shikhar Dhawan', 'Jonny Bairstow', 'Prabhsimran Singh', 'Rilee Rossouw', 'Atharva Taide'],
    bowlers:     ['Arshdeep Singh', 'Kagiso Rabada', 'Nathan Ellis', 'Harshal Patel', 'Rahul Chahar'],
    allRounders: ['Sam Curran', 'Liam Livingstone', 'Harpreet Brar'],
  },
  'Lucknow Super Giants': {
    batters:     ['KL Rahul', 'Quinton de Kock', 'Deepak Hooda', 'Kyle Mayers', 'Ayush Badoni'],
    bowlers:     ['Mark Wood', 'Ravi Bishnoi', 'Mohsin Khan', 'Yash Thakur', 'Amit Mishra'],
    allRounders: ['Marcus Stoinis', 'Krunal Pandya', 'Prerak Mankad'],
  },
  'Gujarat Titans': {
    batters:     ['Shubman Gill', 'David Miller', 'Wriddhiman Saha', 'Sai Sudharsan', 'B Sai Sudharsan'],
    bowlers:     ['Rashid Khan', 'Mohammed Shami', 'Noor Ahmad', 'Josh Little', 'Umesh Yadav'],
    allRounders: ['Vijay Shankar', 'Rahul Tewatia', 'Azmatullah Omarzai'],
  },
};

function getSquad(teamName: string): { batters: string[]; bowlers: string[]; allRounders: string[] } {
  return IPL_SQUADS[teamName] ?? {
    batters: ['Opener A', 'Opener B', 'No.3 Batter', 'Finisher'],
    bowlers: ['Fast Bowler 1', 'Spinner 1', 'Fast Bowler 2'],
    allRounders: ['All-rounder 1'],
  };
}

function pickRandom<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

// 4 unique player names from both squads for player-based question options
function playerOptions(
  t1: { batters: string[]; bowlers: string[]; allRounders: string[] },
  t2: { batters: string[]; bowlers: string[]; allRounders: string[] },
  type: 'batter' | 'bowler' | 'any' = 'any',
): string[] {
  let pool: string[];
  if (type === 'batter')  pool = [...t1.batters, ...t2.batters];
  else if (type === 'bowler') pool = [...t1.bowlers, ...t2.bowlers];
  else pool = [...t1.batters, ...t1.bowlers, ...t1.allRounders, ...t2.batters, ...t2.bowlers, ...t2.allRounders];
  return pickRandom([...new Set(pool)], 4);
}

// ─── Interfaces ───────────────────────────────────────────────────────────────
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
  questionContext?: string;
}

// ─── Language instructions ────────────────────────────────────────────────────
const LANGUAGE_INSTRUCTIONS: Record<string, string> = {
  en:       'Write ALL questions and options in ENGLISH only.',
  hi:       'Write ALL questions and options in Hindi (हिंदी) using Devanagari script only.',
  hinglish: 'Write ALL questions and options in Hinglish (fun Roman script mix like "Kaun marega century aaj?"). Casual and energetic.',
  ta:       'Write ALL questions and options in Tamil (தமிழ்) using Tamil script only.',
  te:       'Write ALL questions and options in Telugu (తెలుగు) using Telugu script only.',
  bn:       'Write ALL questions and options in Bengali (বাংলা) using Bengali script only.',
  mr:       'Write ALL questions and options in Marathi (मराठी) using Devanagari script only.',
};

// ─── Helper: single Claude call ───────────────────────────────────────────────
async function callClaude(prompt: string): Promise<GeneratedQuestion[]> {
  logger.info(`Claude question gen — API key set: ${!!process.env.ANTHROPIC_API_KEY}`);
  const response = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  logger.info(`Claude response: ${text.length} chars, stop_reason: ${response.stop_reason}`);
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    logger.error(`No JSON found. First 300 chars: ${text.slice(0, 300)}`);
    throw new Error('No JSON array in Claude response');
  }
  const parsed = JSON.parse(jsonMatch[0]) as GeneratedQuestion[];
  logger.info(`Parsed ${parsed.length} questions`);
  return parsed;
}

// ─── Main export: generate questions with context ────────────────────────────
export async function generateQuestionsWithContext(matchData: IplMatchData & {
  team1Players?: string[];
  team2Players?: string[];
  questionCount?: number;
  language?: string;
}): Promise<GeneratedQuestion[]> {
  const t1 = matchData.team1;
  const t2 = matchData.team2;
  const lang = matchData.language || 'en';
  const langInstruction = LANGUAGE_INSTRUCTIONS[lang] ?? LANGUAGE_INSTRUCTIONS.en;

  // Build player lists — use provided players first, fall back to hardcoded squads
  const squad1 = getSquad(t1);
  const squad2 = getSquad(t2);

  const t1Batters    = (matchData.team1Players?.length ? matchData.team1Players : squad1.batters).slice(0, 5);
  const t1Bowlers    = squad1.bowlers.slice(0, 4);
  const t1AllRounder = squad1.allRounders[0];
  const t2Batters    = (matchData.team2Players?.length ? matchData.team2Players : squad2.batters).slice(0, 5);
  const t2Bowlers    = squad2.bowlers.slice(0, 4);
  const t2AllRounder = squad2.allRounders[0];

  // Pick 4 varied options for common player questions
  const topBatterOpts  = playerOptions(squad1, squad2, 'batter');
  const topBowlerOpts  = playerOptions(squad1, squad2, 'bowler');
  const motmOpts       = playerOptions(squad1, squad2, 'any');
  const t1BatterStar   = t1Batters[0] ?? `${t1} opener`;
  const t2BatterStar   = t2Batters[0] ?? `${t2} opener`;
  const t1BowlerStar   = t1Bowlers[0] ?? `${t1} bowler`;
  const t2BowlerStar   = t2Bowlers[0] ?? `${t2} bowler`;

  const context = `
MATCH: ${t1} vs ${t2}
DATE: ${matchData.date}
VENUE: ${matchData.venue || 'TBD'}
IPL 2026 SEASON

${t1} KEY PLAYERS:
  Batters:      ${t1Batters.join(', ')}
  Bowlers:      ${t1Bowlers.join(', ')}
  All-rounder:  ${t1AllRounder}

${t2} KEY PLAYERS:
  Batters:      ${t2Batters.join(', ')}
  Bowlers:      ${t2Bowlers.join(', ')}
  All-rounder:  ${t2AllRounder}
`.trim();

  const rules = `
STRICT RULES:
1. LANGUAGE: ${langInstruction}
2. Every question must have EXACTLY 4 options (specific, not vague)
3. All correctAnswer MUST be "" (empty string — filled after match)
4. Use REAL player names from the KEY PLAYERS listed above
5. Add emojis and drama to make questions exciting for Indian fans
6. questionContext = 1 short hype sentence in the same language
7. Return ONLY a valid JSON array — no markdown, no explanation
`.trim();

  const batch1Prompt = `You are India's #1 cricket prediction game designer for IPL 2026. Create exactly 15 thrilling questions.

${context}

CREATE THESE 15 QUESTIONS (use exact player names from the list above):

🏆 MATCH RESULT (5 questions — 100 pts each):
Q1: Who wins? Options: "${t1} by 20+ runs", "${t1} by <20 runs/wickets", "${t2} by 20+ runs", "${t2} by <20 runs/wickets"
Q2: Winning margin? Options: "1-10 runs / 1-3 wkts", "11-30 runs / 4-6 wkts", "31-50 runs / 7-8 wkts", "Super Over / DLS"
Q3: Total combined runs? Options: "Under 290", "290-330", "331-370", "371+"
Q4: How many sixes total? Options: "Under 10", "10-16", "17-22", "23+"
Q5: First ball wicket in the match? Options: "Yes, first ball dismissal", "No", "Maiden first over", "Boundary first ball"

🏏 BATTING HEROES (5 questions — 150 pts each):
Q6: Top scorer of the match? Options: ${JSON.stringify(topBatterOpts)}
Q7: Will ${t1BatterStar} score 50+ runs? Options: "Yes, scores 50-74", "Yes, scores 75-99", "Yes, century 100+", "No, out under 50"
Q8: Will ${t2BatterStar} score 50+ runs? Options: "Yes, scores 50-74", "Yes, scores 75-99", "Yes, century 100+", "No, out under 50"
Q9: Biggest partnership in the match? Options: "Under 50 runs", "50-80 runs", "81-120 runs", "121+ runs"
Q10: Total boundaries (4s only) in match? Options: "Under 25", "25-35", "36-45", "46+"

⚡ BOWLING ATTACK (5 questions — 150 pts each):
Q11: Most wickets in the match? Options: ${JSON.stringify(topBowlerOpts)}
Q12: Total wickets to fall (both innings)? Options: "Under 10", "10-13", "14-17", "18-20"
Q13: Will ${t1BowlerStar} take 3+ wickets? Options: "Yes, 3 wickets", "Yes, 4+ wickets", "No, 1-2 wickets", "No wicket"
Q14: Will ${t2BowlerStar} take 3+ wickets? Options: "Yes, 3 wickets", "Yes, 4+ wickets", "No, 1-2 wickets", "No wicket"
Q15: First wicket method in the match? Options: "Caught", "Bowled", "LBW", "Run Out / Stumped"

${rules}

JSON format for each question:
{"question":"...","options":["...","...","...","..."],"correctAnswer":"","points":100,"difficulty":"easy|medium|hard","category":"prediction|trivia","explanation":"Updated after match","isPreMatch":true,"questionContext":"..."}`;

  const batch2Prompt = `You are India's #1 cricket prediction game designer for IPL 2026. Create exactly 15 thrilling questions.

${context}

CREATE THESE 15 QUESTIONS (use exact player names from the list above):

🎯 POWERPLAY BATTLE (4 questions — 200 pts each):
Q1: ${t1} powerplay score (overs 1-6)? Options: "Under 40 runs", "40-54 runs", "55-69 runs", "70+ runs"
Q2: ${t2} powerplay score (overs 1-6)? Options: "Under 40 runs", "40-54 runs", "55-69 runs", "70+ runs"
Q3: Wickets in powerplay (both innings combined)? Options: "0-1 wickets", "2-3 wickets", "4-5 wickets", "6+ wickets"
Q4: Which team has better powerplay? Options: "${t1} by 10+ runs", "${t1} by <10 runs", "${t2} by 10+ runs", "${t2} by <10 runs"

💥 DEATH OVERS DRAMA (4 questions — 200 pts each):
Q5: Runs in last 4 overs by the winner? Options: "Under 40", "40-54", "55-69", "70+"
Q6: Will there be a last-over finish (result decided in last over)? Options: "Yes, last over thriller", "No, won by over 15 runs", "Second-last over decider", "Super Over"
Q7: Highest individual score in the match? Options: "Under 40", "40-59", "60-89", "90+"
Q8: Will ${t1AllRounder} score 30+ AND take 2+ wickets? Options: "Yes, complete all-round show", "Only bats well (30+)", "Only bowls well (2+ wkts)", "Neither — off day"

🌟 STAR PLAYER SPOTLIGHT (5 questions — 250 pts each):
Q9:  🔥 Can ${t1BatterStar} be the match-winner for ${t1}? Options: "Yes, 60+ game-changing knock", "Yes, 40-59 solid innings", "No, dismissed early", "Does not bat"
Q10: ⚡ Will ${t2BatterStar} be the standout performer? Options: "Yes, 60+ brilliant knock", "Yes, 40-59 solid knock", "No, dismissed cheaply", "Does not bat"
Q11: 🎳 Can ${t1BowlerStar} destroy the ${t2} batting? Options: "Yes, 4+ wickets", "Yes, 2-3 wickets + economy <7", "Takes 1 wicket", "Expensive spell (economy 10+)"
Q12: 💪 Will ${t2AllRounder} swing the match for ${t2}? Options: "Yes, match-winning all-round", "Contributes with bat only", "Contributes with ball only", "Below par performance"
Q13: 🏆 Man of the Match will be? Options: ${JSON.stringify(motmOpts)}

🔥 VIRAL MOMENTS (2 questions — 300 pts each):
Q14: 🎆 Will there be a hat-trick in this match? Options: "Yes, ${t1} bowler gets hat-trick", "Yes, ${t2} bowler gets hat-trick", "No hat-trick but 4-wicket haul", "No — all singles and twos"
Q15: 🎉 Most dramatic moment? Options: "A last-ball six wins the match", "A hat-trick dismissal", "A century off 40 balls", "A direct-hit run-out"

${rules}

JSON format for each question:
{"question":"...","options":["...","...","...","..."],"correctAnswer":"","points":200,"difficulty":"medium","category":"prediction","explanation":"Updated after match","isPreMatch":true,"questionContext":"..."}`;

  const allQuestions: GeneratedQuestion[] = [];

  const [result1, result2] = await Promise.allSettled([
    callClaude(batch1Prompt),
    callClaude(batch2Prompt),
  ]);

  if (result1.status === 'fulfilled') allQuestions.push(...result1.value);
  else logger.error(`Batch 1 failed [${lang}]:`, result1.reason);

  if (result2.status === 'fulfilled') allQuestions.push(...result2.value);
  else logger.error(`Batch 2 failed [${lang}]:`, result2.reason);

  if (allQuestions.length >= 10) {
    logger.info(`Generated ${allQuestions.length} questions [${lang}] via Sonnet 4.6`);
    return allQuestions;
  }

  logger.error(`Both batches failed [${lang}], using fallback`);
  return getDefaultQuestions(matchData);
}

// ─── Fallback questions (when AI fails) ──────────────────────────────────────
function getDefaultQuestions(matchData: IplMatchData): GeneratedQuestion[] {
  const { team1: t1, team2: t2 } = matchData;
  const sq1 = getSquad(t1);
  const sq2 = getSquad(t2);
  return [
    { question: `🏏 Who will win today — ${t1} or ${t2}?`, options: [`${t1} by runs`, `${t1} by wickets`, `${t2} by runs`, `${t2} by wickets`], correctAnswer: '', points: 100, difficulty: 'easy', category: 'prediction', explanation: 'Updated after match', isPreMatch: true },
    { question: `🎯 Who wins the toss?`, options: [t1, t2, `${t1} (field)`, `${t2} (field)`], correctAnswer: '', points: 50, difficulty: 'easy', category: 'prediction', explanation: 'Updated after toss', isPreMatch: true },
    { question: `🏆 Who will be Man of the Match?`, options: [...pickRandom([...sq1.batters, ...sq1.bowlers], 2), ...pickRandom([...sq2.batters, ...sq2.bowlers], 2)], correctAnswer: '', points: 150, difficulty: 'medium', category: 'prediction', explanation: 'Updated after match', isPreMatch: true },
    { question: `💥 Total sixes in the match?`, options: ['Under 10', '10-15', '16-22', '23+'], correctAnswer: '', points: 120, difficulty: 'medium', category: 'prediction', explanation: 'Updated after match', isPreMatch: true },
    { question: `📊 Total runs combined (both innings)?`, options: ['Under 290', '290-330', '331-370', '371+'], correctAnswer: '', points: 120, difficulty: 'medium', category: 'prediction', explanation: 'Updated after match', isPreMatch: true },
    { question: `⚡ Top scorer of the match?`, options: pickRandom([...sq1.batters, ...sq2.batters], 4), correctAnswer: '', points: 150, difficulty: 'hard', category: 'prediction', explanation: 'Updated after match', isPreMatch: true },
    { question: `🎳 Most wickets in the match?`, options: pickRandom([...sq1.bowlers, ...sq2.bowlers], 4), correctAnswer: '', points: 150, difficulty: 'hard', category: 'prediction', explanation: 'Updated after match', isPreMatch: true },
    { question: `🎯 ${t1} powerplay score (overs 1-6)?`, options: ['Under 40', '40-54', '55-69', '70+'], correctAnswer: '', points: 200, difficulty: 'hard', category: 'prediction', explanation: 'Updated after match', isPreMatch: true },
    { question: `🎯 ${t2} powerplay score (overs 1-6)?`, options: ['Under 40', '40-54', '55-69', '70+'], correctAnswer: '', points: 200, difficulty: 'hard', category: 'prediction', explanation: 'Updated after match', isPreMatch: true },
    { question: `🏅 Winning margin?`, options: ['1-10 runs / 1-3 wkts', '11-30 runs / 4-6 wkts', '31-50 runs / 7-8 wkts', 'Super Over / DLS'], correctAnswer: '', points: 200, difficulty: 'hard', category: 'prediction', explanation: 'Updated after match', isPreMatch: true },
  ];
}

// ─── Legacy exports (used by older admin routes) ──────────────────────────────
export async function generateIPLQuestions(matchData: IplMatchData): Promise<GeneratedQuestion[]> {
  return generateQuestionsWithContext(matchData);
}

export interface MatchResult {
  winner: string;
  manOfMatch?: string;
  topScorer?: string;
  team1Score?: number | string;
  team2Score?: number | string;
}

export async function verifyAnswersWithAI(questions: any[], matchResult: MatchResult): Promise<any[]> {
  try {
    const prompt = `You are verifying IPL prediction contest answers based on the actual match result.

MATCH RESULT:
Winner: ${matchResult.winner}
Man of Match: ${matchResult.manOfMatch || 'Unknown'}
Team 1 Score: ${matchResult.team1Score || 'Unknown'}
Team 2 Score: ${matchResult.team2Score || 'Unknown'}

QUESTIONS TO VERIFY:
${JSON.stringify(questions.map(q => ({ id: q.id, question: q.question, options: q.options, correctAnswer: q.correctAnswer })), null, 2)}

For each question, pick the correct answer from the OPTIONS provided, based ONLY on the match result above.
- correctAnswer MUST exactly match one of the given options (copy exactly)
- confidence: 0.95 = certain, 0.80 = fairly sure, 0.50 = guessing
- If the match result doesn't have enough info to answer, set correctAnswer to "" and confidence to 0

Return ONLY a valid JSON array:
[{"questionId":"xxx","correctAnswer":"option text","confidence":0.95,"reason":"brief reason"}]`;

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return questions;

    const verified = JSON.parse(jsonMatch[0]) as Array<{ questionId: string; correctAnswer: string; confidence: number; reason: string }>;
    return questions.map(q => {
      const v = verified.find(r => r.questionId === q.id);
      if (!v || v.confidence < 0.85) return q;
      return { ...q, correctAnswer: v.correctAnswer, claudeConfidence: v.confidence };
    });
  } catch (err) {
    logger.error('verifyAnswersWithAI error:', err);
    return questions;
  }
}
