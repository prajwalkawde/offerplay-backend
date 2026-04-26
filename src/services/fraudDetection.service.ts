import crypto from 'crypto';
import axios from 'axios';
import { SecuritySettings, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { getRedisClient, rk } from '../config/redis';
import { logger } from '../utils/logger';
import { isBypassUser } from './securityBypass.service';
import { writeAudit } from './auditLog.service';

// ─── Combined-signal scoring (Phase C) ────────────────────────────────────────
// Count distinct fraud event types triggered for this user in the last 7 days.
// Best practice: a single noisy signal is just a flag. Two distinct signals →
// restrict (lose withdraw). Three+ → ban candidate (still requires admin's
// autoBanEnabled toggle to actually ban). Replaces the previous "any single
// signal can cross the threshold and ban" model.
const COMBINED_SIGNAL_WINDOW_DAYS = 7;

async function countDistinctRecentSignals(uid: string, includeReason: string): Promise<number> {
  const cutoff = new Date(Date.now() - COMBINED_SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  try {
    const rows = await prisma.fraudLog.findMany({
      where: { uid, createdAt: { gte: cutoff } },
      select: { eventType: true },
      distinct: ['eventType'],
    });
    const types = new Set<string>(rows.map(r => r.eventType));
    if (includeReason) types.add(includeReason); // include current event even if not yet in DB
    // Don't count system actions as "signals"
    types.delete('auto_ban');
    types.delete('auto_restrict');
    return types.size;
  } catch (err) {
    logger.warn('[FRAUD] countDistinctRecentSignals failed', { err });
    return 0;
  }
}

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

// Phase C: per-(uid, reason) 24h dedup. The original implementation deducted
// trust + incremented totalFraudEvents on EVERY request, which caused the
// 2026-04-26 mass-ban incident (one fingerprint with 5 accounts could cascade
// 25 deductions per request). With dedup, the same uid+reason can only deduct
// once per 24h regardless of how many requests trigger the same signal.
// Set via Redis with TTL — fail open if Redis is down (resume old behavior).
const DEDUP_TTL_SECONDS = 24 * 60 * 60;

async function shouldDedupDeduction(uid: string, reason: string): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const key = rk(`fraud-dedup:${uid}:${reason}`);
    // SET NX (set if not exists) returns 'OK' on first call, null thereafter
    const result = await redis.set(key, '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
    return result === null; // null = key already existed = dedup HIT
  } catch {
    return false; // fail open — proceed with the deduction
  }
}

export async function deductTrustScore(
  uid: string,
  amount: number,
  reason: string,
): Promise<void> {
  try {
    // Bypass allowlist (Google Play review accounts) — never deduct trust.
    if (await isBypassUser(uid)) {
      logger.debug('[FRAUD] skipping deduction — bypass user', { uid, reason });
      return;
    }

    // Phase C: dedup the same (uid, reason) within 24h
    if (await shouldDedupDeduction(uid, reason)) {
      logger.debug('[FRAUD] dedup hit — skipping deduction', { uid, reason });
      return;
    }

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

    // Phase C: combined-signal scoring. Count distinct fraud event types in
    // the last 7 days. Tier:
    //   1 signal  → flag only (admin sees it in Flagged Users; no action)
    //   2 signals → auto-restrict (if autoRestrictEnabled)
    //   3+ signals → auto-ban (if autoBanEnabled)
    // Trust-score thresholds are still respected as a secondary guard, but
    // the signal-count tier is the primary decision now.
    const distinctSignals = await countDistinctRecentSignals(uid, reason);
    const trustBelowBan = newScore <= settings.autobanTrustScore;
    const trustBelowRestrict = newScore <= settings.autoRestrictTrustScore;

    if (
      settings.autoBanEnabled &&
      distinctSignals >= 3 &&
      trustBelowBan &&
      !current.isBanned
    ) {
      await autoBan(
        uid,
        `Auto-banned: ${distinctSignals} distinct signals in 7d (latest: ${reason})`,
        { trustScore: current.trustScore, isBanned: current.isBanned, isRestricted: current.isRestricted },
        { trustScore: newScore, isBanned: true, isRestricted: true },
      );
    } else if (
      settings.autoRestrictEnabled &&
      distinctSignals >= 2 &&
      trustBelowRestrict &&
      !current.isRestricted &&
      !current.isBanned
    ) {
      await autoRestrict(
        uid,
        `Auto-restricted: ${distinctSignals} distinct signals in 7d (latest: ${reason})`,
        { trustScore: current.trustScore, isBanned: current.isBanned, isRestricted: current.isRestricted },
        { trustScore: newScore, isBanned: false, isRestricted: true },
      );
    }
    // 1 signal → log only (already done by caller via logFraudEvent), no action
  } catch (err) {
    logger.error('[FRAUD] deductTrustScore error:', err);
  }
}

// ─── autoBan ─────────────────────────────────────────────────────────────────

async function autoBan(
  uid: string,
  reason: string,
  before?: { trustScore: number; isBanned: boolean; isRestricted: boolean },
  after?: { trustScore: number; isBanned: boolean; isRestricted: boolean },
): Promise<void> {
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
    await writeAudit({
      uid,
      action: 'AUTO_BAN',
      actor: 'system',
      before,
      after,
      reason,
    });
    logger.warn('[FRAUD] Auto-banned uid:', uid, reason);
  } catch (err) {
    logger.error('[FRAUD] autoBan error:', err);
  }
}

// ─── autoRestrict ─────────────────────────────────────────────────────────────

async function autoRestrict(
  uid: string,
  reason: string,
  before?: { trustScore: number; isBanned: boolean; isRestricted: boolean },
  after?: { trustScore: number; isBanned: boolean; isRestricted: boolean },
): Promise<void> {
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
    await writeAudit({
      uid,
      action: 'AUTO_RESTRICT',
      actor: 'system',
      before,
      after,
      reason,
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

// Reject fingerprints that are sentinel/fallback values from the mobile side.
// Without this, every client whose Web Crypto fails (and falls back to the
// literal string "unavailable") would collapse into a single shared record.
const _FP_SENTINELS = new Set(['unavailable', 'unknown', 'null', 'undefined']);
function _isUsableFingerprint(fp: string | undefined | null): boolean {
  if (!fp) return false;
  const t = fp.trim().toLowerCase();
  return t.length >= 8 && !_FP_SENTINELS.has(t);
}

async function checkDeviceMultiAccount(
  uid: string,
  fingerprint: string,
  settings: SecuritySettings,
): Promise<{ suspicious: boolean }> {
  try {
    if (!_isUsableFingerprint(fingerprint)) {
      logger.debug('[FRAUD] skipping device check — sentinel fingerprint:', fingerprint);
      return { suspicious: false };
    }
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
    // Bypass allowlist (Google Play review) — pass everything.
    if (await isBypassUser(uid)) {
      return { allowed: true, trustScore: 100 };
    }

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
