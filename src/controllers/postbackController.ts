import { Request, Response } from 'express';
import {
  processPostback,
  verifyPubscaleSignature,
  verifyToroxSignature,
  verifyAyetSignature,
} from '../services/offerwallService';
import { logger } from '../utils/logger';

export async function pubscaleCallback(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, string>;
  const { user_id, offer_id, coins, sig } = query;

  if (!user_id || !offer_id || !coins || !sig) {
    res.status(400).send('Bad Request');
    return;
  }

  const valid = await verifyPubscaleSignature(query, sig);
  if (!valid) {
    logger.warn('Pubscale invalid signature', { query });
    res.status(403).send('Invalid signature');
    return;
  }

  try {
    const result = await processPostback({
      userId: user_id,
      offerId: offer_id,
      coins: parseInt(coins, 10),
      provider: 'pubscale',
      rawData: query,
    });

    res.status(200).send(result.duplicate ? 'ALREADY_CREDITED' : 'OK');
  } catch (err) {
    logger.error('Pubscale postback error', { err });
    res.status(500).send('ERROR');
  }
}

export async function toroxCallback(req: Request, res: Response): Promise<void> {
  const { user_id, offer_id, coins, sig } = req.query as Record<string, string>;

  if (!user_id || !offer_id || !coins || !sig) {
    res.status(400).send('Bad Request');
    return;
  }

  const valid = await verifyToroxSignature(user_id, offer_id, coins, sig);
  if (!valid) {
    logger.warn('Torox invalid signature', { user_id, offer_id });
    res.status(403).send('Invalid signature');
    return;
  }

  try {
    const result = await processPostback({
      userId: user_id,
      offerId: offer_id,
      coins: parseInt(coins, 10),
      provider: 'torox',
      rawData: req.query as Record<string, string>,
    });

    res.status(200).send(result.duplicate ? '2' : '1');
  } catch (err) {
    logger.error('Torox postback error', { err });
    res.status(500).send('0');
  }
}

export async function ayetCallback(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, string>;
  const { user_id, offer_id, coins, signature } = query;

  if (!user_id || !offer_id || !coins || !signature) {
    res.status(400).send('Bad Request');
    return;
  }

  const valid = await verifyAyetSignature(query, signature);
  if (!valid) {
    logger.warn('AyetStudios invalid signature', { query });
    res.status(403).send('Invalid signature');
    return;
  }

  try {
    const result = await processPostback({
      userId: user_id,
      offerId: offer_id,
      coins: parseInt(coins, 10),
      provider: 'ayetstudios',
      rawData: query,
    });

    res.status(200).json({ status: result.duplicate ? 'duplicate' : 'success' });
  } catch (err) {
    logger.error('AyetStudios postback error', { err });
    res.status(500).json({ status: 'error' });
  }
}
