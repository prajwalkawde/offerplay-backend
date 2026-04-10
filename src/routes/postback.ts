import { Router, Request, Response } from 'express';
import {
  receivePubScalePostback,
  receivePubScaleChargeback,
  receiveToroxPostback,
  receiveAyetPostback,
} from '../services/postbackService';
import { handleCPXPostback } from '../services/surveyService';
import { logger } from '../utils/logger';

const router = Router();

// PubScale whitelisted IPs (updated 2024-01-23 per their docs)
const PUBSCALE_IPS = new Set(['34.100.236.68']);

function isPubScaleIP(req: Request): boolean {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';
  return PUBSCALE_IPS.has(ip);
}

// PubScale — GET (providers redirect here)
router.get('/pubscale', async (req: Request, res: Response): Promise<void> => {
  const result = await receivePubScalePostback(req.query as Record<string, any>);
  res.send(result);
});

// PubScale Chargeback — IP whitelisted
router.get('/pubscale/chargeback', async (req: Request, res: Response): Promise<void> => {
  if (!isPubScaleIP(req)) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    logger.warn('PubScale chargeback blocked — unknown IP', { ip });
    res.status(403).send('Forbidden');
    return;
  }
  const result = await receivePubScaleChargeback(req.query as Record<string, any>);
  res.send(result);
});

// Torox
router.get('/torox', async (req: Request, res: Response): Promise<void> => {
  const result = await receiveToroxPostback(req.query as Record<string, any>);
  res.send(result);
});

// AyeT Studios (both paths for compatibility)
router.get('/ayetstudio', async (req: Request, res: Response): Promise<void> => {
  const result = await receiveAyetPostback(req.query as Record<string, any>);
  res.send(result);
});
router.get('/ayet', async (req: Request, res: Response): Promise<void> => {
  const result = await receiveAyetPostback(req.query as Record<string, any>);
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
