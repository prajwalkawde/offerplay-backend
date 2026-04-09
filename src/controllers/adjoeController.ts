import { Request, Response } from 'express';
import { createHash } from 'crypto';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { creditTickets } from '../services/ticketService';
import { updateQuestProgress } from './questController';

const S2S_TOKEN = 'unucagmxxbpiwtwifyjhvwzudmqxcwkz';

// ─── SID verification ────────────────────────────────────────────────────────
// sid = sha1(trans_uuid + user_uuid + currency + coin_amount + device_id + sdk_app_id + s2s_token)
// Missing optional params are simply omitted (not replaced with empty string).
function verifySid(params: {
  trans_uuid: string;
  user_uuid:  string;
  currency:   string;
  coin_amount: string;
  device_id?:  string;
  sdk_app_id?: string;
  sid:         string;
}): boolean {
  const parts = [
    params.trans_uuid,
    params.user_uuid,
    params.currency,
    params.coin_amount,
    params.device_id,
    params.sdk_app_id,
    S2S_TOKEN,
  ].filter(Boolean) as string[];

  const expected = createHash('sha1').update(parts.join('')).digest('hex');
  return expected === params.sid;
}

// ─── GET /api/adjoe/postback  — called by adjoe servers (no auth) ─────────────
export const handleAdjoePostback = async (req: Request, res: Response) => {
  try {
    const {
      user_uuid,
      trans_uuid,
      coin_amount,
      currency,
      sid,
      device_id,
      sdk_app_id,
      app_id,
      app_name,
      reward_type,
    } = req.query as Record<string, string>;

    // app_id and sdk_app_id are both used by Adjoe in different contexts
    const resolvedAppId = sdk_app_id || app_id;

    // ── Required param check ──────────────────────────────────────────────────
    if (!user_uuid || !trans_uuid || !coin_amount || !currency || !sid) {
      logger.warn('[Adjoe] postback missing required params', req.query);
      return res.status(400).send('Bad Request');
    }

    // ── SID verification ──────────────────────────────────────────────────────
    const sidValid = verifySid({ trans_uuid, user_uuid, currency, coin_amount, device_id, sdk_app_id: resolvedAppId, sid });
    if (!sidValid) {
      logger.warn('[Adjoe] invalid SID for user:', user_uuid, 'trans:', trans_uuid);
      return res.status(403).send('Forbidden');
    }

    // ── Idempotency — trans_uuid must be unique ───────────────────────────────
    const existing = await prisma.adjoeSession.findUnique({
      where: { sessionId: trans_uuid },
    });
    if (existing?.status === 'credited') {
      logger.warn('[Adjoe] duplicate trans_uuid:', trans_uuid);
      return res.status(200).send('OK'); // must return 200 so adjoe stops retrying
    }

    // ── Find user ─────────────────────────────────────────────────────────────
    const user = await prisma.user.findUnique({ where: { id: user_uuid }, select: { id: true } });
    if (!user) {
      logger.warn('[Adjoe] user not found:', user_uuid);
      return res.status(404).send('User not found');
    }

    const ticketsToCredit = parseInt(coin_amount, 10);
    if (isNaN(ticketsToCredit) || ticketsToCredit <= 0) {
      return res.status(400).send('Invalid coin_amount');
    }

    // ── Credit tickets ────────────────────────────────────────────────────────
    await creditTickets(
      user_uuid,
      ticketsToCredit,
      `Adjoe reward: ${app_name || reward_type || 'game'} (${currency})`,
      `adjoe_${trans_uuid}`,
    );

    // ── Record session ────────────────────────────────────────────────────────
    await prisma.adjoeSession.upsert({
      where:  { sessionId: trans_uuid },
      update: { ticketsEarned: ticketsToCredit, status: 'credited', endedAt: new Date() },
      create: {
        userId:        user_uuid,
        sessionId:     trans_uuid,
        gameId:        resolvedAppId || '',
        gameName:      app_name      || reward_type || '',
        minutesPlayed: 0,
        ticketsEarned: ticketsToCredit,
        coinsEarned:   0,
        status:        'credited',
      },
    });

    logger.info(`[Adjoe] credited ${ticketsToCredit} tickets → user ${user_uuid} (trans: ${trans_uuid})`);
    updateQuestProgress(user_uuid, 'PLAY_GAMES', 1).catch(() => {});
    return res.status(200).send('OK');

  } catch (err) {
    logger.error('[Adjoe] postback error:', err);
    return res.status(500).send('ERROR');
  }
};

// ─── GET /api/adjoe/stats  — authenticated user ───────────────────────────────
export const getAdjoeStats = async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    const today  = new Date(); today.setHours(0, 0, 0, 0);

    const [todaySessions, allSessions] = await Promise.all([
      prisma.adjoeSession.findMany({ where: { userId, startedAt: { gte: today }, status: 'credited' } }),
      prisma.adjoeSession.aggregate({
        where: { userId, status: 'credited' },
        _sum:  { ticketsEarned: true, coinsEarned: true },
      }),
    ]);

    const todayTickets = todaySessions.reduce((s, sess) => s + sess.ticketsEarned, 0);

    return res.json({
      success: true,
      data: {
        today: {
          tickets: todayTickets,
        },
        allTime: {
          tickets: allSessions._sum.ticketsEarned || 0,
          coins:   allSessions._sum.coinsEarned   || 0,
        },
      },
    });
  } catch (err) {
    return res.json({ success: false });
  }
};
