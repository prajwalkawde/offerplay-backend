// Vanity referral code claim/change with validation, profanity, and rate limit.
//
// User picks their own short code (e.g. "RAHUL26") instead of the auto-generated
// one. Codes share the namespace with auto-generated codes — first to claim wins.
//
// Rules:
//   - 4–20 chars, A–Z 0–9 underscore (case insensitive; stored uppercase)
//   - Must not start with a digit (avoids confusion with our auto-generated codes
//     that look like USER1234)
//   - Cannot match the profanity / reserved deny list
//   - Cannot already be in use by another account
//   - Rate limit: 1 successful change per 30 days (admin can override)

import { prisma } from '../config/database';

const MIN_LEN = 4;
const MAX_LEN = 20;
const FORMAT = /^[A-Z0-9_]+$/;
const STARTS_WITH_LETTER = /^[A-Z_]/;

const RATE_LIMIT_DAYS = 30;

// Tiny deny list — covers the most common profanity stems + reserved
// admin/brand names. Real production should use a third-party service
// (Bad Words API / Google Perspective) but this catches the obvious bad ones.
const DENY_PREFIXES = [
  'ADMIN', 'OWNER', 'MOD', 'SUPPORT', 'OFFERPLAY', 'OFFERPAY', 'SYSTEM',
  'FUCK', 'SHIT', 'BITCH', 'CUNT', 'NIGGER', 'NIGGA', 'PORN', 'XXX',
  'CHUTIY', 'BHENCHO', 'MADARCHO', 'BHOSDI', 'GANDU', 'CHODU', 'RANDI',
  'SEX', 'NUDE', 'KILL', 'RAPE', 'NAZI', 'HITLER',
];

export type VanityValidationCode =
  | 'OK'
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'BAD_FORMAT'
  | 'STARTS_WITH_DIGIT'
  | 'PROFANITY'
  | 'RESERVED'
  | 'TAKEN'
  | 'RATE_LIMITED'
  | 'SAME_AS_CURRENT';

export interface VanityValidationResult {
  ok: boolean;
  code: VanityValidationCode;
  message: string;
  daysUntilNextChange?: number;
}

export function normalizeCode(input: string): string {
  return input.trim().toUpperCase();
}

export function validateFormat(code: string): VanityValidationResult {
  if (code.length < MIN_LEN) return { ok: false, code: 'TOO_SHORT', message: `Code must be at least ${MIN_LEN} characters` };
  if (code.length > MAX_LEN) return { ok: false, code: 'TOO_LONG',  message: `Code must be at most ${MAX_LEN} characters` };
  if (!FORMAT.test(code))    return { ok: false, code: 'BAD_FORMAT', message: 'Letters, numbers, and underscore only' };
  if (!STARTS_WITH_LETTER.test(code)) return { ok: false, code: 'STARTS_WITH_DIGIT', message: 'Code must start with a letter' };

  for (const bad of DENY_PREFIXES) {
    if (code.includes(bad)) {
      // Distinguish reserved (admin/brand) vs profanity for clearer UX
      if (['ADMIN', 'OWNER', 'MOD', 'SUPPORT', 'OFFERPLAY', 'OFFERPAY', 'SYSTEM'].includes(bad)) {
        return { ok: false, code: 'RESERVED', message: 'That code is reserved' };
      }
      return { ok: false, code: 'PROFANITY', message: 'Please choose a different code' };
    }
  }

  return { ok: true, code: 'OK', message: 'Code looks good' };
}

export async function checkAvailability(code: string, excludeUid?: string): Promise<boolean> {
  const existing = await prisma.user.findUnique({
    where: { referralCode: code },
    select: { id: true },
  });
  if (!existing) return true;
  if (excludeUid && existing.id === excludeUid) return true; // user's own current code
  return false;
}

/**
 * Server-validates AND claims a vanity code for `uid`. Atomic — wins the race
 * via the unique constraint on User.referralCode if two users try the same
 * code at the same time.
 */
export async function claimVanityCode(uid: string, rawInput: string): Promise<VanityValidationResult> {
  const code = normalizeCode(rawInput);

  const fmt = validateFormat(code);
  if (!fmt.ok) return fmt;

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { referralCode: true, referralCodeChangedAt: true },
  });
  if (!user) return { ok: false, code: 'BAD_FORMAT', message: 'User not found' };

  if (user.referralCode === code) {
    return { ok: false, code: 'SAME_AS_CURRENT', message: 'This is already your code' };
  }

  // Rate limit
  if (user.referralCodeChangedAt) {
    const ms = Date.now() - user.referralCodeChangedAt.getTime();
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    if (days < RATE_LIMIT_DAYS) {
      return {
        ok: false,
        code: 'RATE_LIMITED',
        message: `You can change your code again in ${RATE_LIMIT_DAYS - days} days`,
        daysUntilNextChange: RATE_LIMIT_DAYS - days,
      };
    }
  }

  // Availability check (best-effort; the unique constraint is the real guard)
  const available = await checkAvailability(code, uid);
  if (!available) return { ok: false, code: 'TAKEN', message: 'That code is already taken' };

  // Atomic update — unique constraint catches concurrent races
  try {
    await prisma.user.update({
      where: { id: uid },
      data: { referralCode: code, referralCodeChangedAt: new Date() },
    });
    // Mirror to ReferralLink so the share URL keeps working
    await prisma.referralLink.updateMany({
      where: { userId: uid },
      data: { shortCode: code },
    });
    return { ok: true, code: 'OK', message: 'Code updated successfully' };
  } catch (err: unknown) {
    // Prisma P2002 = unique constraint violation
    if ((err as { code?: string })?.code === 'P2002') {
      return { ok: false, code: 'TAKEN', message: 'That code was just taken — try another' };
    }
    throw err;
  }
}
