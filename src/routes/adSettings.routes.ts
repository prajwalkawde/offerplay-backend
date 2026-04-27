import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { adminAuthMiddleware } from '../middleware/adminAuth';
import {
  getMobileAdSettings,
  getAdminAdSettings,
  updateAdminAdSettings,
} from '../controllers/adSettings.controller';

const mobile = Router();
mobile.use(authMiddleware);
mobile.get('/ad-settings', getMobileAdSettings);

const admin = Router();
admin.use(adminAuthMiddleware);
admin.get('/ad-settings', getAdminAdSettings);
admin.put('/ad-settings', updateAdminAdSettings);

export { mobile as adSettingsMobileRouter, admin as adSettingsAdminRouter };
