"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMergedFeed = getMergedFeed;
exports.autoBlacklist = autoBlacklist;
const axios_1 = __importDefault(require("axios"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const redis_1 = require("../config/redis");
const database_1 = require("../config/database");
const logger_1 = require("../utils/logger");
const env_1 = require("../config/env");
const claude = new sdk_1.default({ apiKey: env_1.env.ANTHROPIC_API_KEY });
// ─── Constants ────────────────────────────────────────────────────────────────
const MIN_PAYOUT_USD = 0.03; // ~₹2.5 — show virtually all real offers
const HIGH_VALUE_USD = 0.50; // $0.50+ gets "high value" badge
const FEED_CACHE_TTL = 900; // 15 minutes
const USER_COUNTRY = 'IN';
const TIME_ESTIMATES = {
    CPI: '2-5 min',
    CPE: '1-3 days',
    CPA: '10-30 min',
    CPL: '5-10 min',
};
const DEAD_DOMAINS = [
    'rickroll', 'dqw4w9wgxcq', 'offer-expired', 'campaign-ended', 'example.com',
];
const cleanHtml = (text) => {
    if (!text)
        return '';
    return text
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .trim();
};
// ─── Main Aggregator ──────────────────────────────────────────────────────────
async function getMergedFeed(userId, gaid = '', language = 'en', ip = '') {
    const cacheKey = `offer_feed:${userId}:${gaid}:${language}`;
    const cached = await redis_1.redis.get(cacheKey);
    if (cached) {
        logger_1.logger.info('Serving cached offer feed', { userId });
        return JSON.parse(cached);
    }
    const [qualityMap, socialMap] = await Promise.all([loadQualityMap(), loadSocialMap()]);
    const allOffers = [];
    const [pubscaleResult, ayetResult, toroxResult] = await Promise.allSettled([
        fetchPubScaleOffers(userId, gaid),
        fetchAyetOffers(userId, gaid, ip),
        fetchToroxOffers(userId, gaid, ip),
    ]);
    for (const result of [pubscaleResult, ayetResult, toroxResult]) {
        if (result.status !== 'fulfilled')
            continue;
        for (const offer of result.value) {
            if (isBadOffer(offer, offer.provider, qualityMap))
                continue;
            offer.quality = scoreOffer(offer, offer.provider, qualityMap);
            offer.timeEstimate = TIME_ESTIMATES[offer.offType] || '5-10 min';
            offer.isHighValue = (offer.payoutUsd || 0) >= HIGH_VALUE_USD;
            offer.completionsToday = socialMap[`${offer.provider}:${offer.offerId}`] || 0;
            allOffers.push(offer);
        }
    }
    // Sort: high-value first, then by quality score
    allOffers.sort((a, b) => {
        if (a.isHighValue !== b.isHighValue)
            return b.isHighValue ? 1 : -1;
        return (b.quality || 0) - (a.quality || 0);
    });
    const deduplicated = deduplicateOffers(allOffers);
    let finalOffers = deduplicated;
    if (language !== 'en') {
        finalOffers = await translateOffers(deduplicated, language);
    }
    await redis_1.redis.setex(cacheKey, FEED_CACHE_TTL, JSON.stringify(finalOffers));
    // Fire-and-forget quality score update
    updateQualityScoresAsync(finalOffers).catch((err) => logger_1.logger.error('Quality score update failed:', err));
    return finalOffers;
}
// ─── Translate Offers via Claude AI ───────────────────────────────────────────
const LANGUAGE_NAMES = {
    hi: 'Hindi', bn: 'Bengali', te: 'Telugu', mr: 'Marathi', ta: 'Tamil',
    gu: 'Gujarati', kn: 'Kannada', ml: 'Malayalam', pa: 'Punjabi', ur: 'Urdu',
};
async function translateOffers(offers, language) {
    const langName = LANGUAGE_NAMES[language];
    if (!langName)
        return offers;
    const batchSize = 10;
    const translated = [];
    for (let i = 0; i < offers.length; i += batchSize) {
        const batch = offers.slice(i, i + batchSize);
        try {
            const toTranslate = batch.map((o) => ({
                id: o.offerId,
                name: o.name,
                desc: o.desc,
                events: o.events?.map((e) => ({
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
                const translations = JSON.parse(jsonMatch[0]);
                const tmap = {};
                translations.forEach((t) => { tmap[t.id] = t; });
                for (const offer of batch) {
                    const t = tmap[offer.offerId];
                    if (t) {
                        offer.name = t.name || offer.name;
                        offer.desc = t.desc || offer.desc;
                        if (t.events && offer.events) {
                            offer.events = offer.events.map((e, idx) => ({
                                ...e,
                                eventName: t.events[idx]?.name || e.eventName,
                                callToAction: t.events[idx]?.cta || e.callToAction,
                                instructions: t.events[idx]?.instructions || e.instructions,
                            }));
                        }
                    }
                    translated.push(offer);
                }
            }
            else {
                translated.push(...batch);
            }
        }
        catch {
            translated.push(...batch);
        }
    }
    return translated;
}
// ─── PubScale Provider ────────────────────────────────────────────────────────
async function fetchPubScaleOffers(userId, gaid) {
    try {
        const cacheKey = 'pubscale:raw:feed';
        const cached = await redis_1.redis.get(cacheKey);
        let data;
        if (cached) {
            data = JSON.parse(cached);
        }
        else {
            const response = await axios_1.default.post('https://api-ow.pubscale.com/v1/offer/api', {
                page: 1,
                size: 1000,
                filt: [{ dim: 'platform', match: { type: 'any', value: ['android'] } }],
            }, {
                headers: {
                    'App-Id': env_1.env.PUBSCALE_APP_ID,
                    'Pub-Key': env_1.env.PUBSCALE_PUB_KEY,
                    'Content-Type': 'application/json',
                },
                timeout: 15000,
            });
            data = response.data;
            await redis_1.redis.setex(cacheKey, FEED_CACHE_TTL, JSON.stringify(data));
        }
        const offers = [];
        for (const raw of data.offers || []) {
            const payoutUsd = parseFloat(raw.pyt?.amt || '0');
            if (payoutUsd < MIN_PAYOUT_USD)
                continue;
            if (!isAvailableInIndia(raw))
                continue;
            const offer = normalizePubScaleOffer(raw, userId, gaid);
            if (offer)
                offers.push(offer);
        }
        logger_1.logger.info(`PubScale: ${offers.length} offers fetched`);
        return offers;
    }
    catch (err) {
        logger_1.logger.error('PubScale fetch error:', { message: err.message });
        return [];
    }
}
// ─── AyeT Provider ────────────────────────────────────────────────────────────
async function fetchAyetOffers(userId, _gaid, ip) {
    try {
        if (!env_1.env.AYET_ADSLOT_ID)
            return [];
        const response = await axios_1.default.get(`https://www.ayetstudios.com/offers/offerwall_api/${env_1.env.AYET_ADSLOT_ID}`, {
            params: { external_identifier: userId, os: 'android', ip, include_cpe: 'true' },
            timeout: 10000,
        });
        const result = [];
        for (const o of response.data?.offers || []) {
            const coins = Math.round(o.payout || 0);
            const events = (o.cpe_instructions || []).map((step, idx) => ({
                eventId: step.event_name || String(idx),
                eventName: cleanHtml(step.name || ''),
                callToAction: cleanHtml(step.name || ''),
                instructions: '',
                coins: Math.round(step.payout || 0),
                payoutUsd: 0,
                order: idx + 1,
                click: o.tracking_link || '',
                status: step.completed ? 'completed' : 'pending',
                completed: Boolean(step.completed),
            }));
            if (events.length === 0) {
                events.push({
                    eventId: '', eventName: o.name || '', callToAction: 'Complete Offer',
                    instructions: '', coins, payoutUsd: 0, order: 1,
                    click: o.tracking_link || '', status: 'pending', completed: false,
                });
            }
            result.push({
                provider: 'ayet',
                offerId: String(o.id || ''),
                name: o.name || '',
                desc: o.name || '',
                icon: o.icon || '',
                category: 'GAMING',
                offType: events.length > 1 ? 'CPE' : 'CPI',
                coins,
                payoutUsd: 0,
                click: o.tracking_link || '',
                events,
                os: 'android',
            });
        }
        logger_1.logger.info(`AyeT: ${result.length} offers fetched`);
        return result;
    }
    catch (err) {
        logger_1.logger.error('AyeT fetch error:', { message: err.message });
        return [];
    }
}
// ─── Torox Provider ───────────────────────────────────────────────────────────
async function fetchToroxOffers(userId, gaid, ip) {
    try {
        if (!env_1.env.TOROX_API_KEY || !env_1.env.TOROX_PUB_ID)
            return [];
        const response = await axios_1.default.get('https://api.torox.io/api/v1/offers', {
            params: {
                api_key: env_1.env.TOROX_API_KEY,
                app_id: env_1.env.TOROX_PUB_ID,
                uid: userId,
                device_id: gaid || 'unknown',
                ip,
                os: 'android',
            },
            timeout: 15000,
        });
        const data = response.data;
        const raw = data.data || data.offers || data.result || (Array.isArray(data) ? data : []);
        const result = [];
        for (const o of raw) {
            const name = o.name || o.title || '';
            const coins = Math.round(o.coins || o.payout || o.reward || 0);
            const clickUrl = o.click || o.tracking_url || o.click_url || o.url || o.redirect_url || '';
            if (!name || !clickUrl)
                continue;
            const events = (o.events || o.tasks || o.goals || []).map((ev) => ({
                eventId: String(ev.event_id || ev.id || ''),
                eventName: ev.event_name || ev.name || '',
                callToAction: ev.call_to_action || ev.event_name || ev.name || '',
                instructions: cleanHtml(ev.instructions || ''),
                coins: Math.round(ev.coins || ev.payout || ev.reward || 0),
                payoutUsd: parseFloat(ev.payout_usd || '0'),
                order: parseInt(ev.order || '1'),
                click: ev.click || ev.tracking_url || ev.url || clickUrl,
                status: 'pending',
                completed: false,
            }));
            if (events.length === 0) {
                events.push({
                    eventId: '', eventName: name, callToAction: 'Complete Offer',
                    instructions: o.desc || o.description || '', coins, payoutUsd: 0,
                    order: 1, click: clickUrl, status: 'pending', completed: false,
                });
            }
            result.push({
                provider: 'torox',
                offerId: String(o.offer_id || o.id || ''),
                name,
                desc: o.desc || o.description || name,
                icon: o.icon || o.image || o.icon_url || '',
                category: 'APP',
                offType: events.length > 1 ? 'CPE' : 'CPI',
                coins,
                payoutUsd: parseFloat(o.payout_usd || '0'),
                click: clickUrl,
                events,
                os: 'android',
            });
        }
        logger_1.logger.info(`Torox: ${result.length} offers fetched`);
        return result;
    }
    catch (err) {
        logger_1.logger.error('Torox fetch error:', { message: err.message });
        return [];
    }
}
// ─── Normalize PubScale Offer ─────────────────────────────────────────────────
function normalizePubScaleOffer(o, userId, gaid) {
    if (!o.id || !o.name)
        return null;
    const offerId = String(o.id);
    const offType = o.off_type || 'CPI';
    const offerTrkUrl = o.trk_url || '';
    let totalCoins = 0;
    for (const gl of o.gls || [])
        totalCoins += Math.round(gl.inapp_pyt?.amt || 0);
    if (totalCoins === 0)
        totalCoins = Math.round(o.inapp_pyt?.amt || 0);
    const events = (o.gls || []).map((gl) => {
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
    }).sort((a, b) => a.order - b.order);
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
async function loadQualityMap() {
    try {
        const records = await database_1.prisma.offerQualityScore.findMany();
        const map = {};
        for (const r of records)
            map[`${r.provider}:${r.offerId}`] = r;
        return map;
    }
    catch {
        return {};
    }
}
async function loadSocialMap() {
    try {
        // Count all-time completions per offer from quality scores
        const records = await database_1.prisma.offerQualityScore.findMany({
            select: { provider: true, offerId: true, totalCompletions: true },
        });
        const map = {};
        for (const r of records)
            map[`${r.provider}:${r.offerId}`] = r.totalCompletions;
        return map;
    }
    catch {
        return {};
    }
}
function isBadOffer(offer, provider, qualityMap) {
    if (!offer.name || !offer.click)
        return true;
    const clickLower = (offer.click || '').toLowerCase();
    for (const dead of DEAD_DOMAINS) {
        if (clickLower.includes(dead.toLowerCase())) {
            autoBlacklist(provider, offer.offerId, `Dead URL: ${dead}`).catch(() => null);
            return true;
        }
    }
    const record = qualityMap[`${provider}:${offer.offerId || ''}`];
    if (!record)
        return false;
    if (record.isBlacklisted)
        return true;
    if (record.missingCoinReports >= 2)
        return true;
    if (record.totalClicks >= 20 && record.totalCompletions === 0) {
        autoBlacklist(provider, offer.offerId, `Auto: ${record.totalClicks} clicks, 0 completions`).catch(() => null);
        return true;
    }
    if (record.avgRating > 0 && record.avgRating < 2.0 && record.ratingCount >= 5)
        return true;
    return false;
}
function scoreOffer(offer, provider, qualityMap) {
    let score = 0;
    const record = qualityMap[`${provider}:${offer.offerId || ''}`];
    score += Math.min(20, (offer.payoutUsd || 0) / 2 * 20);
    if (!record || record.totalClicks === 0) {
        score += 15; // New offer bonus
    }
    else if (record.totalClicks < 5) {
        score += Math.min(50, (record.completionRate / 25) * 50) * 0.3;
    }
    else {
        score += Math.min(50, (record.completionRate / 25) * 50);
    }
    if (offer.icon)
        score += 4;
    if (offer.desc)
        score += 3;
    const taskCount = (offer.events || []).length;
    if (taskCount === 1)
        score += 5;
    if (taskCount > 1)
        score += 8;
    if (offer.isHighValue)
        score += 10;
    if (record?.avgRating > 0)
        score += (record.avgRating - 3) * 5;
    if (record)
        score -= record.missingCoinReports * 10;
    return Math.round(Math.min(100, Math.max(0, score)) * 100) / 100;
}
async function updateQualityScoresAsync(offers) {
    for (const offer of offers) {
        if (!offer.offerId)
            continue;
        try {
            await database_1.prisma.offerQualityScore.upsert({
                where: { provider_offerId: { provider: offer.provider, offerId: offer.offerId } },
                update: { offerName: offer.name, qualityScore: offer.quality || 0, isActive: true, lastSeenAt: new Date() },
                create: { provider: offer.provider, offerId: offer.offerId, offerName: offer.name, qualityScore: offer.quality || 0, isActive: true },
            });
        }
        catch {
            // silent
        }
    }
}
async function autoBlacklist(provider, offerId, reason) {
    if (!offerId)
        return;
    try {
        await database_1.prisma.offerQualityScore.upsert({
            where: { provider_offerId: { provider, offerId } },
            update: { isBlacklisted: true, isActive: false, blacklistReason: reason.substring(0, 255) },
            create: { provider, offerId, isBlacklisted: true, isActive: false, blacklistReason: reason.substring(0, 255) },
        });
    }
    catch {
        // silent
    }
}
// ─── Deduplication ────────────────────────────────────────────────────────────
function deduplicateOffers(offers) {
    const seenName = {};
    const seenPkg = {};
    const result = [];
    for (const offer of offers) {
        const normalizedName = (offer.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const pkgMatch = (offer.click || '').match(/[?&/](?:id=|details\/)([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)/i);
        const packageId = pkgMatch ? pkgMatch[1].toLowerCase() : '';
        if ((normalizedName && seenName[normalizedName]) || (packageId && seenPkg[packageId]))
            continue;
        if (normalizedName)
            seenName[normalizedName] = true;
        if (packageId)
            seenPkg[packageId] = true;
        result.push(offer);
    }
    return result;
}
// ─── Helpers ──────────────────────────────────────────────────────────────────
function isAvailableInIndia(raw) {
    const geo = raw.geo_tgt || {};
    if (!geo.include && !geo.exclude)
        return true;
    if ((geo.exclude || []).includes(USER_COUNTRY))
        return false;
    if (geo.include?.length > 0 && !geo.include.includes(USER_COUNTRY))
        return false;
    return true;
}
function buildClickUrl(trkUrl, userId, gaid) {
    if (!trkUrl)
        return '';
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
function mapCategory(ctg, offType) {
    const ctgStr = ctg.join(',');
    if (ctgStr.includes('GAMING'))
        return 'GAMING';
    if (ctgStr.includes('FINANCE'))
        return 'FINANCE';
    if (ctgStr.includes('SURVEY'))
        return 'SURVEY';
    if (offType === 'CPI' || offType === 'APK_INSTALL')
        return 'APP';
    if (offType === 'CPE')
        return 'GAMING';
    return 'APP';
}
