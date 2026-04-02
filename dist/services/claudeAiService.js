"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateIPLQuestions = generateIPLQuestions;
exports.verifyAnswersWithAI = verifyAnswersWithAI;
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const claude = new sdk_1.default({ apiKey: env_1.env.ANTHROPIC_API_KEY });
async function generateIPLQuestions(matchData) {
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
        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch)
            throw new Error('No JSON array found in Claude response');
        return JSON.parse(jsonMatch[0]);
    }
    catch (err) {
        logger_1.logger.error('Claude AI generateIPLQuestions error:', err);
        return getDefaultQuestions(matchData);
    }
}
function getDefaultQuestions(matchData) {
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
async function verifyAnswersWithAI(questions, matchResult) {
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
        const text = response.content[0].type === 'text' ? response.content[0].text : '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch)
            return questions;
        return JSON.parse(jsonMatch[0]);
    }
    catch (err) {
        logger_1.logger.error('Claude AI verifyAnswersWithAI error:', err);
        return questions;
    }
}
