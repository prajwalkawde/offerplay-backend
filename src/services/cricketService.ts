import axios from 'axios';
import { prisma } from '../config/database';
import { getRedisClient, rk } from '../config/redis';
import { logger } from '../utils/logger';

const CRICAPI_BASE = 'https://api.cricapi.com/v1';
const API_KEY = process.env.CRICAPI_KEY || '';
const DAILY_LIMIT = 100;

// ─── Rate limit tracking ──────────────────────────────────────────────────────
async function checkRateLimit(): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const today = new Date().toISOString().slice(0, 10);
    const key = rk(`cricapi:usage:${today}`);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 86400);
    if (count > DAILY_LIMIT) {
      logger.warn(`CricAPI daily limit reached (${count}/${DAILY_LIMIT})`);
      return false;
    }
    return true;
  } catch {
    return true; // allow if Redis down
  }
}

async function logAutomation(jobType: string, status: string, message: string, matchId?: string, data?: any) {
  try {
    await prisma.automationLog.create({
      data: { jobType, status, message, matchId, data },
    });
  } catch { /* non-critical */ }
}

// ─── Generic API call with retry ─────────────────────────────────────────────
async function callCricAPI(endpoint: string, params: Record<string, string> = {}): Promise<any> {
  if (!API_KEY) {
    logger.warn('CRICAPI_KEY not set');
    return null;
  }
  if (!(await checkRateLimit())) return null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(`${CRICAPI_BASE}/${endpoint}`, {
        params: { apikey: API_KEY, ...params },
        timeout: 10000,
      });
      return res.data;
    } catch (err: any) {
      logger.warn(`CricAPI attempt ${attempt} failed for ${endpoint}:`, err.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
  return null;
}

// ─── Fetch IPL series schedule ────────────────────────────────────────────────
export async function fetchIPLSeriesSchedule(seriesId: string): Promise<any[]> {
  const data = await callCricAPI('series_info', { id: seriesId });
  if (!data?.data?.matchList) return [];

  const matches = data.data.matchList.filter((m: any) =>
    m.name?.toLowerCase().includes('ipl') ||
    m.series_id === seriesId
  );

  await logAutomation('SCHEDULE_SYNC', 'SUCCESS', `Fetched ${matches.length} matches from CricAPI`);
  return matches;
}

// ─── Fetch today's IPL matches from CricAPI ───────────────────────────────────
export async function fetchTodayMatchesCricAPI(): Promise<any[]> {
  const data = await callCricAPI('matches', { offset: '0' });
  if (!data?.data) return [];

  const today = new Date().toDateString();
  const ipl = data.data.filter((m: any) => {
    const isIPL = m.series_id && (
      m.name?.toLowerCase().includes('ipl') ||
      m.matchType?.toLowerCase() === 't20'
    );
    const isToday = m.date && new Date(m.date).toDateString() === today;
    return isIPL && isToday;
  });

  return ipl;
}

// ─── Fetch playing XI for a match ────────────────────────────────────────────
export async function fetchPlayingXI(cricApiMatchId: string): Promise<{ team1: string[]; team2: string[] } | null> {
  const data = await callCricAPI('match_info', { id: cricApiMatchId });
  if (!data?.data) return null;

  const matchData = data.data;
  const team1 = matchData.players?.filter((p: any) => p.team === matchData.teamInfo?.[0]?.name)
    .map((p: any) => p.name) || [];
  const team2 = matchData.players?.filter((p: any) => p.team === matchData.teamInfo?.[1]?.name)
    .map((p: any) => p.name) || [];

  return { team1, team2 };
}

// ─── Fetch live score ─────────────────────────────────────────────────────────
export async function fetchLiveScore(cricApiMatchId: string): Promise<{ team1Score: string; team2Score: string; status: string } | null> {
  const data = await callCricAPI('match_info', { id: cricApiMatchId });
  if (!data?.data) return null;

  const m = data.data;
  return {
    team1Score: m.score?.[0] ? `${m.score[0].r}/${m.score[0].w} (${m.score[0].o})` : '',
    team2Score: m.score?.[1] ? `${m.score[1].r}/${m.score[1].w} (${m.score[1].o})` : '',
    status: m.status || '',
  };
}

// ─── Check if match has ended ─────────────────────────────────────────────────
export async function isMatchEnded(cricApiMatchId: string): Promise<boolean> {
  const data = await callCricAPI('match_info', { id: cricApiMatchId });
  return data?.data?.matchEnded === true || data?.data?.status?.toLowerCase().includes('won') || false;
}

// ─── Fetch full scorecard ─────────────────────────────────────────────────────
export async function fetchMatchScorecard(cricApiMatchId: string): Promise<any> {
  const data = await callCricAPI('match_scorecard', { id: cricApiMatchId });
  return data?.data || null;
}
