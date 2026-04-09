import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { adminAuthMiddleware } from '../middleware/adminAuth';
import {
  adminLogin,
  getDashboard,
  getDashboardStats,
  listGames, createGame, updateGame,
  listContests, createContest, updateContest, finalizeContestAdmin,
  listUsers, updateUser,
  listClaims, updateClaim,
  setMatchResult, createIplQuestion,
  triggerResultVerification,
  publishContest,
  processResults, getMatchParticipants,
  getMatchQuestions, updateMatchQuestions, deleteIplQuestion,
  getAdminUsers, getUserDetails, updateUserStatus, adjustUserCoins,
  getAdminTransactions, exportTransactionsCSV,
} from '../controllers/adminController';
import {
  getAdminIPLMatches, createAdminIPLMatch,
  getMatchContests, createIPLContest, updateIPLContest, deleteIPLContest,
  publishIPLContest, processIPLContestResults, getContestParticipants,
  fetchTodayMatches, updateIPLMatch, processIPLResults,
  saveEditedQuestions, generateResultReport,
  generateIPLQuestions, getIPLAnalytics, deleteAdminIPLMatch,
  fetchIPLSchedule,
  syncTeamLogos,
} from '../controllers/iplAdminController';
import {
  listOfferwallOffers, blacklistOffer, whitelistOffer, getQualityReport,
  getPostbackLogs, getRetryQueue, manualCredit, getOfferwallStats,
  getSurveyStats, fetchLiveOffersForAdmin,
} from '../controllers/offerwallAdminController';
import {
  getInventory, createInventoryItem, updateInventoryItem, deleteInventoryItem,
  getSponsors, createSponsor, updateSponsor,
  getIplPrizeClaims, updateIplPrizeClaim,
} from '../controllers/inventoryController';
import { getCoinRates, updateCoinRate, createCoinRate } from '../controllers/coinRateController';
import { getSettings, updateSetting, updateMultipleSettings, updateBulkPut } from '../controllers/settingsController';
import {
  getAdminRedemptions, getAdminPackages,
  upsertRedeemPackage, deleteRedeemPackage,
  manualProcessRedemption, getRedemptionDetails, approveRedemption,
  updateRedemptionStatus, rejectRedemption,
} from '../controllers/redeemController';
import { getXoxodayProducts, getXoxodayFilters, testXoxodayConnection } from '../services/xoxodayService';
import {
  getStreakConfig,
  updateStreakConfig,
  getStreakStats,
} from '../controllers/streakController';
import { upload } from '../middleware/upload';

const router = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(6) });

// Public admin login (both paths for compatibility)
router.post('/auth/login', validate(loginSchema), adminLogin);
router.post('/login', validate(loginSchema), adminLogin);

// ─── Public: policy content for mobile app ────────────────────────────────────
router.get('/settings/policy/:type', async (req, res) => {
  try {
    const typeMap: Record<string, string> = {
      TERMS: 'POLICY_TERMS', PRIVACY: 'POLICY_PRIVACY', PAYMENT: 'POLICY_PAYMENT',
    };
    const key = typeMap[req.params.type as string];
    if (!key) return apiError(res, 'Not found', 404);
    const setting = await prisma.appSettings.findUnique({ where: { key } });
    return apiSuccess(res, {
      type: req.params.type,
      title: setting?.label || 'Policy',
      content: setting?.value || 'Coming soon...',
      updatedAt: setting?.updatedAt,
    });
  } catch {
    return apiError(res, 'Failed', 500);
  }
});

// All routes below require admin JWT
router.use(adminAuthMiddleware);

router.get('/dashboard', getDashboard);
router.get('/dashboard/stats', getDashboardStats);

// Games
router.get('/games', listGames);
router.post('/games', createGame);
router.put('/games/:id', updateGame);

// Contests
router.get('/contests', listContests);
router.post('/contests', createContest);
router.put('/contests/:id', updateContest);
router.post('/contests/:id/finalize', finalizeContestAdmin);

// Users
router.get('/users', getAdminUsers);
router.post('/users/:userId/adjust-coins', adjustUserCoins);
router.get('/users/:userId', getUserDetails);
router.put('/users/:userId/status', updateUserStatus);
router.put('/users/:id', updateUser);

// Transactions
router.get('/transactions/export', exportTransactionsCSV);
router.get('/transactions', getAdminTransactions);

// Claims
router.get('/claims', listClaims);
router.put('/claims/:id', updateClaim);

// IPL — Matches
router.get('/ipl/matches', getAdminIPLMatches);
router.post('/ipl/matches', createAdminIPLMatch);
router.put('/ipl/matches/:id', updateIPLMatch);
router.delete('/ipl/matches/:id', deleteAdminIPLMatch);
router.post('/ipl/matches/:id/result', setMatchResult);
router.post('/ipl/matches/process-results', processIPLResults);

// IPL — Questions
router.post('/ipl/questions', createIplQuestion);
router.get('/ipl/match/:id/questions', getMatchQuestions);
router.get('/ipl/matches/:id/questions', getMatchQuestions);
router.put('/ipl/match/:id/questions', updateMatchQuestions);
router.delete('/ipl/questions/:qid', deleteIplQuestion);
router.post('/ipl/matches/:matchId/save-questions', saveEditedQuestions);

// IPL — Contest lifecycle
router.post('/ipl/generate-questions', generateIPLQuestions);
router.post('/ipl/generate-result-report', generateResultReport);
router.post('/ipl/publish-contest', publishContest);
router.post('/ipl/process-results', processIPLResults);

// IPL — Analytics & participants
router.get('/ipl/analytics', getIPLAnalytics);
router.get('/ipl/match/:id/participants', getMatchParticipants);
router.get('/ipl/matches/:id/participants', getMatchParticipants);

// IPL — Cricbuzz sync
router.get('/ipl/fetch-today', fetchTodayMatches);
router.post('/ipl/fetch-schedule', fetchIPLSchedule);
router.post('/ipl/sync-team-logos', syncTeamLogos);

// IPL — Multi-contest per match
router.get('/ipl/matches/:matchId/contests', getMatchContests);
router.post('/ipl/matches/:matchId/contests', createIPLContest);
router.put('/ipl/contests/:contestId', updateIPLContest);
router.delete('/ipl/contests/:contestId', deleteIPLContest);
router.post('/ipl/contests/:contestId/publish', publishIPLContest);
router.post('/ipl/contests/:contestId/process', processIPLContestResults);
router.get('/ipl/contests/:contestId/participants', getContestParticipants);

// Legacy AI triggers
router.post('/ipl/verify-results/:id', triggerResultVerification);

// Automation endpoints
router.get('/automation/logs', async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page)) || 1);
  const limit = 50;
  const logs = await prisma.automationLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: (page - 1) * limit,
  });
  const total = await prisma.automationLog.count();
  return apiSuccess(res, { logs, total, page });
});

router.get('/automation/flagged', async (_req, res) => {
  const flagged = await prisma.automationLog.findMany({
    where: { status: 'FAILED' },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return apiSuccess(res, flagged);
});

router.post('/automation/trigger', async (req, res) => {
  const { action, matchId } = req.body;
  try {
    if (action === 'sync_schedule') {
      const { fetchTodayMatchesCricAPI } = await import('../services/cricketService');
      await fetchTodayMatchesCricAPI();
    } else if (action === 'generate_questions' && matchId) {
      const { iplQuestionGenQueue } = await import('../queues/iplQueues');
      await iplQuestionGenQueue.add('generateQuestions', { matchId });
    } else if (action === 'unlock_contests' && matchId) {
      const { iplContestUnlockQueue } = await import('../queues/iplQueues');
      await iplContestUnlockQueue.add('unlockContest', { matchId });
    }
    return apiSuccess(res, null, `${action} triggered`);
  } catch (err: any) {
    return apiError(res, err.message, 500);
  }
});

router.post('/ipl/matches/:id/schedule-jobs', async (req, res) => {
  const match = await prisma.iplMatch.findUnique({ where: { id: req.params.id as string } });
  if (!match) return apiError(res, 'Match not found', 404);
  const { scheduleMatchJobs } = await import('../queues/iplQueues');
  await scheduleMatchJobs(match.id, match.matchDate);
  return apiSuccess(res, null, 'Jobs scheduled');
});

// ─── Cache Management ─────────────────────────────────────────────────────────
import { redis, rk } from '../config/redis';
import { prisma } from '../config/database';
router.delete('/cache/clear', async (req, res) => {
  const [feedKeys, pubscaleKeys] = await Promise.all([
    redis.keys(rk('offer_feed:*')),
    redis.keys(rk('pubscale:*')),
  ]);
  const allKeys = [...feedKeys, ...pubscaleKeys];
  if (allKeys.length > 0) await redis.del(...allKeys);
  res.json({ success: true, cleared: allKeys.length, message: `Cleared ${allKeys.length} cache keys` });
});

// ─── Offerwall Admin ──────────────────────────────────────────────────────────
router.get('/offerwall/offers', listOfferwallOffers);
router.get('/offerwall/live-offers', fetchLiveOffersForAdmin);
router.post('/offerwall/blacklist', blacklistOffer);
router.post('/offerwall/whitelist', whitelistOffer);
router.get('/offerwall/quality-report', getQualityReport);
router.get('/offerwall/postback-logs', getPostbackLogs);
router.get('/offerwall/retry-queue', getRetryQueue);
router.post('/offerwall/manual-credit', manualCredit);
router.get('/offerwall/stats', getOfferwallStats);
router.get('/surveys/stats', getSurveyStats);

// ─── Prize Inventory ──────────────────────────────────────────────────────────
router.get('/inventory', getInventory);
router.post('/inventory', createInventoryItem);
router.put('/inventory/:id', updateInventoryItem);
router.delete('/inventory/:id', deleteInventoryItem);

// ─── Sponsors ─────────────────────────────────────────────────────────────────
router.get('/sponsors', getSponsors);
router.post('/sponsors', createSponsor);
router.put('/sponsors/:id', updateSponsor);

// ─── IPL Prize Claims ─────────────────────────────────────────────────────────
router.get('/ipl/prize-claims', getIplPrizeClaims);
router.put('/ipl/prize-claims/:id', updateIplPrizeClaim);

// ─── Coin Conversion Rates ────────────────────────────────────────────────────
router.get('/coin-rates', getCoinRates);
router.post('/coin-rates', createCoinRate);
router.put('/coin-rates/:id', updateCoinRate);

// ─── App Settings / API Keys ──────────────────────────────────────────────────
router.get('/settings', getSettings);
router.put('/settings/:key', updateSetting);
router.post('/settings/bulk', updateMultipleSettings);
router.put('/settings/bulk/update', updateBulkPut);

// ─── Redemptions ──────────────────────────────────────────────────────────────
router.get('/redemptions', getAdminRedemptions);
router.get('/redeem-packages', getAdminPackages);
router.post('/redeem-packages', upsertRedeemPackage);
router.put('/redeem-packages/:id', upsertRedeemPackage);
router.delete('/redeem-packages/:id', deleteRedeemPackage);
router.post('/redemptions/:id/process', manualProcessRedemption);
router.put('/redemptions/:id/status', updateRedemptionStatus);

// ─── Test / Dev Helpers ───────────────────────────────────────────────────────
router.post('/test/reset-daily-bonus/:userId', async (req, res) => {
  try {
    const { userId } = req.params as { userId: string };
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);

    await prisma.userStreak.upsert({
      where: { userId },
      update: { lastClaimDate: yesterday },
      create: { userId, lastClaimDate: yesterday },
    });

    // Also clear Redis key for old claimDailyBonus endpoint
    const today = new Date().toISOString().slice(0, 10);
    await redis.del(rk(`daily:${userId}:${today}`));

    return apiSuccess(res, null, 'Daily bonus reset!');
  } catch (err) {
    return apiError(res, 'Failed', 500);
  }
});

router.post('/test/reset-all-daily-bonus', async (req, res) => {
  try {
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);

    await prisma.userStreak.updateMany({
      data: { lastClaimDate: yesterday },
    });

    // Clear all Redis daily bonus keys for today
    const today = new Date().toISOString().slice(0, 10);
    const keys = await redis.keys(rk(`daily:*:${today}`));
    if (keys.length > 0) await redis.del(...keys);

    return apiSuccess(res, { usersReset: true }, 'All daily bonuses reset!');
  } catch (err) {
    return apiError(res, 'Failed', 500);
  }
});

// ─── Daily Streak ─────────────────────────────────────────────────────────────
router.get('/streak-config', getStreakConfig);
router.put('/streak-config/:day', updateStreakConfig);
router.get('/streak-stats', getStreakStats);

// ─── Xoxoday ──────────────────────────────────────────────────────────────────
router.get('/xoxoday/test', async (_req, res) => {
  const result = await testXoxodayConnection();
  const envInfo = {
    hasClientId: !!process.env.XOXODAY_CLIENT_ID,
    hasSecretId: !!process.env.XOXODAY_SECRET_ID,
    clientIdPreview: process.env.XOXODAY_CLIENT_ID?.slice(0, 8) + '...',
  };
  return apiSuccess(res, { ...result, envInfo });
});

router.get('/xoxoday/test-connection', async (_req, res) => {
  const result   = await testXoxodayConnection();
  const products = result.connected ? await getXoxodayProducts({}) : [];
  res.json({
    success: true,
    data: {
      ...result,
      productCount: products.length,
      source: result.connected ? 'LIVE_XOXODAY_API' : 'MOCK_DATA',
      sample: products.slice(0, 3).map((p: { id: string; name: string; denominations?: unknown[] }) => ({
        id: p.id, name: p.name,
        denominations: Array.isArray(p.denominations) ? p.denominations.length : 0,
      })),
    },
  });
});

// ─── GET /xoxoday/filters?group=country|voucher_category|currency|price ───────
router.get('/xoxoday/filters', async (req, res) => {
  try {
    const group    = typeof req.query.group === 'string' ? req.query.group.trim() : '';
    const groups   = await getXoxodayFilters(group);
    res.json({ success: true, data: { groups } });
  } catch (err: unknown) {
    res.status(500).json({ success: false, message: (err as Error).message });
  }
});

// ─── GET /xoxoday/products ────────────────────────────────────────────────────
// Query params:
//   country  — ISO code ("IN") or filterValueCode ("india") or omit for all
//   category — voucher_category filterValueCode (e.g. "gaming")
//   currency — e.g. "INR", "USD"
//   minPrice — number
//   maxPrice — number
router.get('/xoxoday/products', async (req, res) => {
  try {
    const q = req.query as Record<string, string>;

    const options = {
      country:  q.country  || undefined,
      category: q.category || undefined,
      currency: q.currency || undefined,
      minPrice: q.minPrice ? parseFloat(q.minPrice) : undefined,
      maxPrice: q.maxPrice ? parseFloat(q.maxPrice) : undefined,
    };

    const products = await getXoxodayProducts(options);
    const MOCK_IDS = new Set(['amazon_in', 'flipkart_in', 'paytm_in', 'freefire_in', 'bgmi_in']);
    const isMock   = products.length > 0 && products.every((p: any) => MOCK_IDS.has(p.id));

    res.json({
      success: true,
      data: { products, total: products.length, filters: options, isMock },
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, message: (err as Error).message });
  }
});

// ─── Redemption detail + approve ──────────────────────────────────────────────
router.get('/redemptions/:id', getRedemptionDetails);
router.post('/redemptions/:id/approve', approveRedemption);
router.post('/redemptions/:id/reject', rejectRedemption);

// ─── File Upload ───────────────────────────────────────────────────────────────
import { success as apiSuccess, error as apiError } from '../utils/response';

router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) { apiError(res, 'No file uploaded', 400); return; }
  const relativePath = `/uploads/${req.file.filename}`;
  // Use X-Forwarded-Proto to get the correct scheme when behind nginx proxy
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  const fullUrl = `${proto}://${req.get('host')}${relativePath}`;
  apiSuccess(res, { url: fullUrl, relativePath, filename: req.file.filename }, 'Uploaded!');
});

export default router;
