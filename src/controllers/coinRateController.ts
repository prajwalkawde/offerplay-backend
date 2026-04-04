import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { redis } from '../config/redis';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';

const DEFAULT_RATES = [
  { countryCode: 'IN',      countryName: 'India',               currencyCode: 'INR', currencySymbol: '₹',   coinsPerUnit: 10 },
  { countryCode: 'US',      countryName: 'United States',       currencyCode: 'USD', currencySymbol: '$',   coinsPerUnit: 1000 },
  { countryCode: 'GB',      countryName: 'United Kingdom',      currencyCode: 'GBP', currencySymbol: '£',   coinsPerUnit: 1200 },
  { countryCode: 'AE',      countryName: 'UAE',                 currencyCode: 'AED', currencySymbol: 'AED', coinsPerUnit: 270 },
  { countryCode: 'SG',      countryName: 'Singapore',           currencyCode: 'SGD', currencySymbol: 'S$',  coinsPerUnit: 740 },
  { countryCode: 'AU',      countryName: 'Australia',           currencyCode: 'AUD', currencySymbol: 'A$',  coinsPerUnit: 650 },
  { countryCode: 'CA',      countryName: 'Canada',              currencyCode: 'CAD', currencySymbol: 'CA$', coinsPerUnit: 730 },
  { countryCode: 'DE',      countryName: 'Germany',             currencyCode: 'EUR', currencySymbol: '€',   coinsPerUnit: 1080 },
  { countryCode: 'DEFAULT', countryName: 'Default (All Others)', currencyCode: 'USD', currencySymbol: '$',  coinsPerUnit: 1000 },
];

// ─── GET /api/admin/coin-rates ────────────────────────────────────────────────
export async function getCoinRates(req: Request, res: Response): Promise<void> {
  try {
    let rates = await prisma.coinConversionRate.findMany({
      orderBy: { countryName: 'asc' },
    });

    // Auto-seed if empty
    if (rates.length === 0) {
      for (const rate of DEFAULT_RATES) {
        await prisma.coinConversionRate.upsert({
          where: { countryCode: rate.countryCode },
          update: rate,
          create: rate,
        });
      }
      rates = await prisma.coinConversionRate.findMany({ orderBy: { countryName: 'asc' } });
      logger.info('CoinConversionRate: seeded default rates');
    }

    success(res, rates);
  } catch (err) {
    logger.error('getCoinRates error:', err);
    error(res, 'Failed to get coin rates', 500);
  }
}

// ─── PUT /api/admin/coin-rates/:id ────────────────────────────────────────────
export async function updateCoinRate(req: Request, res: Response): Promise<void> {
  try {
    const id = req.params.id as string;
    const { coinsPerUnit, currencySymbol, isActive } = req.body;

    if (coinsPerUnit !== undefined && (isNaN(parseFloat(coinsPerUnit)) || parseFloat(coinsPerUnit) < 1)) {
      error(res, 'Invalid coinsPerUnit — must be >= 1', 400);
      return;
    }

    const data: Record<string, unknown> = {};
    if (coinsPerUnit !== undefined) data.coinsPerUnit = parseFloat(coinsPerUnit);
    if (currencySymbol !== undefined) data.currencySymbol = currencySymbol;
    if (isActive !== undefined) data.isActive = isActive;

    const rate = await prisma.coinConversionRate.update({ where: { id }, data });

    // Invalidate app coin-rate cache for all countries
    const keys = await redis.keys('coin_rate:*');
    if (keys.length > 0) await redis.del(...keys);

    success(res, rate, 'Rate updated successfully!');
  } catch (err: any) {
    logger.error('updateCoinRate error:', err);
    error(res, 'Failed to update rate', 500);
  }
}

// ─── POST /api/admin/coin-rates ───────────────────────────────────────────────
export async function createCoinRate(req: Request, res: Response): Promise<void> {
  try {
    const { countryCode, countryName, currencyCode, currencySymbol, coinsPerUnit } = req.body;

    if (!countryCode || !currencyCode || coinsPerUnit === undefined) {
      error(res, 'countryCode, currencyCode, and coinsPerUnit are required', 400);
      return;
    }

    const rate = await prisma.coinConversionRate.create({
      data: {
        countryCode: String(countryCode).toUpperCase(),
        countryName: countryName || countryCode,
        currencyCode,
        currencySymbol: currencySymbol || currencyCode,
        coinsPerUnit: parseFloat(coinsPerUnit),
      },
    });

    success(res, rate, 'Country rate added!');
  } catch (err: any) {
    if (err.code === 'P2002') {
      error(res, 'Country code already exists', 400);
      return;
    }
    logger.error('createCoinRate error:', err);
    error(res, 'Failed to create rate', 500);
  }
}
