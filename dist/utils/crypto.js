"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hmacSha256 = hmacSha256;
exports.md5 = md5;
exports.generateReferralCode = generateReferralCode;
exports.generateSecureToken = generateSecureToken;
exports.timingSafeEqual = timingSafeEqual;
const crypto_1 = __importDefault(require("crypto"));
function hmacSha256(secret, data) {
    return crypto_1.default.createHmac('sha256', secret).update(data).digest('hex');
}
function md5(data) {
    return crypto_1.default.createHash('md5').update(data).digest('hex');
}
function generateReferralCode(length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    const bytes = crypto_1.default.randomBytes(length);
    for (let i = 0; i < length; i++) {
        code += chars[bytes[i] % chars.length];
    }
    return code;
}
function generateSecureToken(bytes = 32) {
    return crypto_1.default.randomBytes(bytes).toString('hex');
}
function timingSafeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return crypto_1.default.timingSafeEqual(bufA, bufB);
}
