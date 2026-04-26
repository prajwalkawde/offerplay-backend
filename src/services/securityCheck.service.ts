// Read-only security checks called by the mobile app on focus / app-open.
// Different from fraudDetection.service which DEDUCTS trust score on every
// detection — this one only READS the current state so the client can show
// blocking / warning dialogs without affecting the user's record.

import crypto from 'crypto';
import axios from 'axios';
import { prisma } from '../config/database';
import { getRedisClient, rk } from '../config/redis';
import { logger } from '../utils/logger';
import { loadSettings } from './fraudDetection.service';

export interface VpnInfo {
  isVpn: boolean;
  isp?: string;
  country?: string;
  city?: string;
}

export interface MultiAccountInfo {
  deviceAccountCount: number;
  ipAccountCount: number;
  otherUids: string[];
  oldestAccount: { id: string; name: string | null; createdAt: string } | null;
}

export interface SecurityCheckResult {
  vpn: VpnInfo;
  multiAccount: MultiAccountInfo;
  blockedReason: 'vpn' | 'multi_account_warning' | null;
}

interface IpApiResponse {
  status: string;
  country?: string;
  city?: string;
  isp?: string;
  proxy?: boolean;
  hosting?: boolean;
}

// ─── isUsableFingerprint ──────────────────────────────────────────────────────

// Known mobile-side sentinel values that should NEVER be used as a fingerprint
// (otherwise hundreds of unrelated users collide into a single record).
const FINGERPRINT_SENTINELS = new Set(['unavailable', 'unknown', 'null', 'undefined']);

export function isUsableFingerprint(fp: string | undefined | null): fp is string {
  if (!fp) return false;
  const trimmed = fp.trim().toLowerCase();
  if (trimmed.length < 8) return false;          // too short to be a real ID
  if (FINGERPRINT_SENTINELS.has(trimmed)) return false;
  return true;
}

// ─── checkVpnReadOnly ─────────────────────────────────────────────────────────

export async function checkVpnReadOnly(ip: string): Promise<VpnInfo> {
  const settings = await loadSettings();
  if (!settings.enableVpnDetection) {
    return { isVpn: false };
  }

  const cacheKey = rk(`vpn:ip:${ip}`);

  // Read cached result if present (writers in fraudDetection cache the same key)
  try {
    const redis = getRedisClient();
    const cached = await redis.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as { isVpn: boolean; country?: string; city?: string; isp?: string };
      return { isVpn: parsed.isVpn, country: parsed.country, city: parsed.city, isp: parsed.isp };
    }
  } catch {
    // Redis unavailable — continue
  }

  // No cache — call ip-api.com
  try {
    const response = await axios.get<IpApiResponse>(
      `http://ip-api.com/json/${ip}?fields=status,country,city,isp,proxy,hosting,query`,
      { timeout: 2000 },
    );
    const data = response.data;
    const isVpn = data.proxy === true || data.hosting === true;
    const result: VpnInfo = { isVpn, country: data.country, city: data.city, isp: data.isp };

    try {
      const redis = getRedisClient();
      await redis.setex(cacheKey, settings.vpnCacheTtlHours * 3600,
        JSON.stringify({ ...result, isProxy: data.proxy ?? false, isDatacenter: data.hosting ?? false, blocked: false }));
    } catch { /* ignore */ }

    return result;
  } catch (err) {
    // Fail open — never block the user just because the VPN provider is down
    logger.warn('[SecurityCheck] VPN lookup failed for ip:', ip, err instanceof Error ? err.message : err);
    return { isVpn: false };
  }
}

// ─── checkMultiAccountReadOnly ────────────────────────────────────────────────

export async function checkMultiAccountReadOnly(
  uid: string,
  ip: string,
  fingerprint: string | undefined,
): Promise<MultiAccountInfo> {
  const out: MultiAccountInfo = {
    deviceAccountCount: 0,
    ipAccountCount: 0,
    otherUids: [],
    oldestAccount: null,
  };

  // Device fingerprint — only counts accounts seen on the same physical device.
  // Reject sentinel/unreliable fingerprints to prevent the "all-fallback users
  // collide into one record" bug (incident 2026-04-26 where 469 mobile clients
  // whose Web Crypto failed all fell back to the literal string "unavailable",
  // which hashed to a single record).
  if (isUsableFingerprint(fingerprint)) {
    try {
      const hashedFp = crypto.createHash('sha256').update(fingerprint!).digest('hex');
      const record = await prisma.deviceFingerprint.findUnique({ where: { fingerprint: hashedFp } });
      if (record) {
        out.deviceAccountCount = record.uids.length;
        out.otherUids = record.uids.filter(u => u !== uid);
      }
    } catch (err) {
      logger.warn('[SecurityCheck] device check failed:', err);
    }
  }

  // IP — secondary signal (carrier-grade NAT / shared wifi can inflate this)
  try {
    const ipRecord = await prisma.ipRecord.findUnique({ where: { ipAddress: ip } });
    if (ipRecord) {
      out.ipAccountCount = ipRecord.uids.length;
    }
  } catch (err) {
    logger.warn('[SecurityCheck] ip check failed:', err);
  }

  // Find the OLDEST sibling account so the user can be told which one to keep
  if (out.otherUids.length > 0) {
    try {
      const oldest = await prisma.user.findMany({
        where: { id: { in: out.otherUids } },
        select: { id: true, name: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 1,
      });
      if (oldest[0]) {
        out.oldestAccount = {
          id: oldest[0].id,
          name: oldest[0].name,
          createdAt: oldest[0].createdAt.toISOString(),
        };
      }
    } catch (err) {
      logger.warn('[SecurityCheck] oldest sibling lookup failed:', err);
    }
  }

  return out;
}

// ─── checkSecurity (combined entry point) ─────────────────────────────────────

export async function checkSecurity(params: {
  uid: string;
  ip: string;
  fingerprint?: string;
}): Promise<SecurityCheckResult> {
  const settings = await loadSettings();

  const [vpn, multiAccount] = await Promise.all([
    checkVpnReadOnly(params.ip),
    checkMultiAccountReadOnly(params.uid, params.ip, params.fingerprint),
  ]);

  // Decide which dialog (if any) the client should show. VPN takes priority
  // because it actively blocks reward features; multi-account is just a warning.
  let blockedReason: SecurityCheckResult['blockedReason'] = null;
  if (vpn.isVpn && settings.blockVpnUsers) {
    blockedReason = 'vpn';
  } else if (vpn.isVpn) {
    // Even when blockVpnUsers is off, we still surface the VPN to the client
    // so the dialog can warn — flip blockedReason on for the dialog.
    blockedReason = 'vpn';
  } else if (multiAccount.deviceAccountCount > 1) {
    blockedReason = 'multi_account_warning';
  }

  return { vpn, multiAccount, blockedReason };
}
