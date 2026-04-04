import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { getRedisClient } from '../config/redis';
import { prisma } from '../config/database';
import { error } from '../utils/response';

export interface JwtPayload {
  userId: string;
  iat?: number;
  exp?: number;
}

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      user?: {
        id: string;
        name: string | null;
        email: string | null;
        phone: string | null;
        coinBalance: number;
        referralCode: string;
        status: string;
      };
    }
  }
}

// Sets req.userId and req.user if a valid token is present; always calls next()
export async function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { id: true, name: true, email: true, phone: true, coinBalance: true, referralCode: true, status: true },
      });
      if (user && user.status === 'ACTIVE') {
        req.userId = user.id;
        req.user = user;
      }
    } catch {
      // Invalid token — proceed as unauthenticated
    }
  }
  next();
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    error(res, 'Unauthorized', 401);
    return;
  }

  const token = authHeader.substring(7);

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;

    // Check Redis blacklist
    const redis = getRedisClient();
    const blacklisted = await redis.get(`blacklist:${token}`);
    if (blacklisted) {
      error(res, 'Token revoked', 401);
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        coinBalance: true,
        referralCode: true,
        status: true,
      },
    });

    if (!user) {
      error(res, 'User not found', 401);
      return;
    }

    if (user.status !== 'ACTIVE') {
      error(res, 'Account suspended or banned', 403);
      return;
    }

    req.userId = user.id;
    req.user = user;
    next();
  } catch {
    error(res, 'Invalid or expired token', 401);
  }
}
