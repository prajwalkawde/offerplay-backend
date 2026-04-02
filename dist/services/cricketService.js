"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchIPLSeriesSchedule = fetchIPLSeriesSchedule;
exports.fetchTodayMatchesCricAPI = fetchTodayMatchesCricAPI;
exports.fetchPlayingXI = fetchPlayingXI;
exports.fetchLiveScore = fetchLiveScore;
exports.isMatchEnded = isMatchEnded;
exports.fetchMatchScorecard = fetchMatchScorecard;
const axios_1 = __importDefault(require("axios"));
const database_1 = require("../config/database");
const redis_1 = require("../config/redis");
const logger_1 = require("../utils/logger");
const CRICAPI_BASE = 'https://api.cricapi.com/v1';
const API_KEY = process.env.CRICAPI_KEY || '';
const DAILY_LIMIT = 100;
// ─── Rate limit tracking ──────────────────────────────────────────────────────
async function checkRateLimit() {
    try {
        const redis = (0, redis_1.getRedisClient)();
        const today = new Date().toISOString().slice(0, 10);
        const key = (0, redis_1.rk)(`cricapi:usage:${today}`);
        const count = await redis.incr(key);
        if (count === 1)
            await redis.expire(key, 86400);
        if (count > DAILY_LIMIT) {
            logger_1.logger.warn(`CricAPI daily limit reached (${count}/${DAILY_LIMIT})`);
            return false;
        }
        return true;
    }
    catch {
        return true; // allow if Redis down
    }
}
async function logAutomation(jobType, status, message, matchId, data) {
    try {
        await database_1.prisma.automationLog.create({
            data: { jobType, status, message, matchId, data },
        });
    }
    catch { /* non-critical */ }
}
// ─── Generic API call with retry ─────────────────────────────────────────────
async function callCricAPI(endpoint, params = {}) {
    if (!API_KEY) {
        logger_1.logger.warn('CRICAPI_KEY not set');
        return null;
    }
    if (!(await checkRateLimit()))
        return null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await axios_1.default.get(`${CRICAPI_BASE}/${endpoint}`, {
                params: { apikey: API_KEY, ...params },
                timeout: 10000,
            });
            return res.data;
        }
        catch (err) {
            logger_1.logger.warn(`CricAPI attempt ${attempt} failed for ${endpoint}:`, err.message);
            if (attempt < 3)
                await new Promise(r => setTimeout(r, attempt * 2000));
        }
    }
    return null;
}
// ─── Fetch IPL series schedule ────────────────────────────────────────────────
async function fetchIPLSeriesSchedule(seriesId) {
    const data = await callCricAPI('series_info', { id: seriesId });
    if (!data?.data?.matchList)
        return [];
    const matches = data.data.matchList.filter((m) => m.name?.toLowerCase().includes('ipl') ||
        m.series_id === seriesId);
    await logAutomation('SCHEDULE_SYNC', 'SUCCESS', `Fetched ${matches.length} matches from CricAPI`);
    return matches;
}
// ─── Fetch today's IPL matches from CricAPI ───────────────────────────────────
async function fetchTodayMatchesCricAPI() {
    const data = await callCricAPI('matches', { offset: '0' });
    if (!data?.data)
        return [];
    const today = new Date().toDateString();
    const ipl = data.data.filter((m) => {
        const isIPL = m.series_id && (m.name?.toLowerCase().includes('ipl') ||
            m.matchType?.toLowerCase() === 't20');
        const isToday = m.date && new Date(m.date).toDateString() === today;
        return isIPL && isToday;
    });
    return ipl;
}
// ─── Fetch playing XI for a match ────────────────────────────────────────────
async function fetchPlayingXI(cricApiMatchId) {
    const data = await callCricAPI('match_info', { id: cricApiMatchId });
    if (!data?.data)
        return null;
    const matchData = data.data;
    const team1 = matchData.players?.filter((p) => p.team === matchData.teamInfo?.[0]?.name)
        .map((p) => p.name) || [];
    const team2 = matchData.players?.filter((p) => p.team === matchData.teamInfo?.[1]?.name)
        .map((p) => p.name) || [];
    return { team1, team2 };
}
// ─── Fetch live score ─────────────────────────────────────────────────────────
async function fetchLiveScore(cricApiMatchId) {
    const data = await callCricAPI('match_info', { id: cricApiMatchId });
    if (!data?.data)
        return null;
    const m = data.data;
    return {
        team1Score: m.score?.[0] ? `${m.score[0].r}/${m.score[0].w} (${m.score[0].o})` : '',
        team2Score: m.score?.[1] ? `${m.score[1].r}/${m.score[1].w} (${m.score[1].o})` : '',
        status: m.status || '',
    };
}
// ─── Check if match has ended ─────────────────────────────────────────────────
async function isMatchEnded(cricApiMatchId) {
    const data = await callCricAPI('match_info', { id: cricApiMatchId });
    return data?.data?.matchEnded === true || data?.data?.status?.toLowerCase().includes('won') || false;
}
// ─── Fetch full scorecard ─────────────────────────────────────────────────────
async function fetchMatchScorecard(cricApiMatchId) {
    const data = await callCricAPI('match_scorecard', { id: cricApiMatchId });
    return data?.data || null;
}
