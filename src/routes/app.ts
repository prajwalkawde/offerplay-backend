import { Router } from 'express';
import { getCoinRate } from '../controllers/appController';
import { getPublicInventory, getPublicSponsors } from '../controllers/inventoryController';

const router = Router();

router.get('/coin-rate', getCoinRate);
router.get('/inventory', getPublicInventory);
router.get('/sponsors', getPublicSponsors);

export default router;
