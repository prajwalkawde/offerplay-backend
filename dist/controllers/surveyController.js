"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSurveys = getSurveys;
exports.getSurveyWallUrl = getSurveyWallUrl;
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const logger_1 = require("../utils/logger");
const surveyService_1 = require("../services/surveyService");
async function getSurveys(req, res) {
    try {
        const userId = req.userId;
        const user = await database_1.prisma.user.findUnique({
            where: { id: userId },
            select: { email: true },
        });
        const rawIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '';
        const realIp = rawIp.split(',')[0].trim();
        const surveys = await (0, surveyService_1.getCPXSurveys)(userId, user?.email ?? undefined, realIp);
        (0, response_1.success)(res, { total: surveys.length, surveys });
    }
    catch (err) {
        logger_1.logger.error('getSurveys error:', err);
        (0, response_1.error)(res, 'Failed to fetch surveys', 500);
    }
}
async function getSurveyWallUrl(req, res) {
    try {
        const userId = req.userId;
        const user = await database_1.prisma.user.findUnique({
            where: { id: userId },
            select: { email: true },
        });
        const url = (0, surveyService_1.getCPXSurveyWallUrl)(userId, user?.email ?? undefined);
        (0, response_1.success)(res, { url });
    }
    catch (err) {
        (0, response_1.error)(res, 'Failed to get survey wall URL', 500);
    }
}
