import { Request, Response } from 'express';
import { prisma } from '../config/database';

const PLAY_STORE_BASE = 'https://play.google.com/store/apps/details?id=com.offerpay.playgames';
const APP_STORE_BASE  = 'https://apps.apple.com/app/offerplay/id000000000';
const OG_IMAGE_URL    = 'https://offerplay.in/og-referral.png'; // 1200×630 share card

// User-Agent fragments emitted by social-link unfurlers. When one of these
// hits /r/:code we serve HTML with og: meta tags so the link preview in
// WhatsApp / Telegram / Slack etc. shows a rich card instead of the bare URL.
const BOT_UA_FRAGMENTS = [
  'WhatsApp', 'TelegramBot', 'Slackbot', 'facebookexternalhit', 'Twitterbot',
  'LinkedInBot', 'Discordbot', 'Pinterestbot', 'Snapchat', 'SkypeUriPreview',
  'embedly', 'redditbot', 'Applebot', 'Bingbot', 'Googlebot',
];

function isSocialBot(ua: string): boolean {
  if (!ua) return false;
  const lc = ua.toLowerCase();
  return BOT_UA_FRAGMENTS.some(f => lc.includes(f.toLowerCase()));
}

async function getReferrerName(code: string): Promise<string | null> {
  try {
    const user = await prisma.user.findUnique({
      where:  { referralCode: code.toUpperCase() },
      select: { name: true },
    });
    return user?.name ?? null;
  } catch {
    return null;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderOgPage(code: string, referrerName: string | null, signupBonus: number): string {
  const safeCode = escapeHtml(code);
  const safeName = referrerName ? escapeHtml(referrerName) : 'Your friend';
  const title    = `${safeName} invited you to OfferPlay`;
  const desc     = `Sign up with code ${safeCode} — both of you earn ${signupBonus} bonus coins. Complete simple offers and surveys to redeem real money via UPI / gift cards.`;
  const shareUrl = `https://offerplay.in/r/${safeCode}`;
  const playUrl  = `${PLAY_STORE_BASE}&referrer=ref_${safeCode}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<meta name="description" content="${desc}" />
<meta property="og:type"        content="website" />
<meta property="og:site_name"   content="OfferPlay" />
<meta property="og:title"       content="${title}" />
<meta property="og:description" content="${desc}" />
<meta property="og:image"       content="${OG_IMAGE_URL}" />
<meta property="og:image:width"  content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:url"         content="${shareUrl}" />
<meta name="twitter:card"        content="summary_large_image" />
<meta name="twitter:title"       content="${title}" />
<meta name="twitter:description" content="${desc}" />
<meta name="twitter:image"       content="${OG_IMAGE_URL}" />
<meta http-equiv="refresh" content="0; url=${playUrl}" />
<style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
         background: linear-gradient(180deg, #0d0818, #1a0a2e); color: #fff;
         min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; }
  .card { max-width: 420px; }
  h1 { font-size: 22px; color: #FFD700; margin-bottom: 12px; }
  p { font-size: 14px; color: #ffffffcc; line-height: 1.5; margin-bottom: 20px; }
  .bonus { background: #FFD70015; border: 1px solid #FFD70040; border-radius: 12px;
           padding: 16px; margin-bottom: 24px; }
  .code { font-family: monospace; font-size: 18px; color: #FFD700; }
  a.cta { display: inline-block; background: linear-gradient(90deg, #FFD700, #FFA500);
          color: #1a0a2e; font-weight: 700; padding: 14px 28px; border-radius: 14px;
          text-decoration: none; }
</style>
</head>
<body>
<div class="card">
  <h1>${title}</h1>
  <p>Sign up with code <span class="code">${safeCode}</span> — both of you earn <b>${signupBonus} bonus coins</b>.</p>
  <div class="bonus">Complete offers, surveys, and quizzes. Redeem to UPI &amp; gift cards.</div>
  <a class="cta" href="${playUrl}">Install OfferPlay</a>
</div>
<script>
  setTimeout(function () { window.location.replace(${JSON.stringify(playUrl)}); }, 200);
</script>
</body>
</html>`;
}

// GET /r/:code  ─ rich OG preview for social crawlers + smart redirect for users
export const handleReferralRedirect = async (req: Request, res: Response): Promise<void> => {
  try {
    const code = req.params.code as string;
    const ua = (req.headers['user-agent'] || '').toString();
    const isAndroid = /android/i.test(ua);
    const isIOS    = /iphone|ipad/i.test(ua);

    // Track click (fire-and-forget)
    prisma.referralLink.updateMany({
      where: { shortCode: code.toUpperCase() },
      data:  { clicks: { increment: 1 } },
    }).catch(() => {});

    const playStoreUrl = `${PLAY_STORE_BASE}&referrer=ref_${code}`;
    const appStoreUrl  = `${APP_STORE_BASE}?referrer=ref_${code}`;

    // 1. Social bot crawler → serve HTML with OG tags so preview is rich
    if (isSocialBot(ua)) {
      const [referrerName, settings] = await Promise.all([
        getReferrerName(code),
        prisma.referralSettings.findFirst().catch(() => null),
      ]);
      const signupBonus = settings?.signupBonus ?? 100;
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(renderOgPage(code, referrerName, signupBonus));
      return;
    }

    // 2. Android user → app intent (opens app or fallback to Play Store)
    if (isAndroid) {
      res.redirect(
        `intent://offerplay/join?ref=${code}#Intent;` +
        `scheme=offerplay;` +
        `package=com.offerpay.playgames;` +
        `S.browser_fallback_url=${encodeURIComponent(playStoreUrl)};end`,
      );
      return;
    }
    // 3. iOS user → App Store with referrer
    if (isIOS) {
      res.redirect(appStoreUrl);
      return;
    }
    // 4. Desktop/unknown → Play Store
    res.redirect(playStoreUrl);
  } catch {
    res.redirect(PLAY_STORE_BASE);
  }
};

// POST /api/referral/track-install  ─ called from app on first open
export const trackInstall = async (req: Request, res: Response): Promise<void> => {
  try {
    const { referralCode } = req.body as { referralCode?: string };
    if (!referralCode) { res.json({ success: false }); return; }

    prisma.referralLink.updateMany({
      where: { shortCode: referralCode.toUpperCase() },
      data:  { installs: { increment: 1 } },
    }).catch(() => {});

    res.json({ success: true, referralCode });
  } catch {
    res.json({ success: false });
  }
};

// GET /api/referral/link  ─ get or create tracking link for authenticated user
export const getUserReferralLink = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.userId!;

    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: { referralCode: true, name: true },
    });

    let code = user?.referralCode;
    if (!code) {
      code = generateCode(user?.name || 'USER');
      await prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
    }

    let link = await prisma.referralLink.findUnique({ where: { shortCode: code } });
    if (!link) {
      link = await prisma.referralLink.create({ data: { userId, shortCode: code } });
    }

    const shareUrl    = `https://offerplay.in/r/${code}`;
    const playStoreUrl = `https://play.google.com/store/apps/details?id=com.offerpay.playgames&referrer=ref_${code}`;

    res.json({
      success: true,
      data: {
        referralCode: code,
        shareUrl,
        playStoreUrl,
        stats: {
          clicks:      link.clicks,
          installs:    link.installs,
          conversions: link.conversions,
        },
      },
    });
  } catch {
    res.json({ success: false });
  }
};

function generateCode(name: string): string {
  const c = name.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'USER';
  return c + Math.floor(1000 + Math.random() * 9000);
}
