import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { redis, rk } from '../config/redis';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { env } from '../config/env';

const claude = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ─── Constants ────────────────────────────────────────────────────────────────
const MIN_PAYOUT_USD = 0.03;   // ~₹2.5 — show virtually all real offers
const HIGH_VALUE_USD = 0.50;   // $0.50+ gets "high value" badge
const FEED_CACHE_TTL = 900; // 15 minutes
const DEFAULT_COUNTRY = 'IN';  // fallback if IP lookup fails

const TIME_ESTIMATES: Record<string, string> = {
  CPI: '2-5 min',
  CPE: '1-3 days',
  CPA: '10-30 min',
  CPL: '5-10 min',
};

const DEAD_DOMAINS = [
  'rickroll', 'dqw4w9wgxcq', 'offer-expired', 'campaign-ended', 'example.com',
];

const cleanHtml = (text: string): string => {
  if (!text) return '';
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();
};

// ─── Country detection from IP ────────────────────────────────────────────────
function getCountryFromIp(ip: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const geoip = require('geoip-lite');
    const clean = ip.replace(/^::ffff:/, ''); // strip IPv4-mapped IPv6 prefix
    const geo = geoip.lookup(clean);
    return geo?.country || DEFAULT_COUNTRY;
  } catch {
    return DEFAULT_COUNTRY;
  }
}

// ─── Main Aggregator ──────────────────────────────────────────────────────────
export async function getMergedFeed(
  userId: string,
  gaid = '',
  language = 'en',
  ip = ''
): Promise<any[]> {
  const country = getCountryFromIp(ip) || DEFAULT_COUNTRY;
  const cacheKey = rk(`offer_feed:${userId}:${gaid}:${language}:${country}`);
  const cached = await redis.get(cacheKey);
  if (cached) {
    logger.info('Serving cached offer feed', { userId, country });
    return JSON.parse(cached);
  }

  logger.info('Building offer feed', { userId, country, ip });
  const [qualityMap, socialMap] = await Promise.all([loadQualityMap(), loadSocialMap()]);

  const allOffers: any[] = [];

  const [pubscaleResult, ayetResult, toroxResult] = await Promise.allSettled([
    fetchPubScaleOffers(userId, gaid, country),
    fetchAyetOffers(userId, gaid, ip),
    fetchToroxOffers(userId, gaid, ip, country),
  ]);

  for (const result of [pubscaleResult, ayetResult, toroxResult]) {
    if (result.status !== 'fulfilled') continue;
    for (const offer of result.value) {
      if (isBadOffer(offer, offer.provider, qualityMap)) continue;
      const record = qualityMap[`${offer.provider}:${offer.offerId}`];
      offer.quality = scoreOffer(offer, offer.provider, qualityMap);
      offer.completionRate = record?.completionRate ?? (record ? 0 : 50); // 50 = optimistic default for new offers
      offer.timeEstimate = TIME_ESTIMATES[offer.offType] || '5-10 min';
      offer.isHighValue = (offer.payoutUsd || 0) >= HIGH_VALUE_USD;
      offer.completionsToday = socialMap[`${offer.provider}:${offer.offerId}`] || 0;
      allOffers.push(offer);
    }
  }

  // Sort: high-value first, then by quality score
  allOffers.sort((a, b) => {
    if (a.isHighValue !== b.isHighValue) return b.isHighValue ? 1 : -1;
    return (b.quality || 0) - (a.quality || 0);
  });

  const deduplicated = deduplicateOffers(allOffers);

  // Provider diversity: cap at 5 offers per provider in top 15, then allow more below
  const diversified = diversifyProviders(deduplicated, 5, 15);

  let finalOffers = diversified;
  if (language !== 'en') {
    finalOffers = await translateOffers(diversified, language);
  }

  await redis.setex(cacheKey, FEED_CACHE_TTL, JSON.stringify(finalOffers));

  // Fire-and-forget quality score update
  updateQualityScoresAsync(finalOffers).catch((err) =>
    logger.error('Quality score update failed:', err)
  );

  return finalOffers;
}

// ─── Translate Offers via Claude AI ───────────────────────────────────────────
const LANGUAGE_NAMES: Record<string, string> = {
  hi: 'Hindi', bn: 'Bengali', te: 'Telugu', mr: 'Marathi', ta: 'Tamil',
  gu: 'Gujarati', kn: 'Kannada', ml: 'Malayalam', pa: 'Punjabi', ur: 'Urdu',
};

async function translateOffers(offers: any[], language: string): Promise<any[]> {
  const langName = LANGUAGE_NAMES[language];
  if (!langName) return offers;

  const batchSize = 10;
  const translated: any[] = [];

  for (let i = 0; i < offers.length; i += batchSize) {
    const batch = offers.slice(i, i + batchSize);
    try {
      const toTranslate = batch.map((o) => ({
        id: o.offerId,
        name: o.name,
        desc: o.desc,
        events: o.events?.map((e: any) => ({
          name: e.eventName,
          cta: e.callToAction,
          instructions: e.instructions,
        })),
      }));

      const response = await claude.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `Translate these offer details to ${langName}. Keep brand names, app names, and numbers in English. Return ONLY JSON array, no other text:\n${JSON.stringify(toTranslate)}\n\nReturn format:\n[{"id":"offer_id","name":"translated","desc":"translated","events":[{"name":"translated","cta":"translated","instructions":"translated"}]}]`,
        }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const translations: any[] = JSON.parse(jsonMatch[0]);
        const tmap: Record<string, any> = {};
        translations.forEach((t) => { tmap[t.id] = t; });

        for (const offer of batch) {
          const t = tmap[offer.offerId];
          if (t) {
            offer.name = t.name || offer.name;
            offer.desc = t.desc || offer.desc;
            if (t.events && offer.events) {
              offer.events = offer.events.map((e: any, idx: number) => ({
                ...e,
                eventName: t.events[idx]?.name || e.eventName,
                callToAction: t.events[idx]?.cta || e.callToAction,
                instructions: t.events[idx]?.instructions || e.instructions,
              }));
            }
          }
          translated.push(offer);
        }
      } else {
        translated.push(...batch);
      }
    } catch {
      translated.push(...batch);
    }
  }

  return translated;
}

// ─── PubScale Provider ────────────────────────────────────────────────────────
async function fetchPubScaleOffers(userId: string, gaid: string, country: string): Promise<any[]> {
  try {
    if (!env.PUBSCALE_APP_ID || !env.PUBSCALE_PUB_KEY) return [];

    // Raw feed cached globally (country-agnostic) — geo filtering done locally
    const cacheKey = rk('pubscale:raw:feed');
    const cached = await redis.get(cacheKey);

    let data: any;
    if (cached) {
      data = JSON.parse(cached);
    } else {
      const response = await axios.post(
        'https://api-ow.pubscale.com/v1/offer/api',
        {
          page: 1,
          size: 1000,
          filt: [{ dim: 'platform', match: { type: 'any', value: ['android'] } }],
        },
        {
          headers: {
            'App-Id': env.PUBSCALE_APP_ID,
            'Pub-Key': env.PUBSCALE_PUB_KEY,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );
      data = response.data;
      await redis.setex(cacheKey, FEED_CACHE_TTL, JSON.stringify(data));
    }

    const offers: any[] = [];
    for (const raw of data.offers || []) {
      const payoutUsd = parseFloat(raw.pyt?.amt || '0');
      if (payoutUsd < MIN_PAYOUT_USD) continue;
      if (!isAvailableInCountry(raw, country)) continue;
      const offer = normalizePubScaleOffer(raw, userId, gaid);
      if (offer) offers.push(offer);
    }

    logger.info(`PubScale: ${offers.length} offers for country=${country}`);
    return offers;
  } catch (err) {
    logger.error('PubScale fetch error:', { message: (err as Error).message });
    return [];
  }
}

// ─── AyeT Provider ────────────────────────────────────────────────────────────
async function fetchAyetOffers(userId: string, _gaid: string, ip: string): Promise<any[]> {
  try {
    if (!env.AYET_ADSLOT_ID) return [];

    const response = await axios.get(
      `https://www.ayetstudios.com/offers/offerwall_api/${env.AYET_ADSLOT_ID}`,
      {
        params: { external_identifier: userId, os: 'android', ip, include_cpe: 'true' },
        timeout: 10000,
      }
    );

    const result: any[] = [];
    for (const o of response.data?.offers || []) {
      // Skip iOS-only offers
      const platform = (o.platform || o.os || '').toLowerCase();
      if (platform && platform !== 'android' && platform !== 'both' && platform !== 'all') continue;

      const totalCoins = Math.round(o.payout || 0);
      const steps: any[] = o.cpe_instructions || [];
      const totalStepCoins = steps.reduce((sum: number, s: any) => sum + (s.payout || 0), 0);

      // Distribute coins across steps proportionally if step payouts are 0
      const events: any[] = steps.map((step: any, idx: number) => {
        const stepCoins = step.payout
          ? Math.round(step.payout)
          : (steps.length > 0 ? Math.round(totalCoins / steps.length) : totalCoins);
        return {
          eventId: step.event_name || String(o.id) + '_' + idx,
          eventName: cleanHtml(step.name || `Step ${idx + 1}`),
          callToAction: cleanHtml(step.name || `Step ${idx + 1}`),
          instructions: cleanHtml(step.instructions || ''),
          coins: stepCoins,
          payoutUsd: 0,
          order: idx + 1,
          click: o.tracking_link || '',
          status: step.completed ? 'completed' : 'pending',
          completed: Boolean(step.completed),
        };
      });

      if (events.length === 0) {
        events.push({
          eventId: String(o.id || ''), eventName: o.name || '', callToAction: 'Complete Offer',
          instructions: '', coins: totalCoins, payoutUsd: 0, order: 1,
          click: o.tracking_link || '', status: 'pending', completed: false,
        });
      }

      if (!o.tracking_link) continue;

      result.push({
        provider: 'ayet',
        offerId: String(o.id || ''),
        name: o.name || '',
        desc: cleanHtml(o.description || o.name || ''),
        icon: o.icon || '',
        category: events.length > 1 ? 'GAMING' : 'APP',
        offType: events.length > 1 ? 'CPE' : 'CPI',
        coins: totalCoins,
        payoutUsd: 0,
        click: o.tracking_link || '',
        events,
        os: 'android',
      });
    }

    logger.info(`AyeT: ${result.length} offers fetched`);
    return result;
  } catch (err) {
    logger.error('AyeT fetch error:', { message: (err as Error).message });
    return [];
  }
}

// ─── Torox Provider ───────────────────────────────────────────────────────────
async function fetchToroxOffers(userId: string, gaid: string, ip: string, country: string): Promise<any[]> {
  try {
    if (!env.TOROX_API_KEY || !env.TOROX_APP_ID) return [];

    // New Torox API: GET /partner/campaigns
    const response = await axios.get('https://torox.io/partner/campaigns', {
      params: {
        source_id: env.TOROX_APP_ID,
        token: env.TOROX_API_KEY,
        goals: 'all',
      },
      timeout: 15000,
    });

    const data = response.data;
    logger.info('Torox API raw response keys:', Object.keys(data || {}));
    const raw: any[] = data.data || data.campaigns || data.offers || data.result || (Array.isArray(data) ? data : []);
    logger.info(`Torox: raw campaign count=${raw.length}`);

    const result: any[] = [];
    for (const o of raw) {
      const campaignId = String(o.campaign_id || o.id || '');
      const name = o.name || o.title || '';
      if (!name || !campaignId) continue;

      const payout = o.payout || o.revenue || o.reward || 0;
      const coins = Math.round(parseFloat(String(payout)) * 100); // $1 = 100 coins

      // Generate per-user click URL via Torox API
      let clickUrl = '';
      try {
        const clickResp = await axios.get('https://torox.io/partner/user/click', {
          params: {
            source_id: env.TOROX_APP_ID,
            token: env.TOROX_API_KEY,
            uid: userId,
            geo: country,
            campaign_id: campaignId,
          },
          timeout: 5000,
        });
        clickUrl = clickResp.data?.click_url || clickResp.data?.url || '';
      } catch {
        // fallback to iframe URL
        clickUrl = `https://torox.io/ifr/show/${env.TOROX_PUB_ID}/${userId}/${env.TOROX_APP_ID}`;
      }

      const goals: any[] = o.goals || o.events || o.tasks || [];
      const events: any[] = goals.map((ev: any, i: number) => ({
        eventId: String(ev.goal_id || ev.id || i),
        eventName: ev.goal_name || ev.name || '',
        callToAction: ev.goal_name || ev.name || 'Complete',
        instructions: cleanHtml(ev.instructions || ''),
        coins: Math.round(parseFloat(String(ev.payout || ev.revenue || 0)) * 100),
        payoutUsd: parseFloat(String(ev.payout || 0)),
        order: i + 1,
        click: clickUrl,
        status: 'pending',
        completed: false,
      }));

      if (events.length === 0) {
        events.push({
          eventId: '', eventName: name, callToAction: 'Complete Offer',
          instructions: o.description || '', coins, payoutUsd: parseFloat(String(payout)),
          order: 1, click: clickUrl, status: 'pending', completed: false,
        });
      }

      result.push({
        provider: 'torox',
        offerId: campaignId,
        name,
        desc: o.description || o.desc || name,
        icon: o.icon || o.image || o.icon_url || '',
        category: 'APP',
        offType: events.length > 1 ? 'CPE' : 'CPI',
        coins,
        payoutUsd: parseFloat(String(payout)),
        click: clickUrl,
        events,
        os: 'android',
      });
    }

    logger.info(`Torox: ${result.length} offers built`);
    return result;
  } catch (err) {
    logger.error('Torox fetch error:', { message: (err as Error).message });
    return [];
  }
}

// ─── Normalize PubScale Offer ─────────────────────────────────────────────────
function normalizePubScaleOffer(o: any, userId: string, gaid: string): any | null {
  if (!o.id || !o.name) return null;

  const offerId = String(o.id);
  const offType = o.off_type || 'CPI';
  const offerTrkUrl = o.trk_url || '';

  let totalCoins = 0;
  for (const gl of o.gls || []) totalCoins += Math.round(gl.inapp_pyt?.amt || 0);
  if (totalCoins === 0) totalCoins = Math.round(o.inapp_pyt?.amt || 0);

  const events: any[] = (o.gls || []).map((gl: any) => {
    const goalId = String(gl.id || '');
    const goalTrkUrl = offerTrkUrl.replace(/rid=\d+/, `rid=${goalId}`);
    return {
      eventId: goalId,
      eventName: cleanHtml(gl.ttl || ''),
      callToAction: cleanHtml(gl.ttl || ''),
      instructions: cleanHtml(gl.instr || ''),
      coins: Math.round(gl.inapp_pyt?.amt || 0),
      payoutUsd: parseFloat(gl.pyt?.amt || '0'),
      order: parseInt(gl.ord || '1'),
      click: buildClickUrl(goalTrkUrl, userId, gaid),
      status: 'pending',
      completed: false,
    };
  }).sort((a: any, b: any) => a.order - b.order);

  return {
    provider: 'pubscale',
    offerId,
    name: o.name || '',
    desc: cleanHtml(o.desc?.raw || o.name || ''),
    icon: o.crtvs?.ic_url || '',
    category: mapCategory(o.ctg || [], offType),
    offType,
    coins: totalCoins,
    payoutUsd: parseFloat(o.pyt?.amt || '0'),
    click: buildClickUrl(offerTrkUrl, userId, gaid),
    events,
    geo: o.geo_tgt || {},
    os: o.os || 'android',
  };
}

// ─── Quality Engine ───────────────────────────────────────────────────────────
async function loadQualityMap(): Promise<Record<string, any>> {
  try {
    const records = await prisma.offerQualityScore.findMany();
    const map: Record<string, any> = {};
    for (const r of records) map[`${r.provider}:${r.offerId}`] = r;
    return map;
  } catch {
    return {};
  }
}

async function loadSocialMap(): Promise<Record<string, number>> {
  try {
    // Count all-time completions per offer from quality scores
    const records = await prisma.offerQualityScore.findMany({
      select: { provider: true, offerId: true, totalCompletions: true },
    });
    const map: Record<string, number> = {};
    for (const r of records) map[`${r.provider}:${r.offerId}`] = r.totalCompletions;
    return map;
  } catch {
    return {};
  }
}

function isBadOffer(offer: any, provider: string, qualityMap: Record<string, any>): boolean {
  if (!offer.name || !offer.click) return true;

  const clickLower = (offer.click || '').toLowerCase();
  for (const dead of DEAD_DOMAINS) {
    if (clickLower.includes(dead.toLowerCase())) {
      autoBlacklist(provider, offer.offerId, `Dead URL: ${dead}`).catch(() => null);
      return true;
    }
  }

  const record = qualityMap[`${provider}:${offer.offerId || ''}`];
  if (!record) return false;
  if (record.isBlacklisted) return true;
  if (record.missingCoinReports >= 2) return true;
  if (record.totalClicks >= 30 && record.completionRate < 3) {
    autoBlacklist(provider, offer.offerId, `Auto: ${record.totalClicks} clicks, ${record.completionRate}% completion`).catch(() => null);
    return true;
  }
  if (record.avgRating > 0 && record.avgRating < 2.0 && record.ratingCount >= 5) return true;
  return false;
}

function scoreOffer(offer: any, provider: string, qualityMap: Record<string, any>): number {
  let score = 0;
  const record = qualityMap[`${provider}:${offer.offerId || ''}`];

  score += Math.min(20, (offer.payoutUsd || 0) / 2 * 20);

  if (!record || record.totalClicks === 0) {
    score += 15; // New offer bonus
  } else if (record.totalClicks < 5) {
    score += Math.min(50, (record.completionRate / 25) * 50) * 0.3;
  } else {
    score += Math.min(50, (record.completionRate / 25) * 50);
  }

  if (offer.icon) score += 4;
  if (offer.desc) score += 3;
  const taskCount = (offer.events || []).length;
  if (taskCount === 1) score += 5;
  if (taskCount > 1) score += 8;
  if (offer.isHighValue) score += 10;
  if (record?.avgRating > 0) score += (record.avgRating - 3) * 5;
  if (record) score -= record.missingCoinReports * 10;

  return Math.round(Math.min(100, Math.max(0, score)) * 100) / 100;
}

async function updateQualityScoresAsync(offers: any[]): Promise<void> {
  for (const offer of offers) {
    if (!offer.offerId) continue;
    try {
      await prisma.offerQualityScore.upsert({
        where: { provider_offerId: { provider: offer.provider, offerId: offer.offerId } },
        update: { offerName: offer.name, qualityScore: offer.quality || 0, isActive: true, lastSeenAt: new Date() },
        create: { provider: offer.provider, offerId: offer.offerId, offerName: offer.name, qualityScore: offer.quality || 0, isActive: true },
      });
    } catch {
      // silent
    }
  }
}

export async function autoBlacklist(provider: string, offerId: string, reason: string): Promise<void> {
  if (!offerId) return;
  try {
    await prisma.offerQualityScore.upsert({
      where: { provider_offerId: { provider, offerId } },
      update: { isBlacklisted: true, isActive: false, blacklistReason: reason.substring(0, 255) },
      create: { provider, offerId, isBlacklisted: true, isActive: false, blacklistReason: reason.substring(0, 255) },
    });
  } catch {
    // silent
  }
}

// ─── Deduplication ────────────────────────────────────────────────────────────
function deduplicateOffers(offers: any[]): any[] {
  const seenName: Record<string, boolean> = {};
  const seenPkg: Record<string, boolean> = {};
  const result: any[] = [];

  for (const offer of offers) {
    const normalizedName = (offer.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const pkgMatch = (offer.click || '').match(
      /[?&/](?:id=|details\/)([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)/i
    );
    const packageId = pkgMatch ? pkgMatch[1].toLowerCase() : '';

    if ((normalizedName && seenName[normalizedName]) || (packageId && seenPkg[packageId])) continue;
    if (normalizedName) seenName[normalizedName] = true;
    if (packageId) seenPkg[packageId] = true;
    result.push(offer);
  }
  return result;
}

// ─── Provider Diversity ───────────────────────────────────────────────────────
// In the top `topN` results, cap each provider to `maxPerProvider`.
// Offers beyond that cap are appended after position `topN` in original score order.
function diversifyProviders(offers: any[], maxPerProvider: number, topN: number): any[] {
  const top: any[] = [];
  const overflow: any[] = [];
  const providerCount: Record<string, number> = {};

  for (const offer of offers) {
    const p = offer.provider || 'unknown';
    if (top.length < topN && (providerCount[p] || 0) < maxPerProvider) {
      top.push(offer);
      providerCount[p] = (providerCount[p] || 0) + 1;
    } else {
      overflow.push(offer);
    }
  }

  return [...top, ...overflow];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isAvailableInCountry(raw: any, country: string): boolean {
  const geo = raw.geo_tgt || {};
  if (!geo.include && !geo.exclude) return true;
  if ((geo.exclude || []).includes(country)) return false;
  if (geo.include?.length > 0 && !geo.include.includes(country)) return false;
  return true;
}

function buildClickUrl(trkUrl: string, userId: string, gaid: string): string {
  if (!trkUrl) return '';

  // Only replace known placeholders — do NOT modify the URL structure
  return trkUrl
    .replace(/\{your_user_id\}/gi, userId)
    .replace(/%7Byour_user_id%7D/gi, userId)
    .replace(/\{user_id\}/gi, userId)
    .replace(/%7Buser_id%7D/gi, userId)
    .replace(/\{gaid_for_android\}/gi, gaid || 'unknown')
    .replace(/%7Bgaid_for_android%7D/gi, gaid || 'unknown')
    .replace(/\{gaid\}/gi, gaid || 'unknown')
    .replace(/%7Bgaid%7D/gi, gaid || 'unknown')
    .replace(/\{idfa_for_ios\}/gi, '')
    .replace(/%7Bidfa_for_ios%7D/gi, '')
    .replace(/\{idfa\}/gi, '')
    .replace(/%7Bidfa%7D/gi, '');
}

function mapCategory(ctg: string[], offType: string): string {
  const ctgStr = ctg.join(',');
  if (ctgStr.includes('GAMING')) return 'GAMING';
  if (ctgStr.includes('FINANCE')) return 'FINANCE';
  if (ctgStr.includes('SURVEY')) return 'SURVEY';
  if (offType === 'CPI' || offType === 'APK_INSTALL') return 'APP';
  if (offType === 'CPE') return 'GAMING';
  return 'APP';
}
