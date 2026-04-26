// Security-bypass allowlist for Google Play Console review accounts.
//
// Google Play's review team needs to install + use the production build to
// approve releases. They use a fixed test phone number that we register in
// the Play Console (and they enter during review). That phone must be able to:
//   - Sign up multiple times (Play Console may install the app on different
//     emulators / devices for each review pass)
//   - Pass through VPN / multi-account / fraud / Play Integrity checks
//   - Never be flagged or banned
//
// This module provides ONE place to manage the allowlist and short-circuit
// every security checkpoint for those phones. Configurable via env var
// `SECURITY_BYPASS_PHONES` (comma-separated last-N-digit suffixes); defaults
// to the Google Play test number we registered.

import { prisma } from '../config/database';

const DEFAULT_BYPASS_PHONES = '8432171505';

const BYPASS_PHONE_SUFFIXES: string[] = (process.env.SECURITY_BYPASS_PHONES || DEFAULT_BYPASS_PHONES)
  .split(',')
  .map(p => p.trim().replace(/\D/g, ''))
  .filter(p => p.length >= 6);

// Per-process cache so we don't hit DB on every request. 5min TTL keeps the
// list fresh enough that admin changes to a bypass user's phone propagate
// reasonably fast, while still being basically free at runtime.
interface CacheEntry { isBypass: boolean; ts: number }
const _userBypassCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * True if the given phone matches any configured bypass suffix.
 * Phone format-agnostic — strips non-digits before comparing.
 */
export function isBypassPhone(phone: string | null | undefined): boolean {
  if (!phone || BYPASS_PHONE_SUFFIXES.length === 0) return false;
  const cleaned = phone.replace(/\D/g, '');
  return BYPASS_PHONE_SUFFIXES.some(suffix => cleaned.endsWith(suffix));
}

/**
 * True if the user behind `uid` is on the bypass allowlist (looked up by phone).
 * Cached for 5 minutes per uid. Fail-safe: returns false on DB error so a
 * temporary outage cannot accidentally disable security for everyone.
 */
export async function isBypassUser(uid: string | null | undefined): Promise<boolean> {
  if (!uid) return false;
  if (BYPASS_PHONE_SUFFIXES.length === 0) return false;

  const cached = _userBypassCache.get(uid);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.isBypass;

  try {
    const user = await prisma.user.findUnique({ where: { id: uid }, select: { phone: true } });
    const result = isBypassPhone(user?.phone ?? null);
    _userBypassCache.set(uid, { isBypass: result, ts: Date.now() });
    return result;
  } catch {
    return false; // fail safe — DON'T bypass on DB error
  }
}

/**
 * Drop the cached bypass status for a user (or all users). Call after the
 * user's phone changes — currently rare, so optional.
 */
export function clearBypassCache(uid?: string): void {
  if (uid) _userBypassCache.delete(uid);
  else _userBypassCache.clear();
}

/**
 * Inspect the current allowlist (for debugging / admin endpoints).
 */
export function getBypassSuffixes(): readonly string[] {
  return BYPASS_PHONE_SUFFIXES;
}
