// Single source of truth for which ad placements are active. Mobile fetches
// this on app launch (cached) so the admin can flip placements on/off without
// requiring an APK rebuild.
//
// AdMob policy notes baked into the defaults:
//   - App Open Ad: OFF by default until explicitly tested + first-launch skip
//   - Interstitial frequency cap: 120s (Google's recommended floor for Indian apps)
//   - Coin doubler: bounded reward (50 coins) + 3/day limit so the economy stays sustainable

import { AdSettings } from '@prisma/client';
import { prisma } from '../config/database';
import { getRedisClient, rk } from '../config/redis';

const CACHE_KEY = 'ad:settings';
const CACHE_TTL_SECONDS = 60;

/** Loads the singleton row, upserting if missing. Cached in Redis 60s. */
export async function loadAdSettings(): Promise<AdSettings> {
  try {
    const r = getRedisClient();
    const cached = await r.get(rk(CACHE_KEY));
    if (cached) return JSON.parse(cached) as AdSettings;
  } catch { /* Redis down — fetch from DB */ }

  const settings = await prisma.adSettings.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });

  try {
    const r = getRedisClient();
    await r.setex(rk(CACHE_KEY), CACHE_TTL_SECONDS, JSON.stringify(settings));
  } catch { /* ignore */ }

  return settings;
}

export async function clearAdSettingsCache(): Promise<void> {
  try { await getRedisClient().del(rk(CACHE_KEY)); } catch { /* ignore */ }
}

/**
 * Subset of AdSettings that mobile needs to know — only flags + small ints.
 * Doesn't expose admin-only fields like ad unit IDs (those go in the env
 * the build was compiled with).
 */
export interface MobileAdSettings {
  appOpen: { enabled: boolean; minIntervalSeconds: number; skipFirstLaunch: boolean };
  banners: {
    home: boolean; earn: boolean; wallet: boolean; superOffer: boolean; quiz: boolean;
    earnInline: boolean; earnInlineEvery: number;
  };
  interstitials: {
    postOffer: boolean; quiz: boolean; minIntervalSeconds: number;
  };
  rewarded: {
    superOffer: boolean; dailyBonus: boolean; quizHint: boolean; quizBonus: boolean;
    coinDoubler: boolean;
  };
  coinDoubler: { maxBonus: number; maxPerDay: number };
  // Optional overrides — mobile uses these if non-null, else hardcoded fallback
  unitIds: {
    appOpen?: string | null;
    banner?: string | null;
    interstitial?: string | null;
    rewarded?: string | null;
  };
}

export function toMobileShape(s: AdSettings): MobileAdSettings {
  return {
    appOpen: {
      enabled: s.enableAppOpenAd,
      minIntervalSeconds: s.appOpenAdMinIntervalSeconds,
      skipFirstLaunch: s.appOpenAdSkipFirstLaunch,
    },
    banners: {
      home: s.enableHomeBanner,
      earn: s.enableEarnBanner,
      wallet: s.enableWalletBanner,
      superOffer: s.enableSuperOfferBanner,
      quiz: s.enableQuizBanner,
      earnInline: s.enableEarnInlineBanners,
      earnInlineEvery: s.earnInlineBannerEvery,
    },
    interstitials: {
      postOffer: s.enablePostOfferInterstitial,
      quiz: s.enableQuizInterstitial,
      minIntervalSeconds: s.interstitialMinIntervalSeconds,
    },
    rewarded: {
      superOffer: s.enableSuperOfferRewarded,
      dailyBonus: s.enableDailyBonusRewarded,
      quizHint: s.enableQuizHintRewarded,
      quizBonus: s.enableQuizBonusRewarded,
      coinDoubler: s.enableCoinDoubler,
    },
    coinDoubler: {
      maxBonus: s.coinDoublerMaxBonus,
      maxPerDay: s.coinDoublerMaxPerDay,
    },
    unitIds: {
      appOpen: s.appOpenAdUnitId,
      banner: s.bannerAdUnitId,
      interstitial: s.interstitialAdUnitId,
      rewarded: s.rewardedAdUnitId,
    },
  };
}
