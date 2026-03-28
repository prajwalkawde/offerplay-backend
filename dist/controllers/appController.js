"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCoinRate = getCoinRate;
const geoip_lite_1 = __importDefault(require("geoip-lite"));
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
async function getCoinRate(req, res) {
    try {
        const rawIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '';
        const ip = rawIp.split(',')[0].trim();
        let countryCode = 'IN';
        try {
            const geo = geoip_lite_1.default.lookup(ip);
            if (geo?.country)
                countryCode = geo.country;
        }
        catch (_e) { }
        let rate = await database_1.prisma.coinConversionRate.findUnique({
            where: { countryCode },
        });
        if (!rate) {
            rate = await database_1.prisma.coinConversionRate.findUnique({
                where: { countryCode: 'DEFAULT' },
            });
        }
        (0, response_1.success)(res, {
            countryCode: rate?.countryCode || 'IN',
            currencyCode: rate?.currencyCode || 'INR',
            currencySymbol: rate?.currencySymbol || '₹',
            coinsPerUnit: rate?.coinsPerUnit || 10,
        });
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to get coin rate', 500);
    }
}
