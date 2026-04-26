import crypto from 'crypto';
import axios from 'axios';
import { SecuritySettings, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { getRedisClient, rk } from '../config/redis';
import { logger } from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CheckRequestParams {
  uid: string;
  ip: string;
  fingerprint?: string;
}

export interface CheckRequestResult {
  allowed: boolean;
  reason?: string;
  trustScore?: number;
  isBanned?: boolean;
  isRestricted?: boolean;
}

interface VpnCheckResult {
  isVpn: boolean;
  blocked: boolean;
  country?: string;
  city?: string;
  isp?: string;
  isProxy?: boolean;
  isDatacenter?: boolean;
}

interface IpApiResponse {
  status: string;
  country?: string;
  city?: string;
  isp?: string;
  proxy?: boolean;
  hosting?: boolean;
  query?: string;
}

// ─── loadSettings ─────────────────────────────────────────────────────────────

export async function loadSettings(): Promise<SecuritySettings> {
  try {
    const redis = getRedisClient();
    const cached = await redis.get(rk('security:settings'));
    if (cached) {
      return JSON.parse(cached) as SecuritySettings;
    }
  } catch {
    // Redis unavailable — fetch from DB
  }

  const settings = await prisma.securitySettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });

  try {
    const redis = getRedisClient();
    await redis.setex(rk('security:settings'), 60, JSON.stringify(settings));
  } catch {
    // ignore
  }

  return settings;
}

// ─── getOrCreateTrustScore ────────────────────────────────────────────────────

async function getOrCreateTrustScore(uid: string) {
  return prisma.userTrustScore.upsert({
    where: { uid },
    update: {},
    create: { uid },
  });
}

// ─── logFraudEvent ────────────────────────────────────────────────────────────

interface FraudEventData {
  uid: string;
  eventType: string;
  severity: string;
  description: string;
  ipAddress?: string;
  deviceFingerprint?: string;
  metadata?: Prisma.InputJsonValue;
}

export async function logFraudEvent(data: FraudEventData): Promise<void> {
  try {
    await prisma.fraudLog.create({
      data: {
        uid: data.uid,
        eventType: data.eventType,
        severity: data.severity,
        description: data.description,
        ipAddress: data.ipAddress,
        deviceFingerprint: data.deviceFingerprint,
        metadata: data.metadata ?? undefined,
      },
    });
    logger.warn('[FRAUD]', data.eventType, 'uid:', data.uid);
  } catch (err) {
    logger.error('[FRAUD] logFraudEvent error:', err);
  }
}

// ─── deductTrustScore ─────────────────────────────────────────────────────────

export async function deductTrustScore(
  uid: string,
  amount: number,
  reason: string,
): Promise<void> {
  try {
    const settings = await loadSettings();
    const current = await getOrCreateTrustScore(uid);
    const newScore = Math.max(0, current.trustScore - amount);

    await prisma.userTrustScore.update({
      where: { uid },
      data: {
        trustScore: newScore,
        totalFraudEvents: { increment: 1 },
        lastFraudEventAt: new Date(),
      },
    });

    // Auto-ban / auto-restrict are now opt-in via SecuritySettings toggles.
    // When off, fraud events are still logged + trust score still deducted (so the
    // admin "Flagged Users" page can show who would have been banned), but no
    // ban/restrict action is taken. Admin must review and ban/restrict manually.
    if (settings.autoBanEnabled && newScore <= settings.autobanTrustScore && !current.isBanned) {
      await autoBan(uid, `Auto-banned: trust score ${newScore} (reason: ${reason})`);
    } else if (settings.autoRestrictEnabled && newScore <= settings.autoRestrictTrustScore && !current.isRestricted && !current.isBanned) {
      await autoRestrict(uid, `Auto-restricted: trust score ${newScore} (reason: ${reason})`);
    }
  } catch (err) {
    logger.error('[FRAUD] deductTrustScore error:', err);
  }
}

// ─── autoBan ─────────────────────────────────────────────────────────────────

async function autoBan(uid: string, reason: string): Promise<void> {
  try {
    await prisma.userTrustScore.update({
      where: { uid },
      data: {
        isBanned: true,
        isRestricted: true,
        banReason: reason,
        bannedAt: new Date(),
        bannedBy: 'system',
      },
    });
    await logFraudEvent({
      uid,
      eventType: 'auto_ban',
      severity: 'critical',
      description: reason,
    });
    logger.warn('[FRAUD] Auto-banned uid:', uid, reason);
  } catch (err) {
    logger.error('[FRAUD] autoBan error:', err);
  }
}

// ─── autoRestrict ─────────────────────────────────────────────────────────────

async function autoRestrict(uid: string, reason: string): Promise<void> {
  try {
    await prisma.userTrustScore.update({
      where: { uid },
      data: { isRestricted: true },
    });
    await logFraudEvent({
      uid,
      eventType: 'auto_restrict',
      severity: 'high',
      description: reason,
    });
    logger.warn('[FRAUD] Auto-restricted uid:', uid, reason);
  } catch (err) {
    logger.error('[FRAUD] autoRestrict error:', err);
  }
}

// ─── checkIpMultiAccount ──────────────────────────────────────────────────────

async function checkIpMultiAccount(
  uid: string,
  ip: string,
  settings: SecuritySettings,
): Promise<{ suspicious: boolean }> {
  try {
    const existing = await prisma.ipRecord.findUnique({ where: { ipAddress: ip } });
    const currentUids = existing?.uids ?? [];
    const updatedUids = currentUids.includes(uid) ? currentUids : [...currentUids, uid];

    const ipRecord = await prisma.ipRecord.upsert({
      where: { ipAddress: ip },
      update: {
        uids: updatedUids,
        requestCount: { increment: 1 },
      },
      create: {
        ipAddress: ip,
        uids: updatedUids,
        requestCount: 1,
      },
    });

    const accountCount = ipRecord.uids.length;

    if (accountCount <= settings.ipMonitorThreshold) {
      logger.info('[IP] Normal:', accountCount, 'accounts on', ip);
      return { suspicious: false };
    }

    if (accountCount > settings.ipMonitorThreshold && accountCount < settings.ipSuspiciousThreshold) {
      await logFraudEvent({
        uid,
        eventType: 'multiple_accounts_same_ip',
        severity: 'low',
        description: `${accountCount} accounts on IP: ${ip}`,
        ipAddress: ip,
      });
      return { suspicious: false };
    }

    if (accountCount >= settings.ipSuspiciousThreshold && accountCount < settings.ipFraudFarmThreshold) {
      for (const affectedUid of ipRecord.uids) {
        await deductTrustScore(affectedUid, settings.ipScoreDeductSuspicious, 'suspicious_ip');
        await logFraudEvent({
          uid: affectedUid,
          eventType: 'multiple_accounts_same_ip',
          severity: 'medium',
          description: `${accountCount} accounts on IP: ${ip}`,
          ipAddress: ip,
          metadata: { allUids: ipRecord.uids, accountCount },
        });
      }
      return { suspicious: true };
    }

    if (accountCount >= settings.ipFraudFarmThreshold) {
      await prisma.ipRecord.update({
        where: { ipAddress: ip },
        data: {
          isFlagged: true,
          isBlocked: true,
          flagReason: `Fraud farm: ${accountCount} accounts`,
        },
      });
      for (const affectedUid of ipRecord.uids) {
        await deductTrustScore(affectedUid, settings.ipScoreDeductFraudFarm, 'fraud_farm_ip');
        await logFraudEvent({
          uid: affectedUid,
          eventType: 'fraud_farm_detected',
          severity: 'critical',
          description: `Fraud farm: ${accountCount} accounts on IP: ${ip}`,
          ipAddress: ip,
          metadata: { allUids: ipRecord.uids, accountCount },
        });
      }
      return { suspicious: true };
    }

    return { suspicious: false };
  } catch (err) {
    logger.error('[FRAUD] checkIpMultiAccount error:', err);
    return { suspicious: false }; // fail open
  }
}

// ─── checkVpnProxy ────────────────────────────────────────────────────────────

async function checkVpnProxy(
  uid: string,
  ip: string,
  settings: SecuritySettings,
): Promise<VpnCheckResult> {
  if (!settings.enableVpnDetection) {
    return { isVpn: false, blocked: false };
  }

  const cacheKey = rk(`vpn:ip:${ip}`);

  try {
    const redis = getRedisClient();
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as VpnCheckResult;
    }
  } catch {
    // Redis unavailable — continue
  }

  let result: VpnCheckResult = { isVpn: false, blocked: false };

  try {
    const response = await axios.get<IpApiResponse>(
      `http://ip-api.com/json/${ip}?fields=status,country,city,isp,proxy,hosting,query`,
      { timeout: 2000 },
    );

    const data = response.data;
    const isVpn = data.proxy === true || data.hosting === true;

    result = {
      isVpn,
      blocked: false,
      country: data.country,
      city: data.city,
      isp: data.isp,
      isProxy: data.proxy,
      isDatacenter: data.hosting,
    };

    // Update IpRecord with geo data
    await prisma.ipRecord.upsert({
      where: { ipAddress: ip },
      update: {
        country: data.country,
        city: data.city,
        isp: data.isp,
        isVpn,
        isProxy: data.proxy ?? false,
        isDatacenter: data.hosting ?? false,
      },
      create: {
        ipAddress: ip,
        uids: [uid],
        country: data.country,
        city: data.city,
        isp: data.isp,
        isVpn,
        isProxy: data.proxy ?? false,
        isDatacenter: data.hosting ?? false,
      },
    });

    if (isVpn) {
      await logFraudEvent({
        uid,
        eventType: 'vpn_detected',
        severity: 'medium',
        description: `VPN/Proxy detected on IP: ${ip}`,
        ipAddress: ip,
        metadata: {
          country: data.country,
          isp: data.isp,
          isProxy: data.proxy,
          isDatacenter: data.hosting,
        },
      });
      await deductTrustScore(uid, settings.vpnScoreDeduct, 'vpn_detected');

      if (settings.blockVpnUsers) {
        result.blocked = true;
      }
    }
  } catch (err) {
    // fail open — don't block if IP check fails
    logger.warn('[FRAUD] VPN check failed for ip:', ip, err instanceof Error ? err.message : err);
    result = { isVpn: false, blocked: false };
  }

  try {
    const redis = getRedisClient();
    await redis.setex(cacheKey, settings.vpnCacheTtlHours * 3600, JSON.stringify(result));
  } catch {
    // ignore
  }

  return result;
}

// ─── checkDeviceMultiAccount ──────────────────────────────────────────────────

async function checkDeviceMultiAccount(
  uid: string,
  fingerprint: string,
  settings: SecuritySettings,
): Promise<{ suspicious: boolean }> {
  try {
    const hashedFp = crypto.createHash('sha256').update(fingerprint).digest('hex');

    const existing = await prisma.deviceFingerprint.findUnique({ where: { fingerprint: hashedFp } });
    const currentUids = existing?.uids ?? [];
    const updatedUids = currentUids.includes(uid) ? currentUids : [...currentUids, uid];

    const record = await prisma.deviceFingerprint.upsert({
      where: { fingerprint: hashedFp },
      update: { uids: updatedUids },
      create: { fingerprint: hashedFp, uids: updatedUids },
    });

    if (record.uids.length > settings.maxAccountsPerDevice) {
      for (const affectedUid of record.uids) {
        await deductTrustScore(affectedUid, settings.deviceScoreDeduct, 'multiple_accounts_same_device');
        await logFraudEvent({
          uid: affectedUid,
          eventType: 'multiple_accounts_same_device',
          severity: 'critical',
          description: `${record.uids.length} accounts on device fingerprint`,
          deviceFingerprint: hashedFp,
          metadata: { allUids: record.uids, accountCount: record.uids.length },
        });
      }
      return { suspicious: true };
    }

    return { suspicious: false };
  } catch (err) {
    logger.error('[FRAUD] checkDeviceMultiAccount error:', err);
    return { suspicious: false }; // fail open
  }
}

// ─── checkRequest (main entry point) ──────────────────────────────────────────

export async function checkRequest(params: CheckRequestParams): Promise<CheckRequestResult> {
  const { uid, ip, fingerprint } = params;

  try {
    const settings = await loadSettings();
    const trustRecord = await getOrCreateTrustScore(uid);

    if (trustRecord.isBanned) {
      return { allowed: false, reason: 'account_suspended', isBanned: true };
    }

    if (settings.enableIpTracking) {
      await checkIpMultiAccount(uid, ip, settings);
    }

    if (settings.enableVpnDetection) {
      const vpnResult = await checkVpnProxy(uid, ip, settings);
      if (vpnResult.blocked && settings.blockVpnUsers) {
        return { allowed: false, reason: 'vpn_blocked' };
      }
    }

    if (settings.enableDeviceFingerprint && fingerprint) {
      await checkDeviceMultiAccount(uid, fingerprint, settings);
    }

    return {
      allowed: true,
      trustScore: trustRecord.trustScore,
      isRestricted: trustRecord.isRestricted,
    };
  } catch (err) {
    // FAIL OPEN — never block legitimate users due to security bugs
    logger.error('[FRAUD] checkRequest error:', err);
    return { allowed: true };
  }
}
