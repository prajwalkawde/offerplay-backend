import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getSecurityCheck } from '../controllers/security.controller';

const router = Router();
router.use(authMiddleware);

// Mobile calls this on app open + on focus to decide whether to show
// VPN blocking / multi-account warning dialogs. Read-only — does not
// deduct trust score or write any fraud events.
router.get('/check', getSecurityCheck);

export default router;
