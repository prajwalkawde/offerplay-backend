"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const postbackService_1 = require("../services/postbackService");
const surveyService_1 = require("../services/surveyService");
const router = (0, express_1.Router)();
// PubScale — GET (providers redirect here)
router.get('/pubscale', async (req, res) => {
    const result = await (0, postbackService_1.receivePubScalePostback)(req.query);
    res.send(result);
});
// Torox
router.get('/torox', async (req, res) => {
    const result = await (0, postbackService_1.receiveToroxPostback)(req.query);
    res.send(result);
});
// AyeT Studios (both paths for compatibility)
router.get('/ayetstudio', async (req, res) => {
    const result = await (0, postbackService_1.receiveAyetPostback)(req.query);
    res.send(result);
});
router.get('/ayet', async (req, res) => {
    const result = await (0, postbackService_1.receiveAyetPostback)(req.query);
    res.send(result);
});
// CPX Research
router.get('/cpx', async (req, res) => {
    const result = await (0, surveyService_1.handleCPXPostback)(req.query);
    res.send(result);
});
router.post('/cpx', async (req, res) => {
    const result = await (0, surveyService_1.handleCPXPostback)({ ...req.query, ...req.body });
    res.send(result);
});
exports.default = router;
