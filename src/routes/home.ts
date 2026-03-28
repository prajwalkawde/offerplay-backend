import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { getHomeData } from '../controllers/homeController';

const router = Router();
router.use(authMiddleware);
router.get('/', getHomeData);

export default router;
