"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pubscaleCallback = pubscaleCallback;
exports.toroxCallback = toroxCallback;
exports.ayetCallback = ayetCallback;
const offerwallService_1 = require("../services/offerwallService");
const logger_1 = require("../utils/logger");
async function pubscaleCallback(req, res) {
    const query = req.query;
    const { user_id, offer_id, coins, sig } = query;
    if (!user_id || !offer_id || !coins || !sig) {
        res.status(400).send('Bad Request');
        return;
    }
    const valid = await (0, offerwallService_1.verifyPubscaleSignature)(query, sig);
    if (!valid) {
        logger_1.logger.warn('Pubscale invalid signature', { query });
        res.status(403).send('Invalid signature');
        return;
    }
    try {
        const result = await (0, offerwallService_1.processPostback)({
            userId: user_id,
            offerId: offer_id,
            coins: parseInt(coins, 10),
            provider: 'pubscale',
            rawData: query,
        });
        res.status(200).send(result.duplicate ? 'ALREADY_CREDITED' : 'OK');
    }
    catch (err) {
        logger_1.logger.error('Pubscale postback error', { err });
        res.status(500).send('ERROR');
    }
}
async function toroxCallback(req, res) {
    const { user_id, offer_id, coins, sig } = req.query;
    if (!user_id || !offer_id || !coins || !sig) {
        res.status(400).send('Bad Request');
        return;
    }
    const valid = await (0, offerwallService_1.verifyToroxSignature)(user_id, offer_id, coins, sig);
    if (!valid) {
        logger_1.logger.warn('Torox invalid signature', { user_id, offer_id });
        res.status(403).send('Invalid signature');
        return;
    }
    try {
        const result = await (0, offerwallService_1.processPostback)({
            userId: user_id,
            offerId: offer_id,
            coins: parseInt(coins, 10),
            provider: 'torox',
            rawData: req.query,
        });
        res.status(200).send(result.duplicate ? '2' : '1');
    }
    catch (err) {
        logger_1.logger.error('Torox postback error', { err });
        res.status(500).send('0');
    }
}
async function ayetCallback(req, res) {
    const query = req.query;
    const { user_id, offer_id, coins, signature } = query;
    if (!user_id || !offer_id || !coins || !signature) {
        res.status(400).send('Bad Request');
        return;
    }
    const valid = await (0, offerwallService_1.verifyAyetSignature)(query, signature);
    if (!valid) {
        logger_1.logger.warn('AyetStudios invalid signature', { query });
        res.status(403).send('Invalid signature');
        return;
    }
    try {
        const result = await (0, offerwallService_1.processPostback)({
            userId: user_id,
            offerId: offer_id,
            coins: parseInt(coins, 10),
            provider: 'ayetstudios',
            rawData: query,
        });
        res.status(200).json({ status: result.duplicate ? 'duplicate' : 'success' });
    }
    catch (err) {
        logger_1.logger.error('AyetStudios postback error', { err });
        res.status(500).json({ status: 'error' });
    }
}
