"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCoinRates = getCoinRates;
exports.updateCoinRate = updateCoinRate;
exports.createCoinRate = createCoinRate;
const database_1 = require("../config/database");
const redis_1 = require("../config/redis");
const response_1 = require("../utils/response");
const logger_1 = require("../utils/logger");
const DEFAULT_RATES = [
    { countryCode: 'IN', countryName: 'India', currencyCode: 'INR', currencySymbol: '₹', coinsPerUnit: 10 },
    { countryCode: 'US', countryName: 'United States', currencyCode: 'USD', currencySymbol: '$', coinsPerUnit: 1000 },
    { countryCode: 'GB', countryName: 'United Kingdom', currencyCode: 'GBP', currencySymbol: '£', coinsPerUnit: 1200 },
    { countryCode: 'AE', countryName: 'UAE', currencyCode: 'AED', currencySymbol: 'AED', coinsPerUnit: 270 },
    { countryCode: 'SG', countryName: 'Singapore', currencyCode: 'SGD', currencySymbol: 'S$', coinsPerUnit: 740 },
    { countryCode: 'AU', countryName: 'Australia', currencyCode: 'AUD', currencySymbol: 'A$', coinsPerUnit: 650 },
    { countryCode: 'CA', countryName: 'Canada', currencyCode: 'CAD', currencySymbol: 'CA$', coinsPerUnit: 730 },
    { countryCode: 'DE', countryName: 'Germany', currencyCode: 'EUR', currencySymbol: '€', coinsPerUnit: 1080 },
    { countryCode: 'DEFAULT', countryName: 'Default (All Others)', currencyCode: 'USD', currencySymbol: '$', coinsPerUnit: 1000 },
];
// ─── GET /api/admin/coin-rates ────────────────────────────────────────────────
async function getCoinRates(req, res) {
    try {
        let rates = await database_1.prisma.coinConversionRate.findMany({
            orderBy: { countryName: 'asc' },
        });
        // Auto-seed if empty
        if (rates.length === 0) {
            for (const rate of DEFAULT_RATES) {
                await database_1.prisma.coinConversionRate.upsert({
                    where: { countryCode: rate.countryCode },
                    update: rate,
                    create: rate,
                });
            }
            rates = await database_1.prisma.coinConversionRate.findMany({ orderBy: { countryName: 'asc' } });
            logger_1.logger.info('CoinConversionRate: seeded default rates');
        }
        (0, response_1.success)(res, rates);
    }
    catch (err) {
        logger_1.logger.error('getCoinRates error:', err);
        (0, response_1.error)(res, 'Failed to get coin rates', 500);
    }
}
// ─── PUT /api/admin/coin-rates/:id ────────────────────────────────────────────
async function updateCoinRate(req, res) {
    try {
        const id = req.params.id;
        const { coinsPerUnit, currencySymbol, isActive } = req.body;
        if (coinsPerUnit !== undefined && (isNaN(parseFloat(coinsPerUnit)) || parseFloat(coinsPerUnit) < 1)) {
            (0, response_1.error)(res, 'Invalid coinsPerUnit — must be >= 1', 400);
            return;
        }
        const data = {};
        if (coinsPerUnit !== undefined)
            data.coinsPerUnit = parseFloat(coinsPerUnit);
        if (currencySymbol !== undefined)
            data.currencySymbol = currencySymbol;
        if (isActive !== undefined)
            data.isActive = isActive;
        const rate = await database_1.prisma.coinConversionRate.update({ where: { id }, data });
        // Invalidate app coin-rate cache for all countries
        const keys = await redis_1.redis.keys('coin_rate:*');
        if (keys.length > 0)
            await redis_1.redis.del(...keys);
        (0, response_1.success)(res, rate, 'Rate updated successfully!');
    }
    catch (err) {
        logger_1.logger.error('updateCoinRate error:', err);
        (0, response_1.error)(res, 'Failed to update rate', 500);
    }
}
// ─── POST /api/admin/coin-rates ───────────────────────────────────────────────
async function createCoinRate(req, res) {
    try {
        const { countryCode, countryName, currencyCode, currencySymbol, coinsPerUnit } = req.body;
        if (!countryCode || !currencyCode || coinsPerUnit === undefined) {
            (0, response_1.error)(res, 'countryCode, currencyCode, and coinsPerUnit are required', 400);
            return;
        }
        const rate = await database_1.prisma.coinConversionRate.create({
            data: {
                countryCode: String(countryCode).toUpperCase(),
                countryName: countryName || countryCode,
                currencyCode,
                currencySymbol: currencySymbol || currencyCode,
                coinsPerUnit: parseFloat(coinsPerUnit),
            },
        });
        (0, response_1.success)(res, rate, 'Country rate added!');
    }
    catch (err) {
        if (err.code === 'P2002') {
            (0, response_1.error)(res, 'Country code already exists', 400);
            return;
        }
        logger_1.logger.error('createCoinRate error:', err);
        (0, response_1.error)(res, 'Failed to create rate', 500);
    }
}
