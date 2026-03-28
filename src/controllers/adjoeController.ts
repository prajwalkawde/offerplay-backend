import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { updateQuestProgress } from './questController';
import { logger } from '../utils/logger';
import { TransactionType } from '@prisma/client';

// GET /api/adjoe/postback  — called by adjoe servers (no auth)
export const handleAdjoePostback = async (req: Request, res: Response) => {
  try {
    const {
      user_id,
      session_id,
      minutes,
      game_id,
      game_name,
    } = req.query as Record<string, string>;

    if (!user_id || !session_id) {
      return res.status(400).send('Bad Request');
    }

    // Idempotency check
    const existingSession = await prisma.adjoeSession.findUnique({
      where: { sessionId: String(session_id) },
    });
    if (existingSession?.status === 'credited') {
      logger.warn('adjoe duplicate postback:', session_id);
      return res.send('OK');
    }

    const userId       = String(user_id);
    const minutesPlayed = parseInt(String(minutes || '0'), 10) || 0;

    // 5 min = 1 ticket; 1 min = 2 bonus coins
    const ticketsEarned = Math.floor(minutesPlayed / 5);
    const coinsBonus    = minutesPlayed * 2;

    if (ticketsEarned > 0 || coinsBonus > 0) {
      await prisma.$transaction(async tx => {
        if (ticketsEarned > 0) {
          await tx.user.update({
            where: { id: userId },
            data:  { ticketBalance: { increment: ticketsEarned } },
          });
          await tx.ticketTransaction.create({
            data: {
              userId,
              amount:      ticketsEarned,
              type:        'EARN_TICKET',
              refId:       String(session_id),
              description: `adjoe: ${game_name || 'game'} - ${minutesPlayed} min`,
            },
          }).catch(() => {});
        }

        if (coinsBonus > 0) {
          await tx.user.update({
            where: { id: userId },
            data:  { coinBalance: { increment: coinsBonus } },
          });
          await tx.transaction.create({
            data: {
              userId,
              type:        TransactionType.ADJOE_BONUS,
              amount:      coinsBonus,
              description: `adjoe coins: ${game_name || 'game'}`,
              status:      'completed',
              refId:       String(session_id),
            },
          });
        }

        await tx.adjoeSession.upsert({
          where:  { sessionId: String(session_id) },
          update: {
            minutesPlayed,
            ticketsEarned,
            coinsEarned: coinsBonus,
            status:      'credited',
            endedAt:     new Date(),
          },
          create: {
            userId,
            sessionId:    String(session_id),
            gameId:       String(game_id   || ''),
            gameName:     String(game_name || ''),
            minutesPlayed,
            ticketsEarned,
            coinsEarned:  coinsBonus,
            status:       'credited',
          },
        });
      });

      await updateQuestProgress(userId, 'PLAY_MINUTES', minutesPlayed);

      logger.info(
        `adjoe credited: ${userId} - ${minutesPlayed}min → ${ticketsEarned} tickets + ${coinsBonus} coins`,
      );
    }

    return res.send('OK');
  } catch (err) {
    logger.error('adjoe postback error:', err);
    return res.status(500).send('ERROR');
  }
};

// GET /api/adjoe/stats  — authenticated user
export const getAdjoeStats = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const today  = new Date(); today.setHours(0, 0, 0, 0);

    const [todaySessions, allSessions] = await Promise.all([
      prisma.adjoeSession.findMany({ where: { userId, startedAt: { gte: today } } }),
      prisma.adjoeSession.aggregate({
        where: { userId },
        _sum: { minutesPlayed: true, ticketsEarned: true, coinsEarned: true },
      }),
    ]);

    const todayMinutes = todaySessions.reduce((s, sess) => s + sess.minutesPlayed, 0);
    const todayTickets = todaySessions.reduce((s, sess) => s + sess.ticketsEarned, 0);

    return res.json({
      success: true,
      data: {
        today: {
          minutes:          todayMinutes,
          tickets:          todayTickets,
          dailyLimitMinutes: 30,
          remainingMinutes:  Math.max(0, 30 - todayMinutes),
        },
        allTime: {
          minutes: allSessions._sum.minutesPlayed || 0,
          tickets: allSessions._sum.ticketsEarned || 0,
          coins:   allSessions._sum.coinsEarned   || 0,
        },
      },
    });
  } catch (err) {
    return res.json({ success: false });
  }
};
