import { Router } from 'express';
import { adminAuthMiddleware } from '../middleware/adminAuth';
import {
  getLtvCac,
  upsertMarketingSpend,
  deleteMarketingSpend,
  upsertAdRevenue,
  deleteAdRevenue,
} from '../controllers/admin.ltvCac.controller';

const router = Router();
router.use(adminAuthMiddleware);

router.get('/ltv-cac', getLtvCac);
router.post('/marketing-spend', upsertMarketingSpend);
router.delete('/marketing-spend/:id', deleteMarketingSpend);
router.post('/ad-revenue', upsertAdRevenue);
router.delete('/ad-revenue/:id', deleteAdRevenue);

export default router;
