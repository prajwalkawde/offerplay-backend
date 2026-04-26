import { Router } from 'express';
import { adminAuthMiddleware } from '../middleware/adminAuth';
import {
  getSecuritySettings,
  updateSecuritySettings,
  getIpRecords,
  blockIpRecord,
  unblockIpRecord,
  getFraudLogs,
  resolveFraudLog,
  getSecurityUsers,
  banUser,
  unbanUser,
  restrictUser,
  unrestrictUser,
  setUserTrustScore,
  getSecurityOverview,
  getFlaggedUsers,
  getFlaggedUserDetail,
} from '../controllers/admin.security.controller';

const router = Router();
router.use(adminAuthMiddleware);

// Settings
router.get('/settings', getSecuritySettings);
router.put('/settings', updateSecuritySettings);

// IP Records
router.get('/ip-records', getIpRecords);
router.put('/ip-records/:ip/block', blockIpRecord);
router.put('/ip-records/:ip/unblock', unblockIpRecord);

// Fraud Logs
router.get('/fraud-logs', getFraudLogs);
router.put('/fraud-logs/:id/resolve', resolveFraudLog);

// Users / Trust Scores
router.get('/users', getSecurityUsers);
router.put('/users/:uid/ban', banUser);
router.put('/users/:uid/unban', unbanUser);
router.put('/users/:uid/restrict', restrictUser);
router.put('/users/:uid/unrestrict', unrestrictUser);
router.put('/users/:uid/trust-score', setUserTrustScore);

// Overview
router.get('/overview', getSecurityOverview);

// Flagged users (Phase C)
router.get('/flagged-users', getFlaggedUsers);
router.get('/flagged-users/:uid', getFlaggedUserDetail);

export default router;
