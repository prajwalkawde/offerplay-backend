"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const validate_1 = require("../middleware/validate");
const auth_1 = require("../middleware/auth");
const rateLimit_1 = require("../middleware/rateLimit");
const authController_1 = require("../controllers/authController");
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const router = (0, express_1.Router)();
const phoneSchema = zod_1.z.object({ phone: zod_1.z.string().min(10).max(15) });
const verifyPhoneSchema = zod_1.z.object({
    phone: zod_1.z.string().min(10).max(15),
    otp: zod_1.z.string().length(6),
    referralCode: zod_1.z.string().optional(),
    fcmToken: zod_1.z.string().optional(),
    deviceId: zod_1.z.string().optional(),
    appVersion: zod_1.z.string().optional(),
});
const googleSchema = zod_1.z.object({
    idToken: zod_1.z.string().min(1),
    fcmToken: zod_1.z.string().optional(),
    deviceId: zod_1.z.string().optional(),
});
const completeProfileSchema = zod_1.z.object({
    name: zod_1.z.string().min(2).max(50),
    email: zod_1.z.string().email().optional(),
    dateOfBirth: zod_1.z.string().optional(),
    city: zod_1.z.string().max(50).optional(),
    state: zod_1.z.string().max(50).optional(),
    country: zod_1.z.string().max(5).optional(),
    favouriteTeam: zod_1.z.string().max(10).optional(),
    referralCode: zod_1.z.string().optional(),
});
const fcmSchema = zod_1.z.object({ fcmToken: zod_1.z.string().min(1) });
router.post('/phone/send-otp', rateLimit_1.otpRateLimit, (0, validate_1.validate)(phoneSchema), authController_1.sendOtp);
router.post('/phone/verify', (0, validate_1.validate)(verifyPhoneSchema), authController_1.verifyPhone);
router.post('/google', (0, validate_1.validate)(googleSchema), authController_1.googleAuth);
router.post('/complete-profile', auth_1.authMiddleware, (0, validate_1.validate)(completeProfileSchema), authController_1.completeProfile);
router.post('/update-fcm', auth_1.authMiddleware, (0, validate_1.validate)(fcmSchema), authController_1.updateFCMToken);
router.put('/update-profile', auth_1.authMiddleware, authController_1.updateProfile);
router.post('/logout', auth_1.authMiddleware, authController_1.logout);
router.get('/me', auth_1.authMiddleware, authController_1.getMe);
// ─── Delete account (Google Play requirement) ─────────────────────────────────
router.delete('/account', auth_1.authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        await database_1.prisma.user.update({
            where: { id: userId },
            data: {
                status: 'BANNED',
                name: 'Deleted User',
                email: null,
                phone: `DELETED_${Date.now()}`,
                fcmToken: null,
                oneSignalPlayerId: null,
            },
        });
        return (0, response_1.success)(res, null, 'Account deleted successfully');
    }
    catch (err) {
        return (0, response_1.error)(res, 'Failed to delete account', 500);
    }
});
// ─── Dev-only login (generates real JWT for test accounts) ───────────────────
if (process.env.NODE_ENV !== 'production') {
    const { devLogin } = require('../controllers/authController');
    router.post('/dev/login', devLogin);
}
exports.default = router;
