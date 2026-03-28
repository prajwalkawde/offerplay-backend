import { Router } from 'express';
import { authMiddleware as auth } from '../middleware/auth';
import { adminAuthMiddleware as adminAuth } from '../middleware/adminAuth';
import {
  getQuests,
  claimQuestReward,
  adminListQuests,
  adminCreateQuest,
  adminUpdateQuest,
  adminDeleteQuest,
} from '../controllers/questController';
import { getAdjoeStats } from '../controllers/adjoeController';

const router = Router();

// User routes
router.get('/',                  auth,      getQuests);
router.post('/:id/claim',        auth,      claimQuestReward);
router.get('/adjoe/stats',       auth,      getAdjoeStats);

// Admin routes
router.get('/admin/list',        adminAuth, adminListQuests);
router.post('/admin/quests',     adminAuth, adminCreateQuest);
router.put('/admin/quests/:id',  adminAuth, adminUpdateQuest);
router.delete('/admin/quests/:id', adminAuth, adminDeleteQuest);

export default router;
