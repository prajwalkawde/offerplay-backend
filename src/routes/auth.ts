import { Router } from 'express';
import { z } from 'zod';
import { Request, Response } from 'express';
import { validate } from '../middleware/validate';
import { authMiddleware } from '../middleware/auth';
import { otpRateLimit } from '../middleware/rateLimit';
import {
  sendOtp, verifyPhone, googleAuth, logout, getMe,
  completeProfile, updateFCMToken, updateProfile,
} from '../controllers/authController';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';

const router = Router();

const phoneSchema = z.object({ phone: z.string().min(10).max(15) });

const verifyPhoneSchema = z.object({
  phone:        z.string().min(10).max(15),
  otp:          z.string().length(6),
  referralCode: z.string().optional(),
  fcmToken:     z.string().optional(),
  deviceId:     z.string().optional(),
  appVersion:   z.string().optional(),
});

const googleSchema = z.object({
  idToken:      z.string().min(1),
  fcmToken:     z.string().optional(),
  deviceId:     z.string().optional(),
  referralCode: z.string().optional(),
});

const completeProfileSchema = z.object({
  name:          z.string().min(2).max(50),
  email:         z.string().email().optional(),
  dateOfBirth:   z.string().optional(),
  city:          z.string().max(50).optional(),
  state:         z.string().max(50).optional(),
  country:       z.string().max(5).optional(),
  favouriteTeam: z.string().max(10).optional(),
  referralCode:  z.string().optional(),
});

const fcmSchema = z.object({ fcmToken: z.string().min(1) });

router.post('/phone/send-otp',    otpRateLimit, validate(phoneSchema),         sendOtp);
router.post('/phone/verify',      validate(verifyPhoneSchema),                  verifyPhone);
router.post('/google',            validate(googleSchema),                       googleAuth);
router.post('/complete-profile',  authMiddleware, validate(completeProfileSchema), completeProfile);
router.post('/update-fcm',        authMiddleware, validate(fcmSchema),          updateFCMToken);
router.put('/update-profile',     authMiddleware, updateProfile);
router.post('/logout',            authMiddleware,                               logout);
router.get('/me',                 authMiddleware,                               getMe);

// ─── Delete account (Google Play requirement) ─────────────────────────────────
router.delete('/account', authMiddleware, async (req: Request, res: Response) => {
  try {
    const userId = req.userId!;
    await prisma.user.update({
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
    return success(res, null, 'Account deleted successfully');
  } catch (err) {
    return error(res, 'Failed to delete account', 500);
  }
});

// ─── Dev-only login (generates real JWT for test accounts) ───────────────────
if (process.env.NODE_ENV !== 'production') {
  const { devLogin } = require('../controllers/authController');
  router.post('/dev/login', devLogin);
}

export default router;
