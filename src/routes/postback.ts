import { Router, Request, Response } from 'express';
import {
  receivePubScalePostback,
  receiveToroxPostback,
  receiveAyetPostback,
} from '../services/postbackService';
import { handleCPXPostback } from '../services/surveyService';

const router = Router();

// Normalize query params: flatten arrays → prefer numeric/non-macro values,
// and strip unreplaced macro placeholders like {reward} / %7Breward%7D
function normalizeQuery(query: Record<string, any>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(query)) {
    if (Array.isArray(val)) {
      // Pick the first value that isn't an unreplaced macro placeholder
      const real = val.find((v: string) => v && !v.includes('{') && !v.includes('%7B'));
      result[key] = real ?? '';
    } else {
      const s = String(val ?? '');
      // Treat unreplaced placeholders as empty
      result[key] = (s.includes('{') || s.includes('%7B')) ? '' : s;
    }
  }
  return result;
}

// PubScale — GET (providers redirect here)
router.get('/pubscale', async (req: Request, res: Response): Promise<void> => {
  // Pass raw query (any) — service normalizes internally after sig verification
  const result = await receivePubScalePostback(req.query as Record<string, any>);
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
