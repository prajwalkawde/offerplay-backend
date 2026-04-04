import { Router, Request, Response } from 'express';
import {
  receivePubScalePostback,
  receiveToroxPostback,
  receiveAyetPostback,
} from '../services/postbackService';
import { handleCPXPostback } from '../services/surveyService';

const router = Router();

// PubScale — GET (providers redirect here)
router.get('/pubscale', async (req: Request, res: Response): Promise<void> => {
  const result = await receivePubScalePostback(req.query as Record<string, string>);
  res.send(result);
});

// Torox
router.get('/torox', async (req: Request, res: Response): Promise<void> => {
  const result = await receiveToroxPostback(req.query as Record<string, string>);
  res.send(result);
});

// AyeT Studios (both paths for compatibility)
router.get('/ayetstudio', async (req: Request, res: Response): Promise<void> => {
  const result = await receiveAyetPostback(req.query as Record<string, string>);
  res.send(result);
});
router.get('/ayet', async (req: Request, res: Response): Promise<void> => {
  const result = await receiveAyetPostback(req.query as Record<string, string>);
  res.send(result);
});

// CPX Research
router.get('/cpx', async (req: Request, res: Response): Promise<void> => {
  const result = await handleCPXPostback(req.query);
  res.send(result);
});
router.post('/cpx', async (req: Request, res: Response): Promise<void> => {
  const result = await handleCPXPostback({ ...req.query, ...req.body });
  res.send(result);
});

export default router;
