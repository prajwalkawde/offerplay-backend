"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUserReferralLink = exports.trackInstall = exports.handleReferralRedirect = void 0;
const database_1 = require("../config/database");
// GET /r/:code  ─ landing page redirect with click tracking
const handleReferralRedirect = async (req, res) => {
    try {
        const code = req.params.code;
        const ua = req.headers['user-agent'] || '';
        const isAndroid = /android/i.test(ua);
        const isIOS = /iphone|ipad/i.test(ua);
        // Track click (fire-and-forget)
        database_1.prisma.referralLink.updateMany({
            where: { shortCode: code.toUpperCase() },
            data: { clicks: { increment: 1 } },
        }).catch(() => { });
        const playStoreUrl = 'https://play.google.com/store/apps/details?id=com.offerplay.app';
        const appStoreUrl = 'https://apps.apple.com/app/offerplay/id000000000';
        const landingUrl = `https://offerplay.in/join?ref=${code}&from=share`;
        if (isAndroid) {
            res.redirect(`intent://offerplay/join?ref=${code}#Intent;` +
                `scheme=offerplay;` +
                `package=com.offerplay.app;` +
                `S.browser_fallback_url=${encodeURIComponent(playStoreUrl + `&referrer=ref_${code}`)};end`);
            return;
        }
        if (isIOS) {
            res.redirect(`${appStoreUrl}?referrer=ref_${code}`);
            return;
        }
        res.redirect(landingUrl);
    }
    catch {
        res.redirect('https://offerplay.in');
    }
};
exports.handleReferralRedirect = handleReferralRedirect;
// POST /api/referral/track-install  ─ called from app on first open
const trackInstall = async (req, res) => {
    try {
        const { referralCode } = req.body;
        if (!referralCode) {
            res.json({ success: false });
            return;
        }
        database_1.prisma.referralLink.updateMany({
            where: { shortCode: referralCode.toUpperCase() },
            data: { installs: { increment: 1 } },
        }).catch(() => { });
        res.json({ success: true, referralCode });
    }
    catch {
        res.json({ success: false });
    }
};
exports.trackInstall = trackInstall;
// GET /api/referral/link  ─ get or create tracking link for authenticated user
const getUserReferralLink = async (req, res) => {
    try {
        const userId = req.userId;
        const user = await database_1.prisma.user.findUnique({
            where: { id: userId },
            select: { referralCode: true, name: true },
        });
        let code = user?.referralCode;
        if (!code) {
            code = generateCode(user?.name || 'USER');
            await database_1.prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
        }
        let link = await database_1.prisma.referralLink.findUnique({ where: { shortCode: code } });
        if (!link) {
            link = await database_1.prisma.referralLink.create({ data: { userId, shortCode: code } });
        }
        const shareUrl = `https://offerplay.in/r/${code}`;
        const playStoreUrl = `https://play.google.com/store/apps/details?id=com.offerplay.app&referrer=ref_${code}`;
        res.json({
            success: true,
            data: {
                referralCode: code,
                shareUrl,
                playStoreUrl,
                stats: {
                    clicks: link.clicks,
                    installs: link.installs,
                    conversions: link.conversions,
                },
            },
        });
    }
    catch {
        res.json({ success: false });
    }
};
exports.getUserReferralLink = getUserReferralLink;
function generateCode(name) {
    const c = name.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'USER';
    return c + Math.floor(1000 + Math.random() * 9000);
}
