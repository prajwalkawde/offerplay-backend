import { Router } from 'express';
import { adminAuthMiddleware } from '../middleware/adminAuth';
import {
  listTickets,
  getTicket,
  updateTicket,
  ticketUserAction,
  getCounts,
} from '../controllers/admin.support.controller';

const router = Router();
router.use(adminAuthMiddleware);

router.get('/tickets', listTickets);
router.get('/tickets/counts', getCounts);
router.get('/tickets/:id', getTicket);
router.patch('/tickets/:id', updateTicket);
router.post('/tickets/:id/user-action', ticketUserAction);

export default router;
