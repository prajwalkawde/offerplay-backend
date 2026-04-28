// Step 6: Tier commission ladder.
//
// Top 1% of referrers drive 50%+ of all referrals in this category. Tier
// system creates a clear ladder so power users keep working — and turns
// the user's referral count into a status badge ("Gold tier — 12% commission").
//
// Tier is determined by active referral count (referrals that crossed the
// 500-coin earning gate from Step 1). Inactive sign-ups don't count — that's
// the whole point of the gate.

import { prisma } from '../config/database';

export type TierName = 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM';

export interface TierInfo {
  name:       TierName;
  emoji:      string;
  pct:        number;        // commission percentage for this tier
  minActive:  number;        // minimum active referrals required
  nextTier:   { name: TierName; emoji: string; pct: number; minActive: number; remaining: number } | null;
  // base multiplier applied to the per-source commission %
  // e.g. taskCommissionPct=10 with multiplier 2.0 → user actually earns 20%
  multiplier: number;
}

const TIER_EMOJI: Record<TierName, string> = {
  BRONZE:   '🥉',
  SILVER:   '🥈',
  GOLD:     '🥇',
  PLATINUM: '💎',
};

/**
 * Compute the user's current tier from their active referral count.
 * Active = referral.status === 'active' (passed the 500-coin gate).
 */
export async function getReferrerTier(uid: string): Promise<TierInfo> {
  const [settings, activeCount] = await Promise.all([
    prisma.referralSettings.findFirst().catch(() => null),
    prisma.referral.count({ where: { referrerId: uid, status: 'active' } }),
  ]);

  // Build tier list in ascending order of threshold
  const tiers = [
    { name: 'BRONZE'   as TierName, min: settings?.tierBronzeMin   ?? 0,   pct: settings?.tierBronzePct   ?? 5  },
    { name: 'SILVER'   as TierName, min: settings?.tierSilverMin   ?? 10,  pct: settings?.tierSilverPct   ?? 10 },
    { name: 'GOLD'     as TierName, min: settings?.tierGoldMin     ?? 50,  pct: settings?.tierGoldPct     ?? 15 },
    { name: 'PLATINUM' as TierName, min: settings?.tierPlatinumMin ?? 100, pct: settings?.tierPlatinumPct ?? 20 },
  ].sort((a, b) => a.min - b.min);

  // Find current tier (highest one whose min ≤ activeCount)
  let current = tiers[0];
  for (const t of tiers) if (activeCount >= t.min) current = t;

  const nextIdx = tiers.findIndex(t => t.name === current.name) + 1;
  const next = tiers[nextIdx] ?? null;

  // Multiplier: tier % / Bronze % so base flat commissions still scale relatively
  const baseBronzePct = tiers[0].pct || 1;
  const multiplier = current.pct / baseBronzePct;

  return {
    name: current.name,
    emoji: TIER_EMOJI[current.name],
    pct: current.pct,
    minActive: current.min,
    nextTier: next ? {
      name: next.name,
      emoji: TIER_EMOJI[next.name],
      pct: next.pct,
      minActive: next.min,
      remaining: Math.max(0, next.min - activeCount),
    } : null,
    multiplier,
  };
}

/**
 * Resolve the actual commission percentage to apply for a referrer + earn type.
 *
 * - When tier system disabled → flat percentage from ReferralSettings (legacy)
 * - When enabled → tier percentage (overrides per-source %)
 *
 * In v1 we use a single tier % across all sources. Future: per-source tier %.
 */
export async function getEffectiveCommissionPct(
  referrerId: string,
  type: 'TASK' | 'SURVEY' | 'OFFERWALL' | 'CONTEST',
): Promise<number> {
  const settings = await prisma.referralSettings.findFirst().catch(() => null);
  if (!settings?.enableTierCommission) {
    // Legacy flat-rate path
    const flat: Record<typeof type, number> = {
      TASK:      settings?.taskCommissionPct       ?? 10,
      SURVEY:    settings?.surveyCommissionPct      ?? 10,
      OFFERWALL: settings?.offerwallCommissionPct   ?? 10,
      CONTEST:   settings?.contestWinCommissionPct  ?? 5,
    };
    return flat[type];
  }

  const tier = await getReferrerTier(referrerId);
  // Contest = half the rate even at higher tiers (existing convention)
  if (type === 'CONTEST') return tier.pct * 0.5;
  return tier.pct;
}
