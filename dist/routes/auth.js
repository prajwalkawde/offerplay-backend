"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const validate_1 = require("../middleware/validate");
const auth_1 = require("../middleware/auth");
const rateLimit_1 = require("../middleware/rateLimit");
const authController_1 = require("../controllers/authController");
const router = (0, express_1.Router)();
const phoneSchema = zod_1.z.object({ phone: zod_1.z.string().min(10).max(15) });
const verifyPhoneSchema = zod_1.z.object({
    idToken: zod_1.z.string().min(1),
    referralCode: zod_1.z.string().optional(),
    fcmToken: zod_1.z.string().optional(),
    deviceId: zod_1.z.string().optional(),
});
const googleSchema = zod_1.z.object({
    idToken: zod_1.z.string().min(1),
    fcmToken: zod_1.z.string().optional(),
    deviceId: zod_1.z.string().optional(),
});
router.post('/phone/send-otp', rateLimit_1.otpRateLimit, (0, validate_1.validate)(phoneSchema), authController_1.sendOtp);
router.post('/phone/verify', (0, validate_1.validate)(verifyPhoneSchema), authController_1.verifyPhone);
router.post('/google', (0, validate_1.validate)(googleSchema), authController_1.googleAuth);
router.post('/logout', auth_1.authMiddleware, authController_1.logout);
router.get('/me', auth_1.authMiddleware, authController_1.getMe);
// ─── Dev-only login (generates real JWT for test accounts) ───────────────────
if (process.env.NODE_ENV !== 'production') {
    const { devLogin } = require('../controllers/authController');
    router.post('/dev/login', devLogin);
}
exports.default = router;
