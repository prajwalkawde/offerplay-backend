import axios from 'axios';
import crypto from 'crypto';
import { TransactionType } from '@prisma/client';
import { redis } from '../config/redis';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { updateQuestProgress } from '../controllers/questController';

// ─── Get surveys for user ─────────────────────────────────────────────────────
export const getCPXSurveys = async (
  userId: string,
  userEmail?: string,
  userIp?: string,
): Promise<any[]> => {
  try {
    if (!env.CPX_APP_ID) return getMockSurveys();

    const cacheKey = `cpx_surveys:${userId}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const hash = crypto
      .createHash('md5')
      .update(`${userId}-${env.CPX_SECURE_HASH}`)
      .digest('hex');

    const response = await axios.get(
      'https://live-api.cpx-research.com/api/get-surveys.php',
      {
        params: {
          app_id: env.CPX_APP_ID,
          ext_user_id: userId,
          secure_hash: hash,
          output_method: 'api',
          email: userEmail || '',
          subid_1: userId,
          ip_user: userIp || '',
        },
        timeout: 10000,
      }
    );

    const surveys = response.data?.surveys || [];
    const normalized = surveys.map((s: any) => normalizeCPXSurvey(s));

    await redis.setex(cacheKey, 600, JSON.stringify(normalized));
    logger.info(`CPX Research: ${normalized.length} surveys for user ${userId}`);
    return normalized;
  } catch (err) {
    logger.error('CPX surveys error:', err);
    return getMockSurveys();
  }
};

// ─── Normalize CPX survey ─────────────────────────────────────────────────────
const normalizeCPXSurvey = (s: any): any => {
  // CPX returns payout_publisher_usd for actual USD revenue
  const payoutUsd = parseFloat(s.payout_publisher_usd || '0');
  const coinsReward = Math.round(payoutUsd * 1000);
  const category = s.category || 'General';
  const loiMinutes = parseInt(s.loi || '5');
  return {
    provider: 'cpx',
    surveyId: String(s.id || ''),
    name: category ? `${category} Survey` : `Survey #${s.id}`,
    topic: category,
    desc: `Complete a ${loiMinutes}-minute survey and earn coins`,
    estimatedTime: `${loiMinutes} min`,
    loiMinutes,
    coins: coinsReward,
    payoutUsd,
    isHighValue: payoutUsd >= 1.0,
    conversionRate: parseFloat(s.conversion_rate || '0'),
    qualityScore: parseInt(s.quality_score || '0'),
    ratingAvg: parseFloat(s.statistics_rating_avg || '0'),
    ratingCount: parseInt(s.statistics_rating_count || '0'),
    isTestSurvey: Boolean(s.istestsurvey),
    category,
    language: 'en',
    status: 'active',
    startUrl: s.href_new || s.href || '',
    colorStrip: getRandomColor(s.id),
  };
};

const getRandomColor = (id: any): string => {
  const colors = ['#7B2FBE', '#00D4FF', '#FFD700', '#00FF88', '#FF6B35'];
  return colors[parseInt(id || '0') % colors.length];
};

// ─── Survey wall URL ──────────────────────────────────────────────────────────
export const getCPXSurveyWallUrl = (userId: string, userEmail?: string): string => {
  if (!env.CPX_APP_ID) return '';

  const hash = crypto
    .createHash('md5')
    .update(`${userId}-${env.CPX_SECURE_HASH}`)
    .digest('hex');

  const params = new URLSearchParams({
    app_id: env.CPX_APP_ID,
    ext_user_id: userId,
    secure_hash: hash,
    email: userEmail || '',
    subid_1: userId,
  });

  return `https://offers.cpx-research.com/index.php?${params.toString()}`;
};

// ─── CPX postback handler ─────────────────────────────────────────────────────
export const handleCPXPostback = async (params: any): Promise<string> => {
  logger.info('CPX Research postback received', params);

  const {
    ext_user_id: userId,
    transaction_id: transactionId,
    payout,
    status,
    hash,
  } = params;

  // Verify hash: md5(transaction_id + "-" + secure_hash)
  const expectedHash = crypto
    .createHash('md5')
    .update(`${transactionId}-${env.CPX_SECURE_HASH}`)
    .digest('hex');

  if (hash && hash !== expectedHash) {
    logger.warn('CPX invalid hash', { hash, expectedHash });
    return '1';
  }

  if (status !== '1' && status !== 1) {
    logger.info('CPX survey not completed, status:', status);
    return '1';
  }

  const existing = await prisma.offerwallLog.findFirst({
    where: { offerId: String(transactionId), provider: 'cpx' },
  });
  if (existing) return '1';

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    logger.warn('CPX user not found:', userId);
    return '1';
  }

  const payoutUsd = parseFloat(payout || '0');
  const coins = Math.round(payoutUsd * 1000);
  if (coins <= 0) return '1';

  const streak = await prisma.userStreak.findUnique({ where: { userId } });
  const multiplier = streak?.multiplier || 1.0;
  const finalCoins = Math.round(coins * multiplier);

  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { coinBalance: { increment: finalCoins } },
      });
      await tx.transaction.create({
        data: {
          userId,
          type: TransactionType.EARN_SURVEY,
          amount: finalCoins,
          refId: String(transactionId),
          description: `CPX Survey completed${multiplier > 1 ? ` (${multiplier}x streak)` : ''}`,
        },
      });
      await tx.offerwallLog.create({
        data: {
          userId,
          provider: 'cpx',
          offerId: String(transactionId),
          coinsAwarded: finalCoins,
          rawData: params,
        },
      });
      await tx.notification.create({
        data: {
          userId,
          title: 'Survey Completed!',
          body: `You earned ${finalCoins} coins from a survey!${multiplier > 1 ? ` (${multiplier}x streak bonus)` : ''}`,
          type: 'COIN_EARNED',
        },
      });
    });

    const { updateStreak } = await import('./postbackService');
    await updateStreak(userId);
    await updateQuestProgress(userId, 'COMPLETE_SURVEYS', 1);

    logger.info('CPX coins credited', { userId, finalCoins, multiplier });
    return '1';
  } catch (err) {
    logger.error('CPX postback processing failed:', err);
    return '1';
  }
};

// ─── Mock surveys (when API not configured) ───────────────────────────────────
export const getMockSurveys = (): any[] => [
  {
    provider: 'cpx', surveyId: 'mock_s1', name: 'Shopping Habits Survey',
    topic: 'Consumer Behavior', desc: 'Share your online shopping preferences',
    estimatedTime: '5 min', loiMinutes: 5, coins: 80, payoutUsd: 0.08,
    isHighValue: false, slotsAvailable: 23, totalSlots: 50, completedSlots: 27,
    category: 'Shopping', language: 'en', status: 'active', startUrl: '#',
    colorStrip: '#7B2FBE', isMock: true,
  },
  {
    provider: 'cpx', surveyId: 'mock_s2', name: 'Tech Product Usage',
    topic: 'Technology', desc: 'Tell us about your smartphone usage',
    estimatedTime: '3 min', loiMinutes: 3, coins: 50, payoutUsd: 0.05,
    isHighValue: false, slotsAvailable: 45, totalSlots: 50, completedSlots: 5,
    category: 'Technology', language: 'en', status: 'active', startUrl: '#',
    colorStrip: '#00D4FF', isMock: true,
  },
  {
    provider: 'cpx', surveyId: 'mock_s3', name: 'Food Delivery Experience',
    topic: 'Food & Dining', desc: 'Rate your food delivery app experience',
    estimatedTime: '8 min', loiMinutes: 8, coins: 120, payoutUsd: 0.12,
    isHighValue: true, slotsAvailable: 12, totalSlots: 50, completedSlots: 38,
    category: 'Food', language: 'en', status: 'active', startUrl: '#',
    colorStrip: '#FFD700', isMock: true,
  },
  {
    provider: 'cpx', surveyId: 'mock_s4', name: 'Entertainment Survey',
    topic: 'Media & Entertainment', desc: 'What streaming platforms do you use?',
    estimatedTime: '6 min', loiMinutes: 6, coins: 90, payoutUsd: 0.09,
    isHighValue: false, slotsAvailable: 8, totalSlots: 30, completedSlots: 22,
    category: 'Entertainment', language: 'en', status: 'active', startUrl: '#',
    colorStrip: '#00FF88', isMock: true,
  },
  {
    provider: 'cpx', surveyId: 'mock_s5', name: 'IPL Cricket Fan Survey',
    topic: 'Sports', desc: 'Share your IPL 2026 predictions',
    estimatedTime: '4 min', loiMinutes: 4, coins: 150, payoutUsd: 0.15,
    isHighValue: true, slotsAvailable: 35, totalSlots: 100, completedSlots: 65,
    category: 'Sports', language: 'en', status: 'active', startUrl: '#',
    colorStrip: '#FF6B35', isMock: true,
  },
];
