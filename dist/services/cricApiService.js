"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTodayMatches = void 0;
exports.getLiveMatches = getLiveMatches;
exports.getUpcomingMatches = getUpcomingMatches;
exports.getMatchScore = getMatchScore;
exports.getMatchDetails = getMatchDetails;
exports.getTodayIPLMatches = getTodayIPLMatches;
exports.getIPLSeriesMatches = getIPLSeriesMatches;
const axios_1 = __importDefault(require("axios"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const cricbuzzApi = axios_1.default.create({
    baseURL: `https://${env_1.env.RAPIDAPI_HOST}`,
    headers: {
        'x-rapidapi-key': env_1.env.RAPIDAPI_KEY,
        'x-rapidapi-host': env_1.env.RAPIDAPI_HOST,
        'Content-Type': 'application/json',
    },
    timeout: 10000,
});
function extractIPLMatches(typeMatches) {
    const iplMatches = [];
    typeMatches.forEach((type) => {
        type.seriesMatches?.forEach((series) => {
            const seriesName = series.seriesAdWrapper?.seriesName || '';
            if (seriesName.toLowerCase().includes('ipl') ||
                seriesName.toLowerCase().includes('indian premier')) {
                series.seriesAdWrapper?.matches?.forEach((match) => {
                    iplMatches.push({
                        id: match.matchInfo?.matchId,
                        team1: match.matchInfo?.team1?.teamName,
                        team2: match.matchInfo?.team2?.teamName,
                        team1Short: match.matchInfo?.team1?.teamSName,
                        team2Short: match.matchInfo?.team2?.teamSName,
                        status: match.matchInfo?.state,
                        venue: match.matchInfo?.venueInfo?.ground,
                        city: match.matchInfo?.venueInfo?.city,
                        matchDesc: match.matchInfo?.matchDesc,
                        startTime: match.matchInfo?.startDate,
                        seriesName,
                    });
                });
            }
        });
    });
    return iplMatches;
}
async function getLiveMatches() {
    try {
        const response = await cricbuzzApi.get('/matches/v1/live');
        return extractIPLMatches(response.data?.typeMatches || []);
    }
    catch (error) {
        logger_1.logger.error('getLiveMatches error:', error);
        return [];
    }
}
async function getUpcomingMatches() {
    try {
        const response = await cricbuzzApi.get('/matches/v1/upcoming');
        return extractIPLMatches(response.data?.typeMatches || []);
    }
    catch (error) {
        logger_1.logger.error('getUpcomingMatches error:', error);
        return [];
    }
}
async function getMatchScore(matchId) {
    try {
        const response = await cricbuzzApi.get(`/mcenter/v1/${matchId}/hscard`);
        return response.data;
    }
    catch (error) {
        logger_1.logger.error('getMatchScore error:', error);
        return null;
    }
}
async function getMatchDetails(matchId) {
    try {
        const response = await cricbuzzApi.get(`/mcenter/v1/${matchId}`);
        return response.data;
    }
    catch (error) {
        logger_1.logger.error('getMatchDetails error:', error);
        return null;
    }
}
async function getTodayIPLMatches() {
    try {
        const [live, upcoming] = await Promise.all([getLiveMatches(), getUpcomingMatches()]);
        const today = new Date().toDateString();
        const todayUpcoming = upcoming.filter((m) => {
            if (!m.startTime)
                return false;
            return new Date(parseInt(m.startTime)).toDateString() === today;
        });
        return [...live, ...todayUpcoming];
    }
    catch (error) {
        logger_1.logger.error('getTodayIPLMatches error:', error);
        return [];
    }
}
async function getIPLSeriesMatches(seriesId) {
    try {
        const response = await cricbuzzApi.get(`/series/v1/${seriesId}/matches`);
        return response.data;
    }
    catch (error) {
        logger_1.logger.error('getIPLSeriesMatches error:', error);
        return null;
    }
}
// ─── Legacy alias used by iplQuizJob ──────────────────────────────────────────
exports.getTodayMatches = getTodayIPLMatches;
