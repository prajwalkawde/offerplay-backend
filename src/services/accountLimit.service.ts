// Pre-signup device-account-limit check.
//
// Runs INSIDE auth controllers (phone OTP verify, Google sign-in) BEFORE
// creating a new user. Honors admin's `maxAccountsPerDevice` setting and
// returns a structured payload the mobile client can show in a "you already
// have an account" dialog instead of just a generic error.
//
// Existing users (returning logins) bypass this check — only NEW account
// creation is gated.

import crypto from 'crypto';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { loadSettings } from './fraudDetection.service';
import { isUsableFingerprint } from './securityCheck.service';
import { isBypassPhone } from './securityBypass.service';

export interface ExistingAccountMasked {
  name: string;        // e.g. "P****l"
  phone?: string;      // e.g. "•••1234"
  email?: string;      // e.g. "p***@gmail.com"
  createdAt: string;   // ISO
}

export interface SignupDeviceLimitResult {
  allowed: boolean;
  totalAccounts: number;
  maxAllowed: number;
  existingAccount?: ExistingAccountMasked;
}

// ─── PII masking — never expose full identifiers of OTHER users ──────────────

function maskName(name: string | null | undefined): string {
  if (!name) return 'Account';
  const t = name.trim();
  if (t.length === 0) return 'Account';
  if (t.length <= 2) return t[0] + '•';
  return t[0] + '•'.repeat(Math.min(4, t.length - 2)) + t[t.length - 1];
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, '');
  if (digits.length <= 4) return '•'.repeat(digits.length);
  return '•••' + digits.slice(-4);
}

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '•••';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 1) return local + '•••' + domain;
  return local[0] + '•••' + domain;
}

function maskAccount(a: {
  name: string | null;
  phone: string | null;
  email: string | null;
  createdAt: Date;
}): ExistingAccountMasked {
  return {
    name: maskName(a.name),
    phone: a.phone ? maskPhone(a.phone) : undefined,
    email: a.email ? maskEmail(a.email) : undefined,
    createdAt: a.createdAt.toISOString(),
  };
}

// ─── checkSignupDeviceLimit ───────────────────────────────────────────────────

export async function checkSignupDeviceLimit(
  fingerprint: string | undefined,
  candidatePhone?: string | null,
): Promise<SignupDeviceLimitResult> {
  const settings = await loadSettings();
  const max = Math.max(1, settings.maxAccountsPerDevice);

  // Bypass allowlist (Google Play review accounts) — always allowed regardless
  // of fingerprint or device count.
  if (isBypassPhone(candidatePhone)) {
    return { allowed: true, totalAccounts: 0, maxAllowed: max };
  }

  // No reliable fingerprint → cannot enforce. Allow signup; the broader
  // fraud system will catch abuse via other signals.
  if (!isUsableFingerprint(fingerprint)) {
    return { allowed: true, totalAccounts: 0, maxAllowed: max };
  }

  let totalAccounts = 0;
  let oldestRow: { name: string | null; phone: string | null; email: string | null; createdAt: Date } | null = null;

  try {
    const hashedFp = crypto.createHash('sha256').update(fingerprint!).digest('hex');
    const record = await prisma.deviceFingerprint.findUnique({ where: { fingerprint: hashedFp } });
    totalAccounts = record?.uids.length ?? 0;

    if (totalAccounts >= max && record && record.uids.length > 0) {
      // Pick the OLDEST sibling — that's the account the user should "go back to"
      oldestRow = await prisma.user.findFirst({
        where: { id: { in: record.uids } },
        orderBy: { createdAt: 'asc' },
        select: { name: true, phone: true, email: true, createdAt: true },
      });
    }
  } catch (err) {
    // Fail open — never block legitimate signups due to a DB hiccup.
    logger.error('[AccountLimit] checkSignupDeviceLimit error:', err);
    return { allowed: true, totalAccounts: 0, maxAllowed: max };
  }

  if (totalAccounts < max) {
    return { allowed: true, totalAccounts, maxAllowed: max };
  }

  return {
    allowed: false,
    totalAccounts,
    maxAllowed: max,
    existingAccount: oldestRow ? maskAccount(oldestRow) : undefined,
  };
}

// ─── recordDeviceForUser ──────────────────────────────────────────────────────
// Called by the auth controller AFTER a successful signup so that the next
// signup attempt on the same device sees the count immediately (otherwise the
// new user wouldn't be in the DeviceFingerprint table until their first
// fraud-checked request).
export async function recordDeviceForUser(
  uid: string,
  fingerprint: string | undefined,
): Promise<void> {
  if (!isUsableFingerprint(fingerprint)) return;
  try {
    const hashedFp = crypto.createHash('sha256').update(fingerprint!).digest('hex');
    const existing = await prisma.deviceFingerprint.findUnique({ where: { fingerprint: hashedFp } });
    const uids = existing?.uids?.includes(uid) ? existing.uids : [...(existing?.uids ?? []), uid];
    await prisma.deviceFingerprint.upsert({
      where: { fingerprint: hashedFp },
      update: { uids, lastSeen: new Date() },
      create: { fingerprint: hashedFp, uids, firstSeen: new Date(), lastSeen: new Date() },
    });
  } catch (err) {
    logger.warn('[AccountLimit] recordDeviceForUser failed:', err);
  }
}
