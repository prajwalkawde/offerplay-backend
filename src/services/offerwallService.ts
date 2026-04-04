import { prisma } from '../config/database';
import { creditCoins } from './coinService';
import { TransactionType } from '@prisma/client';
import { timingSafeEqual, hmacSha256 } from '../utils/crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { updateQuestProgress } from '../controllers/questController';

export interface PostbackPayload {
  userId: string;
  offerId: string;
  coins: number;
  provider: string;
  rawData?: Record<string, string>;
}

export async function verifyPubscaleSignature(
  query: Record<string, string>,
  sig: string
): Promise<boolean> {
  // Pubscale sends HMAC-SHA256 of sorted query params
  const sorted = Object.keys(query)
    .filter((k) => k !== 'sig')
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&');
  const expected = hmacSha256(env.PUBSCALE_SECRET, sorted);
  return timingSafeEqual(expected, sig);
}

export async function verifyToroxSignature(
  userId: string,
  offerId: string,
  coins: string,
  sig: string
): Promise<boolean> {
  const data = `${userId}${offerId}${coins}`;
  const expected = hmacSha256(env.TOROX_SECRET, data);
  return timingSafeEqual(expected, sig);
}

export async function verifyAyetSignature(
  query: Record<string, string>,
  sig: string
): Promise<boolean> {
  const sorted = Object.keys(query)
    .filter((k) => k !== 'signature')
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join('&');
  const expected = hmacSha256(env.AYETSTUDIO_SECRET, sorted);
  return timingSafeEqual(expected, sig);
}

export async function processPostback(payload: PostbackPayload): Promise<{ duplicate: boolean }> {
  // Idempotency check
  const existing = await prisma.offerwallLog.findUnique({ where: { offerId: payload.offerId } });
  if (existing) {
    logger.debug('Duplicate postback', { offerId: payload.offerId, provider: payload.provider });
    return { duplicate: true };
  }

  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user) throw new Error('User not found');

  await prisma.$transaction([
    prisma.offerwallLog.create({
      data: {
        userId: payload.userId,
        provider: payload.provider,
        offerId: payload.offerId,
        coinsAwarded: payload.coins,
        rawData: payload.rawData ?? {},
      },
    }),
  ]);

  await creditCoins(
    payload.userId,
    payload.coins,
    TransactionType.EARN_OFFERWALL,
    payload.offerId,
    `${payload.provider} offer completed`
  );

  // Credit quest progress for offer completion
  await updateQuestProgress(payload.userId, 'COMPLETE_OFFERS', 1);

  // Bonus: 1 free ticket per completed offer
  const bonusTickets = 1;
  await prisma.user.update({
    where: { id: payload.userId },
    data:  { ticketBalance: { increment: bonusTickets } },
  });
  await prisma.ticketTransaction.create({
    data: {
      userId:      payload.userId,
      amount:      bonusTickets,
      type:        'EARN_TICKET',
      refId:       payload.offerId,
      description: `Offer bonus ticket: ${payload.provider}`,
    },
  }).catch(() => {});

  logger.info('Postback processed', {
    userId: payload.userId,
    provider: payload.provider,
    coins: payload.coins,
    bonusTickets,
  });

  return { duplicate: false };
}
