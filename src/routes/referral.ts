import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { adminAuthMiddleware } from '../middleware/adminAuth';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import {
  getReferralDashboard,
  applyReferralCode,
  getMilestones,
  claimMilestone,
  getAdminMilestoneClaims,
  processAdminClaim,
} from '../controllers/referralController';
import {
  trackInstall,
  getUserReferralLink,
} from '../controllers/deepLinkController';

const router = Router();

// ─── App routes ───────────────────────────────────────────────────────────────
router.get('/dashboard',              authMiddleware, getReferralDashboard);
router.get('/link',                   authMiddleware, getUserReferralLink);
router.post('/apply',                 authMiddleware, applyReferralCode);
router.post('/track-install',                         trackInstall);
router.get('/milestones',             authMiddleware, getMilestones);
router.post('/milestones/:id/claim',  authMiddleware, claimMilestone);

// ─── Admin: settings ──────────────────────────────────────────────────────────
router.get('/admin/settings', adminAuthMiddleware, async (_req: Request, res: Response) => {
  const s = await prisma.referralSettings.findFirst().catch(() => null);
  success(res, s || {
    signupBonus: 100, referrerSignupBonus: 50,
    taskCommissionPct: 10, surveyCommissionPct: 10,
    offerwallCommissionPct: 10, contestWinCommissionPct: 5,
    isLifetimeCommission: true, maxReferrals: null, isActive: true,
  });
});

router.put('/admin/settings', adminAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.referralSettings.findFirst().catch(() => null);
    const settings = existing
      ? await prisma.referralSettings.update({ where: { id: existing.id }, data: { ...req.body } })
      : await prisma.referralSettings.create({ data: req.body });
    success(res, settings, 'Referral settings saved!');
  } catch (err: any) {
    error(res, err.message || 'Failed to save settings', 500);
  }
});

// ─── Admin: milestones ────────────────────────────────────────────────────────
router.get('/admin/milestones', adminAuthMiddleware, async (_req: Request, res: Response) => {
  const m = await prisma.referralMilestone.findMany({ orderBy: { requiredReferrals: 'asc' } });
  success(res, m);
});

router.post('/admin/milestones', adminAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const m = await prisma.referralMilestone.create({ data: req.body });
    success(res, m, 'Created!');
  } catch (err: any) {
    error(res, err.message || 'Failed', 500);
  }
});

router.put('/admin/milestones/:id', adminAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const m = await prisma.referralMilestone.update({ where: { id: req.params.id as string }, data: req.body });
    success(res, m, 'Updated!');
  } catch (err: any) {
    error(res, err.message || 'Failed', 500);
  }
});

router.delete('/admin/milestones/:id', adminAuthMiddleware, async (req: Request, res: Response) => {
  try {
    await prisma.referralMilestone.delete({ where: { id: req.params.id as string } });
    success(res, null, 'Deleted!');
  } catch (err: any) {
    error(res, err.message || 'Failed', 500);
  }
});

// ─── Admin: milestone claims ──────────────────────────────────────────────────
router.get('/admin/claims', adminAuthMiddleware, getAdminMilestoneClaims);
router.put('/admin/claims/:id', adminAuthMiddleware, processAdminClaim);

// ─── Admin: referral list ─────────────────────────────────────────────────────
router.get('/admin/list', adminAuthMiddleware, async (_req: Request, res: Response) => {
  const referrals = await prisma.referral.findMany({
    include: {
      referrer: { select: { name: true, phone: true } },
      referred: { select: { name: true, phone: true } },
      _count:   { select: { commissions: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  success(res, referrals);
});

export default router;
