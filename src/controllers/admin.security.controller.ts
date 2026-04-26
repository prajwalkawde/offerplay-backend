import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
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

// ─── Flagged Users ────────────────────────────────────────────────────────────

// Returns users who would have been auto-banned if autoBanEnabled were on, OR
// users who have triggered fraud signals recently. Lets admin review and act
// manually rather than the system auto-banning.
export async function getFlaggedUsers(req: Request, res: Response): Promise<void> {
  try {
    const {
      severity,        // 'critical' (trust<=20) | 'high' (trust<=50) | 'all' (any flag)
      onlyActive,      // 'true' to exclude already-banned
      sortBy,          // 'trust' | 'events' | 'recent'
      search,          // user name/phone/email
      page = '1',
      limit = '25',
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const settings = await prisma.securitySettings.findUnique({ where: { id: 1 } });
    const autobanThreshold = settings?.autobanTrustScore ?? 20;
    const restrictThreshold = settings?.autoRestrictTrustScore ?? 50;

    const where: Prisma.UserTrustScoreWhereInput = {};
    if (severity === 'critical') where.trustScore = { lte: autobanThreshold };
    else if (severity === 'high') where.trustScore = { lte: restrictThreshold };
    else where.OR = [
      { trustScore: { lte: restrictThreshold } },
      { totalFraudEvents: { gt: 0 } },
    ];
    if (onlyActive === 'true') {
      where.isBanned = false;
    }

    let orderBy: Prisma.UserTrustScoreOrderByWithRelationInput = { trustScore: 'asc' };
    if (sortBy === 'events') orderBy = { totalFraudEvents: 'desc' };
    else if (sortBy === 'recent') orderBy = { lastFraudEventAt: 'desc' };

    const [trustRecords, total] = await Promise.all([
      prisma.userTrustScore.findMany({ where, orderBy, skip, take: limitNum }),
      prisma.userTrustScore.count({ where }),
    ]);

    // Hydrate user info — search across the hydrated set if requested
    const uids = trustRecords.map(r => r.uid);
    let users = await prisma.user.findMany({
      where: { id: { in: uids } },
      select: {
        id: true, name: true, phone: true, email: true, status: true,
        coinBalance: true, ticketBalance: true, createdAt: true, lastLoginAt: true,
      },
    });
    if (search) {
      const s = search.toLowerCase();
      users = users.filter(u =>
        u.name?.toLowerCase().includes(s) ||
        u.phone?.includes(search) ||
        u.email?.toLowerCase().includes(s),
      );
    }
    const usersById = new Map(users.map(u => [u.id, u]));

    // Recent fraud-event counts per user (last 7 days) for severity context
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentEvents = await prisma.fraudLog.groupBy({
      by: ['uid'],
      where: { uid: { in: uids }, createdAt: { gte: sevenDaysAgo } },
      _count: true,
    });
    const recentByUid = new Map(recentEvents.map(e => [e.uid, e._count]));

    const data = trustRecords
      .map(t => {
        const user = usersById.get(t.uid);
        if (!user && search) return null; // filtered out by search
        return {
          uid: t.uid,
          user: user ?? null,
          trustScore: t.trustScore,
          isBanned: t.isBanned,
          isRestricted: t.isRestricted,
          banReason: t.banReason,
          totalFraudEvents: t.totalFraudEvents,
          recentFraudEvents7d: recentByUid.get(t.uid) ?? 0,
          lastFraudEventAt: t.lastFraudEventAt,
          updatedAt: t.updatedAt,
          // Severity tier for UI badge
          severity:
            t.trustScore <= autobanThreshold ? 'critical' :
            t.trustScore <= restrictThreshold ? 'high' :
            t.totalFraudEvents > 0 ? 'medium' : 'low',
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    paginated(res, data, total, pageNum, limitNum);
  } catch (err) {
    logger.error('[AdminSecurity] getFlaggedUsers error:', err);
    error(res, 'Failed to fetch flagged users');
  }
}

// Drill-in for one user: trust record + recent fraud events + IP/device shared accounts
export async function getFlaggedUserDetail(req: Request, res: Response): Promise<void> {
  try {
    const uid = req.params.uid as string;

    const [user, trust, events] = await Promise.all([
      prisma.user.findUnique({
        where: { id: uid },
        select: {
          id: true, name: true, phone: true, email: true, status: true,
          coinBalance: true, ticketBalance: true, createdAt: true, lastLoginAt: true,
        },
      }),
      prisma.userTrustScore.findUnique({ where: { uid } }),
      prisma.fraudLog.findMany({
        where: { uid },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    if (!user) { error(res, 'User not found', 404); return; }

    // Find sibling accounts on shared IPs / devices (top 5 each)
    const siblingIps = await prisma.ipRecord.findMany({
      where: { uids: { has: uid } },
      select: { ipAddress: true, uids: true, isVpn: true, isFlagged: true },
      take: 5,
    });

    return success(res, { user, trust, events, siblingIps }) as unknown as void;
  } catch (err) {
    logger.error('[AdminSecurity] getFlaggedUserDetail error:', err);
    error(res, 'Failed to fetch user detail');
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
