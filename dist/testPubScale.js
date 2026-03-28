"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const axios_1 = __importDefault(require("axios"));
const APP_ID = process.env.PUBSCALE_APP_ID || '27035898';
const PUB_KEY = process.env.PUBSCALE_PUB_KEY || '';
const MIN_PAYOUT_USD = 0.03;
const USER_COUNTRY = 'IN';
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
async function testPubScale() {
    console.log('Testing PubScale API (with NEW filter thresholds)...\n');
    try {
        const response = await axios_1.default.post('https://api-ow.pubscale.com/v1/offer/api', { page: 1, size: 100, filt: [{ dim: 'platform', match: { type: 'any', value: ['android'] } }] }, {
            headers: { 'App-Id': APP_ID, 'Pub-Key': PUB_KEY, 'Content-Type': 'application/json' },
            timeout: 15000,
        });
        const offers = response.data?.offers || [];
        console.log(`Platform total: ${response.data?.total} | Sample: ${offers.length}`);
        // Apply new filters
        const passIndia = offers.filter(isAvailableInIndia);
        const passPayout = offers.filter((o) => parseFloat(o.pyt?.amt || '0') >= MIN_PAYOUT_USD);
        const passBoth = offers.filter((o) => isAvailableInIndia(o) && parseFloat(o.pyt?.amt || '0') >= MIN_PAYOUT_USD);
        console.log(`\n── Filter results (new: $${MIN_PAYOUT_USD} threshold) ──`);
        console.log(`  Pass India geo:      ${passIndia.length} / ${offers.length}`);
        console.log(`  Pass payout $${MIN_PAYOUT_USD}: ${passPayout.length} / ${offers.length}`);
        console.log(`  Pass BOTH (shown):   ${passBoth.length} / ${offers.length}  ← was 2 before, now should be higher`);
        console.log(`  Extrapolated total:  ~${Math.round((passBoth.length / offers.length) * (response.data?.total || 0))} offers from 1872`);
        console.log('\n── All India-available offers in sample ──');
        passBoth.forEach((o, i) => {
            const payoutUsd = parseFloat(o.pyt?.amt || '0');
            let totalCoins = 0;
            for (const gl of o.gls || [])
                totalCoins += Math.round(gl.inapp_pyt?.amt || 0);
            if (totalCoins === 0)
                totalCoins = Math.round(o.inapp_pyt?.amt || 0);
            const geo = o.geo_tgt || {};
            console.log(`\n  [${i + 1}] ${o.name}`);
            console.log(`       Type:    ${o.off_type}`);
            console.log(`       USD:     $${payoutUsd.toFixed(4)}`);
            console.log(`       Coins:   ${totalCoins}`);
            console.log(`       Goals:   ${o.gls?.length || 0}`);
            console.log(`       Geo:     include=${JSON.stringify(geo.include)}`);
        });
        // Check earn endpoint
        console.log('\n── Testing /api/earn/offers endpoint ──');
        try {
            const earnRes = await axios_1.default.get('http://localhost:3000/api/earn/offers', {
                headers: { Authorization: 'Bearer invalid' },
                validateStatus: () => true,
            });
            console.log(`  Status: ${earnRes.status} (401 expected — needs valid user JWT)`);
        }
        catch {
            console.log('  Server not running on port 3000');
        }
    }
    catch (error) {
        console.error('PubScale API Error:', error.response?.status, error.message);
        console.error(JSON.stringify(error.response?.data, null, 2));
    }
}
testPubScale();
