import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { getRedisClient, rk } from '../config/redis';
import { success, error, paginated } from '../utils/response';
import { logger } from '../utils/logger';
import { logFraudEvent, deductTrustScore } from '../services/fraudDetection.service';

// ─── Settings ────────────────────────────────────────────────────────────────

export async function getSecuritySettings(req: Request, res: Response): Promise<void> {
  try {
    const settings = await prisma.securitySettings.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1 },
    });
    success(res, settings);
  } catch (err) {
    logger.error('[AdminSecurity] getSecuritySettings error:', err);
    error(res, 'Failed to fetch security settings');
  }
}

export async function updateSecuritySettings(req: Request, res: Response): Promise<void> {
  try {
    const updated = await prisma.securitySettings.update({
      where: { id: 1 },
      data: req.body,
    });

    // Clear Redis cache so new settings take effect immediately
    try {
      const redis = getRedisClient();
      await redis.del(rk('security:settings'));
    } catch {
      // ignore
    }

    success(res, updated, 'Security settings updated');
  } catch (err) {
    logger.error('[AdminSecurity] updateSecuritySettings error:', err);
    error(res, 'Failed to update security settings');
  }
}

// ─── IP Records ──────────────────────────────────────────────────────────────

export async function getIpRecords(req: Request, res: Response): Promise<void> {
  try {
    const {
      isFlagged,
      isBlocked,
      isVpn,
      search,
      page = '1',
      limit = '20',
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const where: Record<string, unknown> = {};
    if (isFlagged === 'true') where.isFlagged = true;
    if (isBlocked === 'true') where.isBlocked = true;
    if (isVpn === 'true') where.isVpn = true;
    if (search) where.ipAddress = { contains: search };

    const [records, total] = await Promise.all([
      prisma.ipRecord.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { lastSeen: 'desc' },
      }),
      prisma.ipRecord.count({ where }),
    ]);

    const data = records.map((r) => ({
      ...r,
      accountCount: r.uids.length,
    }));

    paginated(res, data, total, pageNum, limitNum);
  } catch (err) {
    logger.error('[AdminSecurity] getIpRecords error:', err);
    error(res, 'Failed to fetch IP records');
  }
}

export async function blockIpRecord(req: Request, res: Response): Promise<void> {
  try {
    const ip = req.params.ip as string;
    const { reason } = req.body as { reason: string };

    const record = await prisma.ipRecord.upsert({
      where: { ipAddress: ip },
      update: { isBlocked: true, isFlagged: true, flagReason: reason },
      create: { ipAddress: ip, uids: [], isBlocked: true, isFlagged: true, flagReason: reason },
    });

    // Deduct trust score from all affected users
    for (const uid of record.uids) {
      await deductTrustScore(uid, 60, 'ip_manually_blocked');
      await logFraudEvent({
        uid,
        eventType: 'ip_blocked_by_admin',
        severity: 'high',
        description: `IP ${ip} manually blocked by admin: ${reason}`,
        ipAddress: ip,
      });
    }

    success(res, record, 'IP blocked');
  } catch (err) {
    logger.error('[AdminSecurity] blockIpRecord error:', err);
    error(res, 'Failed to block IP');
  }
}

export async function unblockIpRecord(req: Request, res: Response): Promise<void> {
  try {
    const ip = req.params.ip as string;

    const record = await prisma.ipRecord.update({
      where: { ipAddress: ip },
      data: { isBlocked: false, isFlagged: false, flagReason: null },
    });

    success(res, record, 'IP unblocked');
  } catch (err) {
    logger.error('[AdminSecurity] unblockIpRecord error:', err);
    error(res, 'Failed to unblock IP');
  }
}

// ─── Fraud Logs ──────────────────────────────────────────────────────────────

export async function getFraudLogs(req: Request, res: Response): Promise<void> {
  try {
    const {
      severity,
      eventType,
      uid,
      dateFrom,
      dateTo,
      isResolved,
      page = '1',
      limit = '20',
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const where: Record<string, unknown> = {};
    if (severity) where.severity = severity;
    if (eventType) where.eventType = eventType;
    if (uid) where.uid = { contains: uid };
    if (isResolved !== undefined) where.isResolved = isResolved === 'true';
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) (where.createdAt as Record<string, unknown>).gte = new Date(dateFrom);
      if (dateTo) (where.createdAt as Record<string, unknown>).lte = new Date(dateTo);
    }

    const [logs, total] = await Promise.all([
      prisma.fraudLog.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.fraudLog.count({ where }),
    ]);

    paginated(res, logs, total, pageNum, limitNum);
  } catch (err) {
    logger.error('[AdminSecurity] getFraudLogs error:', err);
    error(res, 'Failed to fetch fraud logs');
  }
}

export async function resolveFraudLog(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    const { resolution } = req.body as { resolution: string };

    const log = await prisma.fraudLog.update({
      where: { id },
      data: {
        isResolved: true,
        resolvedBy: req.adminId,
        resolvedAt: new Date(),
        metadata: { resolution },
      },
    });

    success(res, log, 'Fraud log resolved');
  } catch (err) {
    logger.error('[AdminSecurity] resolveFraudLog error:', err);
    error(res, 'Failed to resolve fraud log');
  }
}

// ─── Trust Score / Users ─────────────────────────────────────────────────────

export async function getSecurityUsers(req: Request, res: Response): Promise<void> {
  try {
    const {
      isBanned,
      isRestricted,
      minScore,
      maxScore,
      search,
      page = '1',
      limit = '20',
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const where: Record<string, unknown> = {};
    if (isBanned !== undefined) where.isBanned = isBanned === 'true';
    if (isRestricted !== undefined) where.isRestricted = isRestricted === 'true';
    if (search) where.uid = { contains: search };
    if (minScore || maxScore) {
      where.trustScore = {};
      if (minScore) (where.trustScore as Record<string, unknown>).gte = parseInt(minScore, 10);
      if (maxScore) (where.trustScore as Record<string, unknown>).lte = parseInt(maxScore, 10);
    }

    const [users, total] = await Promise.all([
      prisma.userTrustScore.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { trustScore: 'asc' },
      }),
      prisma.userTrustScore.count({ where }),
    ]);

    paginated(res, users, total, pageNum, limitNum);
  } catch (err) {
    logger.error('[AdminSecurity] getSecurityUsers error:', err);
    error(res, 'Failed to fetch security users');
  }
}

export async function banUser(req: Request, res: Response): Promise<void> {
  try {
    const uid = req.params.uid as string;
    const { reason } = req.body as { reason: string };

    const record = await prisma.userTrustScore.upsert({
      where: { uid },
      update: {
        isBanned: true,
        isRestricted: true,
        banReason: reason,
        bannedAt: new Date(),
        bannedBy: req.adminId,
      },
      create: {
        uid,
        isBanned: true,
        isRestricted: true,
        banReason: reason,
        bannedAt: new Date(),
        bannedBy: req.adminId,
      },
    });

    await logFraudEvent({
      uid,
      eventType: 'manual_ban',
      severity: 'critical',
      description: `Manually banned by admin ${req.adminId}: ${reason}`,
    });

    success(res, record, 'User banned');
  } catch (err) {
    logger.error('[AdminSecurity] banUser error:', err);
    error(res, 'Failed to ban user');
  }
}

export async function unbanUser(req: Request, res: Response): Promise<void> {
  try {
    const uid = req.params.uid as string;

    const record = await prisma.userTrustScore.upsert({
      where: { uid },
      update: {
        isBanned: false,
        banReason: null,
        bannedAt: null,
        bannedBy: null,
      },
      create: { uid },
    });

    await logFraudEvent({
      uid,
      eventType: 'manual_unban',
      severity: 'low',
      description: `Unbanned by admin ${req.adminId}`,
    });

    success(res, record, 'User unbanned');
  } catch (err) {
    logger.error('[AdminSecurity] unbanUser error:', err);
    error(res, 'Failed to unban user');
  }
}

export async function restrictUser(req: Request, res: Response): Promise<void> {
  try {
    const uid = req.params.uid as string;

    const record = await prisma.userTrustScore.upsert({
      where: { uid },
      update: { isRestricted: true },
      create: { uid, isRestricted: true },
    });

    success(res, record, 'User restricted');
  } catch (err) {
    logger.error('[AdminSecurity] restrictUser error:', err);
    error(res, 'Failed to restrict user');
  }
}

export async function unrestrictUser(req: Request, res: Response): Promise<void> {
  try {
    const uid = req.params.uid as string;

    const record = await prisma.userTrustScore.upsert({
      where: { uid },
      update: { isRestricted: false },
      create: { uid },
    });

    success(res, record, 'User unrestricted');
  } catch (err) {
    logger.error('[AdminSecurity] unrestrictUser error:', err);
    error(res, 'Failed to unrestrict user');
  }
}

export async function setUserTrustScore(req: Request, res: Response): Promise<void> {
  try {
    const uid = req.params.uid as string;
    const { score, reason } = req.body as { score: number; reason: string };

    const record = await prisma.userTrustScore.upsert({
      where: { uid },
      update: { trustScore: score },
      create: { uid, trustScore: score },
    });

    await logFraudEvent({
      uid,
      eventType: 'trust_score_manual_set',
      severity: 'low',
      description: `Trust score set to ${score} by admin ${req.adminId}: ${reason}`,
    });

    success(res, record, 'Trust score updated');
  } catch (err) {
    logger.error('[AdminSecurity] setUserTrustScore error:', err);
    error(res, 'Failed to set trust score');
  }
}

// ─── Overview ────────────────────────────────────────────────────────────────

export async function getSecurityOverview(req: Request, res: Response): Promise<void> {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [
      totalFlaggedIps,
      totalBlockedIps,
      totalVpnIps,
      totalBannedUsers,
      totalRestrictedUsers,
      fraudEventsToday,
      fraudByType,
      fraudBySeverity,
      topOffenders,
      recentEvents,
      multiAccountIps,
    ] = await Promise.allSettled([
      prisma.ipRecord.count({ where: { isFlagged: true } }),
      prisma.ipRecord.count({ where: { isBlocked: true } }),
      prisma.ipRecord.count({ where: { isVpn: true } }),
      prisma.userTrustScore.count({ where: { isBanned: true } }),
      prisma.userTrustScore.count({ where: { isRestricted: true, isBanned: false } }),
      prisma.fraudLog.count({ where: { createdAt: { gte: todayStart } } }),
      prisma.fraudLog.groupBy({
        by: ['eventType'],
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 10,
      }),
      prisma.fraudLog.groupBy({
        by: ['severity'],
        _count: { id: true },
      }),
      prisma.userTrustScore.findMany({
        orderBy: { trustScore: 'asc' },
        take: 10,
        select: { uid: true, trustScore: true, totalFraudEvents: true, isBanned: true },
      }),
      prisma.fraudLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.ipRecord.findMany({
        orderBy: { requestCount: 'desc' },
        take: 20,
        select: { ipAddress: true, uids: true, country: true, isFlagged: true, isVpn: true },
      }),
    ]);

    const severityMap: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    if (fraudBySeverity.status === 'fulfilled') {
      for (const row of fraudBySeverity.value) {
        severityMap[row.severity] = row._count.id;
      }
    }

    success(res, {
      totalFlaggedIps:     totalFlaggedIps.status === 'fulfilled' ? totalFlaggedIps.value : 0,
      totalBlockedIps:     totalBlockedIps.status === 'fulfilled' ? totalBlockedIps.value : 0,
      totalVpnIps:         totalVpnIps.status === 'fulfilled' ? totalVpnIps.value : 0,
      totalBannedUsers:    totalBannedUsers.status === 'fulfilled' ? totalBannedUsers.value : 0,
      totalRestrictedUsers: totalRestrictedUsers.status === 'fulfilled' ? totalRestrictedUsers.value : 0,
      fraudEventsToday:    fraudEventsToday.status === 'fulfilled' ? fraudEventsToday.value : 0,
      fraudEventsByType:   fraudByType.status === 'fulfilled'
        ? fraudByType.value.map((r) => ({ type: r.eventType, count: r._count.id }))
        : [],
      fraudEventsBySeverity: severityMap,
      topOffenders:        topOffenders.status === 'fulfilled' ? topOffenders.value : [],
      recentEvents:        recentEvents.status === 'fulfilled' ? recentEvents.value : [],
      multiAccountIps:     multiAccountIps.status === 'fulfilled'
        ? multiAccountIps.value
            .filter((r) => r.uids.length > 1)
            .map((r) => ({
              ip: r.ipAddress,
              accountCount: r.uids.length,
              country: r.country,
              isFlagged: r.isFlagged,
              isVpn: r.isVpn,
            }))
            .sort((a, b) => b.accountCount - a.accountCount)
        : [],
    });
  } catch (err) {
    logger.error('[AdminSecurity] getSecurityOverview error:', err);
    error(res, 'Failed to fetch security overview');
  }
}
