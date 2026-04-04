import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authMiddleware } from '../middleware/auth';
import { otpRateLimit } from '../middleware/rateLimit';
import {
  sendOtp, verifyPhone, googleAuth, logout, getMe,
} from '../controllers/authController';

const router = Router();

const phoneSchema = z.object({ phone: z.string().min(10).max(15) });
const verifyPhoneSchema = z.object({
  idToken: z.string().min(1),
  referralCode: z.string().optional(),
  fcmToken: z.string().optional(),
  deviceId: z.string().optional(),
});
const googleSchema = z.object({
  idToken: z.string().min(1),
  fcmToken: z.string().optional(),
  deviceId: z.string().optional(),
});

router.post('/phone/send-otp', otpRateLimit, validate(phoneSchema), sendOtp);
router.post('/phone/verify', validate(verifyPhoneSchema), verifyPhone);
router.post('/google', validate(googleSchema), googleAuth);
router.post('/logout', authMiddleware, logout);
router.get('/me', authMiddleware, getMe);

// ─── Dev-only login (generates real JWT for test accounts) ───────────────────
if (process.env.NODE_ENV !== 'production') {
  const { devLogin } = require('../controllers/authController');
  router.post('/dev/login', devLogin);
}

export default router;
