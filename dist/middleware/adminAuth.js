"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminAuthMiddleware = adminAuthMiddleware;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("../config/env");
const response_1 = require("../utils/response");
function adminAuthMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        (0, response_1.error)(res, 'Unauthorized', 401);
        return;
    }
    const token = authHeader.substring(7);
    try {
        const payload = jsonwebtoken_1.default.verify(token, env_1.env.JWT_SECRET);
        // Support both old `adminId` and new `id` token formats
        const resolvedId = payload.id || payload.adminId;
        if (!resolvedId) {
            (0, response_1.error)(res, 'Not an admin token', 403);
            return;
        }
        req.adminId = resolvedId;
        req.adminRole = payload.role;
        next();
    }
    catch {
        (0, response_1.error)(res, 'Invalid or expired token', 401);
    }
}
