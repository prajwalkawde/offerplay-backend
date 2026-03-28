"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSettings = getSettings;
exports.updateSetting = updateSetting;
exports.updateMultipleSettings = updateMultipleSettings;
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const logger_1 = require("../utils/logger");
const DEFAULT_SETTINGS = [
    // Offerwall
    { key: 'PUBSCALE_APP_ID', label: 'PubScale App ID', category: 'offerwall', isSecret: false, value: process.env.PUBSCALE_APP_ID || '' },
    { key: 'PUBSCALE_PUB_KEY', label: 'PubScale Pub Key', category: 'offerwall', isSecret: true, value: process.env.PUBSCALE_PUB_KEY || '' },
    { key: 'PUBSCALE_SECRET', label: 'PubScale Secret', category: 'offerwall', isSecret: true, value: process.env.PUBSCALE_SECRET || '' },
    { key: 'TOROX_API_KEY', label: 'Torox API Key', category: 'offerwall', isSecret: true, value: process.env.TOROX_API_KEY || '' },
    { key: 'TOROX_PUB_ID', label: 'Torox Publisher ID', category: 'offerwall', isSecret: false, value: process.env.TOROX_PUB_ID || '' },
    { key: 'AYET_ADSLOT_ID', label: 'AyeT Adslot ID', category: 'offerwall', isSecret: false, value: process.env.AYET_ADSLOT_ID || '' },
    // Surveys
    { key: 'CPX_APP_ID', label: 'CPX Research App ID', category: 'survey', isSecret: false, value: process.env.CPX_APP_ID || '' },
    { key: 'CPX_SECURE_HASH', label: 'CPX Secure Hash', category: 'survey', isSecret: true, value: process.env.CPX_SECURE_HASH || '' },
    // Cricket
    { key: 'RAPIDAPI_KEY', label: 'RapidAPI Key (Cricbuzz)', category: 'cricket', isSecret: true, value: process.env.RAPIDAPI_KEY || '' },
    // AI
    { key: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude AI) Key', category: 'ai', isSecret: true, value: process.env.ANTHROPIC_API_KEY || '' },
    // Payments
    { key: 'CASHFREE_APP_ID', label: 'Cashfree App ID', category: 'payment', isSecret: false, value: process.env.CASHFREE_APP_ID || '' },
    { key: 'CASHFREE_SECRET', label: 'Cashfree Secret Key', category: 'payment', isSecret: true, value: process.env.CASHFREE_SECRET || '' },
    { key: 'XOXODAY_API_KEY', label: 'Xoxoday API Key', category: 'payment', isSecret: true, value: process.env.XOXODAY_API_KEY || '' },
    // SMS
    { key: 'FAST2SMS_API_KEY', label: 'Fast2SMS API Key', category: 'sms', isSecret: true, value: process.env.FAST2SMS_API_KEY || '' },
    // App
    { key: 'APP_NAME', label: 'App Name', category: 'app', isSecret: false, value: 'OfferPlay' },
    { key: 'SUPPORT_EMAIL', label: 'Support Email', category: 'app', isSecret: false, value: 'support@offerplay.in' },
    { key: 'MIN_WITHDRAWAL', label: 'Minimum Withdrawal (coins)', category: 'app', isSecret: false, value: '500' },
    { key: 'REFERRAL_BONUS', label: 'Referral Bonus (coins)', category: 'app', isSecret: false, value: '50' },
    { key: 'WELCOME_BONUS', label: 'Welcome Bonus (coins)', category: 'app', isSecret: false, value: '100' },
    { key: 'MAINTENANCE_MODE', label: 'Maintenance Mode', category: 'app', isSecret: false, value: 'false' },
];
async function getSettings(req, res) {
    try {
        let settings = await database_1.prisma.appSettings.findMany({
            orderBy: [{ category: 'asc' }, { key: 'asc' }],
        });
        if (settings.length === 0) {
            for (const s of DEFAULT_SETTINGS) {
                await database_1.prisma.appSettings.upsert({
                    where: { key: s.key },
                    update: {},
                    create: s,
                });
            }
            settings = await database_1.prisma.appSettings.findMany({
                orderBy: [{ category: 'asc' }, { key: 'asc' }],
            });
        }
        const masked = settings.map(s => ({
            ...s,
            value: s.isSecret && s.value
                ? s.value.substring(0, 4) + '****' + s.value.slice(-4)
                : s.value,
            hasValue: s.value.length > 0,
        }));
        (0, response_1.success)(res, masked);
    }
    catch (err) {
        logger_1.logger.error('getSettings error:', err);
        (0, response_1.error)(res, 'Failed to get settings', 500);
    }
}
async function updateSetting(req, res) {
    try {
        const { key } = req.params;
        const { value } = req.body;
        if (value === undefined) {
            (0, response_1.error)(res, 'Value required', 400);
            return;
        }
        const existing = DEFAULT_SETTINGS.find(s => s.key === key);
        const setting = await database_1.prisma.appSettings.upsert({
            where: { key },
            update: { value: String(value) },
            create: {
                key,
                value: String(value),
                label: existing?.label ?? key,
                category: existing?.category ?? 'general',
                isSecret: existing?.isSecret ?? false,
            },
        });
        process.env[key] = String(value);
        (0, response_1.success)(res, { key: setting.key, hasValue: setting.value.length > 0 }, 'Setting updated!');
    }
    catch (err) {
        logger_1.logger.error('updateSetting error:', err);
        (0, response_1.error)(res, 'Failed to update', 500);
    }
}
async function updateMultipleSettings(req, res) {
    try {
        const { settings } = req.body;
        if (!Array.isArray(settings)) {
            (0, response_1.error)(res, 'Settings array required', 400);
            return;
        }
        for (const s of settings) {
            if (s.key && s.value !== undefined) {
                const existing = DEFAULT_SETTINGS.find(d => d.key === s.key);
                await database_1.prisma.appSettings.upsert({
                    where: { key: s.key },
                    update: { value: String(s.value) },
                    create: {
                        key: s.key,
                        value: String(s.value),
                        label: existing?.label ?? s.key,
                        category: existing?.category ?? 'general',
                        isSecret: existing?.isSecret ?? false,
                    },
                });
                process.env[s.key] = String(s.value);
            }
        }
        (0, response_1.success)(res, null, 'Settings saved successfully!');
    }
    catch (err) {
        logger_1.logger.error('updateMultipleSettings error:', err);
        (0, response_1.error)(res, 'Failed to save settings', 500);
    }
}
