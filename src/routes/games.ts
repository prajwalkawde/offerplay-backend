import { Router } from 'express';
import { listGames, getGame } from '../controllers/gameController';

const router = Router();

router.get('/', listGames);
router.get('/:id', getGame);

export default router;
