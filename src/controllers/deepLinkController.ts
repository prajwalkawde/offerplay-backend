import { Request, Response } from 'express';
import { prisma } from '../config/database';

// GET /r/:code  ─ landing page redirect with click tracking
export const handleReferralRedirect = async (req: Request, res: Response): Promise<void> => {
  try {
    const code = req.params.code as string;
    const ua = req.headers['user-agent'] || '';
    const isAndroid = /android/i.test(ua);
    const isIOS    = /iphone|ipad/i.test(ua);

    // Track click (fire-and-forget)
    prisma.referralLink.updateMany({
      where: { shortCode: code.toUpperCase() },
      data:  { clicks: { increment: 1 } },
    }).catch(() => {});

    const playStoreUrl = 'https://play.google.com/store/apps/details?id=com.offerplay.app';
    const appStoreUrl  = 'https://apps.apple.com/app/offerplay/id000000000';
    const landingUrl   = `https://offerplay.in/join?ref=${code}&from=share`;

    if (isAndroid) {
      res.redirect(
        `intent://offerplay/join?ref=${code}#Intent;` +
        `scheme=offerplay;` +
        `package=com.offerplay.app;` +
        `S.browser_fallback_url=${encodeURIComponent(playStoreUrl + `&referrer=ref_${code}`)};end`,
      );
      return;
    }
    if (isIOS) {
      res.redirect(`${appStoreUrl}?referrer=ref_${code}`);
      return;
    }
    res.redirect(landingUrl);
  } catch {
    res.redirect('https://offerplay.in');
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
    const playStoreUrl = `https://play.google.com/store/apps/details?id=com.offerplay.app&referrer=ref_${code}`;

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
