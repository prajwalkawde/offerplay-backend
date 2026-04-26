import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { createTicket, listMyTickets } from '../controllers/support.controller';

const router = Router();

// Support routes intentionally do NOT use fraudCheck/integrityCheck/requestSign.
// authMiddleware blocks users with User.status != ACTIVE (manually-banned users),
// but a user whose UserTrustScore.isBanned=true (fraud-flagged) still has
// status=ACTIVE — so they can still file a ticket to appeal. This is the correct
// audience for "Contact Support": users who think the auto-flag was wrong.
router.use(authMiddleware);

router.post('/ticket', createTicket);
router.get('/my-tickets', listMyTickets);

export default router;
