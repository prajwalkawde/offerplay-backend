import { Router } from 'express';
import { adminAuthMiddleware } from '../middleware/adminAuth';
import {
  adminGetSettings,
  adminUpdateSettings,
  adminGetAttempts,
  adminGetAnalytics,
  adminCompleteAttempt,
  adminFailAttempt,
  adminGetTicketBalance,
  adminCreditTickets,
  adminDebitTickets,
  adminGetTicketTransactions,
} from '../controllers/admin.superOffer.controller';

const router = Router();
router.use(adminAuthMiddleware);

// Super Offer settings
router.get('/superoffers/settings', adminGetSettings);
router.put('/superoffers/settings', adminUpdateSettings);

// Attempts management
router.get('/superoffers/attempts', adminGetAttempts);
router.get('/superoffers/analytics', adminGetAnalytics);
router.put('/superoffers/attempts/:id/complete', adminCompleteAttempt);
router.put('/superoffers/attempts/:id/fail', adminFailAttempt);

// Ticket management
router.get('/tickets/balance/:uid', adminGetTicketBalance);
router.post('/tickets/credit', adminCreditTickets);
router.post('/tickets/debit', adminDebitTickets);
router.get('/tickets/transactions', adminGetTicketTransactions);

export default router;
