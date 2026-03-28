import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { error } from '../utils/response';

export interface AdminJwtPayload {
  adminId?: string;  // legacy
  id?: string;       // new format
  email?: string;
  role: string;
  iat?: number;
  exp?: number;
}

declare global {
  namespace Express {
    interface Request {
      adminId?: string;
      adminRole?: string;
    }
  }
}

export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    error(res, 'Unauthorized', 401);
    return;
  }

  const token = authHeader.substring(7);

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as AdminJwtPayload;

    // Support both old `adminId` and new `id` token formats
    const resolvedId = payload.id || payload.adminId;
    if (!resolvedId) {
      error(res, 'Not an admin token', 403);
      return;
    }

    req.adminId = resolvedId;
    req.adminRole = payload.role;
    next();
  } catch {
    error(res, 'Invalid or expired token', 401);
  }
}
