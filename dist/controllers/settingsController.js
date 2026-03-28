"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSettings = getSettings;
exports.updateSetting = updateSetting;
exports.updateMultipleSettings = updateMultipleSettings;
exports.updateBulkPut = updateBulkPut;
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const logger_1 = require("../utils/logger");
// ─── GET all settings, grouped by category ───────────────────────────────────
async function getSettings(req, res) {
    try {
        const settings = await database_1.prisma.appSettings.findMany({
            orderBy: [{ category: 'asc' }, { key: 'asc' }],
        });
        // Mask secret values and add hasValue flag
        const masked = settings.map(s => ({
            ...s,
            value: s.isSecret && s.value
                ? '••••••••••••' + s.value.slice(-4)
                : s.value,
            _rawValue: s.isSecret ? null : s.value,
            hasValue: s.value.length > 0,
        }));
        // Group by category
        const grouped = {};
        masked.forEach(s => {
            const cat = (s.category || 'GENERAL').toUpperCase();
            if (!grouped[cat])
                grouped[cat] = [];
            grouped[cat].push(s);
        });
        (0, response_1.success)(res, grouped);
    }
    catch (err) {
        logger_1.logger.error('getSettings error:', err);
        (0, response_1.error)(res, 'Failed to get settings', 500);
    }
}
// ─── UPDATE single setting ────────────────────────────────────────────────────
async function updateSetting(req, res) {
    try {
        const { key } = req.params;
        const { value } = req.body;
        if (value === undefined) {
            (0, response_1.error)(res, 'Value required', 400);
            return;
        }
        const adminId = req.adminId;
        const setting = await database_1.prisma.appSettings.upsert({
            where: { key },
            update: { value: String(value), updatedBy: adminId },
            create: {
                key,
                value: String(value),
                label: key,
                category: 'GENERAL',
                isSecret: false,
                updatedBy: adminId,
            },
        });
        process.env[key] = String(value);
        (0, response_1.success)(res, { key: setting.key, hasValue: setting.value.length > 0 }, 'Setting saved!');
    }
    catch (err) {
        logger_1.logger.error('updateSetting error:', err);
        (0, response_1.error)(res, 'Failed to save setting', 500);
    }
}
// ─── UPDATE multiple settings (POST /bulk — legacy) ──────────────────────────
async function updateMultipleSettings(req, res) {
    try {
        const { settings } = req.body;
        if (!Array.isArray(settings)) {
            (0, response_1.error)(res, 'Settings array required', 400);
            return;
        }
        await _bulkSave(settings, req.adminId);
        (0, response_1.success)(res, null, 'Settings saved successfully!');
    }
    catch (err) {
        logger_1.logger.error('updateMultipleSettings error:', err);
        (0, response_1.error)(res, 'Failed to save settings', 500);
    }
}
// ─── UPDATE multiple settings (PUT /bulk/update — new) ───────────────────────
async function updateBulkPut(req, res) {
    try {
        const { settings } = req.body;
        if (!Array.isArray(settings)) {
            (0, response_1.error)(res, 'Settings array required', 400);
            return;
        }
        await _bulkSave(settings, req.adminId);
        (0, response_1.success)(res, null, 'All settings saved!');
    }
    catch (err) {
        logger_1.logger.error('updateBulkPut error:', err);
        (0, response_1.error)(res, 'Failed to save settings', 500);
    }
}
async function _bulkSave(settings, adminId) {
    for (const s of settings) {
        if (!s.key || s.value === undefined || s.value === '')
            continue;
        await database_1.prisma.appSettings.updateMany({
            where: { key: s.key },
            data: { value: String(s.value), updatedBy: adminId },
        });
        process.env[s.key] = String(s.value);
    }
}
