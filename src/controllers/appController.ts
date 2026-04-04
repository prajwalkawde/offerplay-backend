import { Request, Response } from 'express';
import geoip from 'geoip-lite';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';

export async function getCoinRate(req: Request, res: Response): Promise<void> {
  try {
    const rawIp = (req.headers['x-forwarded-for'] as string) || req.socket?.remoteAddress || req.ip || '';
    const ip = rawIp.split(',')[0].trim();

    let countryCode = 'IN';
    try {
      const geo = geoip.lookup(ip);
      if (geo?.country) countryCode = geo.country;
    } catch (_e) {}

    let rate = await prisma.coinConversionRate.findUnique({
      where: { countryCode },
    });

    if (!rate) {
      rate = await prisma.coinConversionRate.findUnique({
        where: { countryCode: 'DEFAULT' },
      });
    }

    success(res, {
      countryCode:    rate?.countryCode    || 'IN',
      currencyCode:   rate?.currencyCode   || 'INR',
      currencySymbol: rate?.currencySymbol || '₹',
      coinsPerUnit:   rate?.coinsPerUnit   || 10,
    });
  } catch (err) {
    error(res, 'Failed to get coin rate', 500);
  }
}
