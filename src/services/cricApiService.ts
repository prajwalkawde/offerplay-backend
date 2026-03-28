import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const cricbuzzApi = axios.create({
  baseURL: `https://${env.RAPIDAPI_HOST}`,
  headers: {
    'x-rapidapi-key': env.RAPIDAPI_KEY,
    'x-rapidapi-host': env.RAPIDAPI_HOST,
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});

function extractIPLMatches(typeMatches: any[]): any[] {
  const iplMatches: any[] = [];
  typeMatches.forEach((type: any) => {
    type.seriesMatches?.forEach((series: any) => {
      const seriesName: string = series.seriesAdWrapper?.seriesName || '';
      if (
        seriesName.toLowerCase().includes('ipl') ||
        seriesName.toLowerCase().includes('indian premier')
      ) {
        series.seriesAdWrapper?.matches?.forEach((match: any) => {
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

export async function getLiveMatches(): Promise<any[]> {
  try {
    const response = await cricbuzzApi.get('/matches/v1/live');
    return extractIPLMatches(response.data?.typeMatches || []);
  } catch (error) {
    logger.error('getLiveMatches error:', error);
    return [];
  }
}

export async function getUpcomingMatches(): Promise<any[]> {
  try {
    const response = await cricbuzzApi.get('/matches/v1/upcoming');
    return extractIPLMatches(response.data?.typeMatches || []);
  } catch (error) {
    logger.error('getUpcomingMatches error:', error);
    return [];
  }
}

export async function getMatchScore(matchId: string): Promise<any> {
  try {
    const response = await cricbuzzApi.get(`/mcenter/v1/${matchId}/hscard`);
    return response.data;
  } catch (error) {
    logger.error('getMatchScore error:', error);
    return null;
  }
}

export async function getMatchDetails(matchId: string): Promise<any> {
  try {
    const response = await cricbuzzApi.get(`/mcenter/v1/${matchId}`);
    return response.data;
  } catch (error) {
    logger.error('getMatchDetails error:', error);
    return null;
  }
}

export async function getTodayIPLMatches(): Promise<any[]> {
  try {
    const [live, upcoming] = await Promise.all([getLiveMatches(), getUpcomingMatches()]);

    const today = new Date().toDateString();
    const todayUpcoming = upcoming.filter((m: any) => {
      if (!m.startTime) return false;
      return new Date(parseInt(m.startTime)).toDateString() === today;
    });

    return [...live, ...todayUpcoming];
  } catch (error) {
    logger.error('getTodayIPLMatches error:', error);
    return [];
  }
}

export async function getIPLSeriesMatches(seriesId: string): Promise<any> {
  try {
    const response = await cricbuzzApi.get(`/series/v1/${seriesId}/matches`);
    return response.data;
  } catch (error) {
    logger.error('getIPLSeriesMatches error:', error);
    return null;
  }
}

// ─── Legacy alias used by iplQuizJob ──────────────────────────────────────────
export const getTodayMatches = getTodayIPLMatches;
