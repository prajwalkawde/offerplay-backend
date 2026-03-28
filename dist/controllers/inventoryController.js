"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getInventory = getInventory;
exports.createInventoryItem = createInventoryItem;
exports.updateInventoryItem = updateInventoryItem;
exports.deleteInventoryItem = deleteInventoryItem;
exports.getSponsors = getSponsors;
exports.createSponsor = createSponsor;
exports.updateSponsor = updateSponsor;
exports.getPublicInventory = getPublicInventory;
exports.getPublicSponsors = getPublicSponsors;
exports.getIplPrizeClaims = getIplPrizeClaims;
exports.updateIplPrizeClaim = updateIplPrizeClaim;
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const logger_1 = require("../utils/logger");
// ─── Inventory CRUD (Admin) ────────────────────────────────────────────────────
async function getInventory(_req, res) {
    try {
        const items = await database_1.prisma.prizeInventory.findMany({
            orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
        });
        (0, response_1.success)(res, items);
    }
    catch (err) {
        logger_1.logger.error('getInventory error:', err);
        (0, response_1.error)(res, 'Failed to get inventory', 500);
    }
}
async function createInventoryItem(req, res) {
    try {
        const { name, description, imageUrl, category, marketValue, purchaseLink, provider, providerLogo, stock, displayOrder, } = req.body;
        if (!name || marketValue === undefined) {
            (0, response_1.error)(res, 'Name and marketValue are required', 400);
            return;
        }
        const item = await database_1.prisma.prizeInventory.create({
            data: {
                name,
                description: description || '',
                imageUrl: imageUrl || '',
                category: category || 'gadget',
                marketValue: parseInt(String(marketValue)),
                purchaseLink: purchaseLink || '',
                provider: provider || 'amazon',
                providerLogo: providerLogo || '',
                stock: parseInt(String(stock ?? 1)),
                displayOrder: parseInt(String(displayOrder ?? 0)),
            },
        });
        (0, response_1.success)(res, item, 'Item added to inventory!', 201);
    }
    catch (err) {
        logger_1.logger.error('createInventoryItem error:', err);
        (0, response_1.error)(res, 'Failed to create item', 500);
    }
}
async function updateInventoryItem(req, res) {
    try {
        const { id } = req.params;
        const { entries: _e, ...safeData } = req.body;
        const item = await database_1.prisma.prizeInventory.update({
            where: { id },
            data: safeData,
        });
        (0, response_1.success)(res, item, 'Item updated!');
    }
    catch (err) {
        logger_1.logger.error('updateInventoryItem error:', err);
        (0, response_1.error)(res, 'Failed to update item', 500);
    }
}
async function deleteInventoryItem(req, res) {
    try {
        const { id } = req.params;
        await database_1.prisma.prizeInventory.delete({ where: { id } });
        (0, response_1.success)(res, null, 'Item deleted!');
    }
    catch (err) {
        logger_1.logger.error('deleteInventoryItem error:', err);
        (0, response_1.error)(res, 'Failed to delete item', 500);
    }
}
// ─── Sponsors CRUD (Admin) ────────────────────────────────────────────────────
async function getSponsors(_req, res) {
    try {
        const sponsors = await database_1.prisma.contestSponsor.findMany({
            orderBy: { name: 'asc' },
        });
        (0, response_1.success)(res, sponsors);
    }
    catch (err) {
        logger_1.logger.error('getSponsors error:', err);
        (0, response_1.error)(res, 'Failed to get sponsors', 500);
    }
}
async function createSponsor(req, res) {
    try {
        const { name, logoUrl, websiteUrl } = req.body;
        if (!name) {
            (0, response_1.error)(res, 'Sponsor name is required', 400);
            return;
        }
        const sponsor = await database_1.prisma.contestSponsor.create({
            data: { name, logoUrl, websiteUrl },
        });
        (0, response_1.success)(res, sponsor, 'Sponsor added!', 201);
    }
    catch (err) {
        logger_1.logger.error('createSponsor error:', err);
        (0, response_1.error)(res, 'Failed to create sponsor', 500);
    }
}
async function updateSponsor(req, res) {
    try {
        const { id } = req.params;
        const sponsor = await database_1.prisma.contestSponsor.update({
            where: { id },
            data: req.body,
        });
        (0, response_1.success)(res, sponsor, 'Sponsor updated!');
    }
    catch (err) {
        logger_1.logger.error('updateSponsor error:', err);
        (0, response_1.error)(res, 'Failed to update sponsor', 500);
    }
}
// ─── Public endpoints (mobile app) ────────────────────────────────────────────
async function getPublicInventory(_req, res) {
    try {
        const items = await database_1.prisma.prizeInventory.findMany({
            where: { isActive: true, stock: { gt: 0 } },
            orderBy: [{ displayOrder: 'asc' }],
            select: {
                id: true, name: true, description: true,
                imageUrl: true, category: true,
                marketValue: true, provider: true, providerLogo: true,
            },
        });
        (0, response_1.success)(res, items);
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to get inventory', 500);
    }
}
async function getPublicSponsors(_req, res) {
    try {
        const sponsors = await database_1.prisma.contestSponsor.findMany({
            where: { isActive: true },
            orderBy: { name: 'asc' },
        });
        (0, response_1.success)(res, sponsors);
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to get sponsors', 500);
    }
}
// ─── IPL Prize Claims admin view ──────────────────────────────────────────────
async function getIplPrizeClaims(req, res) {
    try {
        const status = req.query.status || '';
        const where = status ? { status } : {};
        const claims = await database_1.prisma.iplPrizeClaim.findMany({
            where,
            include: {
                user: { select: { id: true, name: true, phone: true } },
                contest: { select: { id: true, name: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
        (0, response_1.success)(res, { claims, total: claims.length });
    }
    catch (err) {
        logger_1.logger.error('getIplPrizeClaims error:', err);
        (0, response_1.error)(res, 'Failed to get prize claims', 500);
    }
}
async function updateIplPrizeClaim(req, res) {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const claim = await database_1.prisma.iplPrizeClaim.update({
            where: { id },
            data: { status },
        });
        (0, response_1.success)(res, claim, 'Claim updated!');
    }
    catch (err) {
        logger_1.logger.error('updateIplPrizeClaim error:', err);
        (0, response_1.error)(res, 'Failed to update claim', 500);
    }
}
