import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import { sendFCMToUsers } from '../services/fcmService';
import { placeXoxodayOrder } from '../services/xoxodayService';

const PRIZE_STATUS_MESSAGES: Record<string, { title: string; body: (prizeName: string) => string }> = {
  verified:  { title: '✅ Prize Verified!',    body: (p) => `Your ${p} claim has been verified. We're processing your delivery.` },
  shipped:   { title: '🚚 Prize Shipped!',      body: (p) => `Great news! Your ${p} is on the way. Track your delivery in the app.` },
  delivered: { title: '🎉 Prize Delivered!',    body: (p) => `Your ${p} has been delivered! Open the app to get your details.` },
  rejected:  { title: '❌ Claim Rejected',      body: (p) => `Your ${p} claim was rejected. Open the app for more info.` },
};

// ─── Inventory CRUD (Admin) ────────────────────────────────────────────────────

export async function getInventory(_req: Request, res: Response): Promise<void> {
  try {
    const items = await prisma.prizeInventory.findMany({
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }],
    });
    success(res, items);
  } catch (err) {
    logger.error('getInventory error:', err);
    error(res, 'Failed to get inventory', 500);
  }
}

export async function createInventoryItem(req: Request, res: Response): Promise<void> {
  try {
    const {
      name, description, imageUrl, category,
      marketValue, purchaseLink, provider,
      providerLogo, stock, displayOrder,
    } = req.body as {
      name: string; description?: string; imageUrl?: string; category?: string;
      marketValue: number; purchaseLink?: string; provider?: string;
      providerLogo?: string; stock?: number; displayOrder?: number;
    };

    if (!name || marketValue === undefined) {
      error(res, 'Name and marketValue are required', 400);
      return;
    }

    const item = await prisma.prizeInventory.create({
      data: {
        name,
        description: description || '',
        imageUrl: imageUrl || '',
        category: category || 'gadget',
        marketValue: parseInt(String(marketValue)),
        purchaseLink: purchaseLink || '',
        provider: provider || 'amazon',
        providerLogo: providerLogo || '',
        stock: parseInt(String(stock ?? 1)),
        displayOrder: parseInt(String(displayOrder ?? 0)),
      },
    });

    success(res, item, 'Item added to inventory!', 201);
  } catch (err) {
    logger.error('createInventoryItem error:', err);
    error(res, 'Failed to create item', 500);
  }
}

export async function updateInventoryItem(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    const { entries: _e, ...safeData } = req.body as Record<string, unknown>;

    const item = await prisma.prizeInventory.update({
      where: { id },
      data: safeData,
    });
    success(res, item, 'Item updated!');
  } catch (err) {
    logger.error('updateInventoryItem error:', err);
    error(res, 'Failed to update item', 500);
  }
}

export async function deleteInventoryItem(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    await prisma.prizeInventory.delete({ where: { id } });
    success(res, null, 'Item deleted!');
  } catch (err) {
    logger.error('deleteInventoryItem error:', err);
    error(res, 'Failed to delete item', 500);
  }
}

// ─── Sponsors CRUD (Admin) ────────────────────────────────────────────────────

export async function getSponsors(_req: Request, res: Response): Promise<void> {
  try {
    const sponsors = await prisma.contestSponsor.findMany({
      orderBy: { name: 'asc' },
    });
    success(res, sponsors);
  } catch (err) {
    logger.error('getSponsors error:', err);
    error(res, 'Failed to get sponsors', 500);
  }
}

export async function createSponsor(req: Request, res: Response): Promise<void> {
  try {
    const { name, logoUrl, websiteUrl } = req.body as {
      name: string; logoUrl?: string; websiteUrl?: string;
    };

    if (!name) {
      error(res, 'Sponsor name is required', 400);
      return;
    }

    const sponsor = await prisma.contestSponsor.create({
      data: { name, logoUrl, websiteUrl },
    });
    success(res, sponsor, 'Sponsor added!', 201);
  } catch (err) {
    logger.error('createSponsor error:', err);
    error(res, 'Failed to create sponsor', 500);
  }
}

export async function updateSponsor(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    const sponsor = await prisma.contestSponsor.update({
      where: { id },
      data: req.body as Record<string, unknown>,
    });
    success(res, sponsor, 'Sponsor updated!');
  } catch (err) {
    logger.error('updateSponsor error:', err);
    error(res, 'Failed to update sponsor', 500);
  }
}

// ─── Public endpoints (mobile app) ────────────────────────────────────────────

export async function getPublicInventory(_req: Request, res: Response): Promise<void> {
  try {
    const items = await prisma.prizeInventory.findMany({
      where: { isActive: true, stock: { gt: 0 } },
      orderBy: [{ displayOrder: 'asc' }],
      select: {
        id: true, name: true, description: true,
        imageUrl: true, category: true,
        marketValue: true, provider: true, providerLogo: true,
      },
    });
    success(res, items);
  } catch (err) {
    error(res, 'Failed to get inventory', 500);
  }
}

export async function getPublicSponsors(_req: Request, res: Response): Promise<void> {
  try {
    const sponsors = await prisma.contestSponsor.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
    success(res, sponsors);
  } catch (err) {
    error(res, 'Failed to get sponsors', 500);
  }
}

// ─── IPL Prize Claims admin view ──────────────────────────────────────────────

export async function getIplPrizeClaims(req: Request, res: Response): Promise<void> {
  try {
    const status = (req.query.status as string) || '';
    const where = status ? { status } : {};

    const claims = await prisma.iplPrizeClaim.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, phone: true } },
        contest: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    success(res, { claims, total: claims.length });
  } catch (err) {
    logger.error('getIplPrizeClaims error:', err);
    error(res, 'Failed to get prize claims', 500);
  }
}

export async function updateIplPrizeClaim(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params as { id: string };
    const { status, voucherCode, voucherPin, voucherExpiry, voucherBrand, adminNote } = req.body;

    // Load current claim (need prizeType, deliveryDetails, userId for auto-delivery)
    const existing = await prisma.iplPrizeClaim.findUnique({
      where: { id },
      include: { user: { select: { email: true, name: true } } },
    });
    if (!existing) { error(res, 'Claim not found', 404); return; }

    const dd = (existing.deliveryDetails as Record<string, string>) || {};

    // ── Auto-deliver XOXODAY gift card when admin verifies ───────────────────
    if (status === 'verified' && existing.prizeType === 'XOXODAY') {
      const productId    = dd._xoxodayProductId;
      const denomId      = dd._denominationId;

      if (productId && denomId) {
        const userEmail = dd.email || existing.user?.email || `${existing.userId}@offerplay.in`;
        const orderId   = `IPL_${id.slice(0, 8)}_${Date.now()}`;

        logger.info(`[IPL Prize] Auto-delivering Xoxoday gift card: claim=${id} product=${productId} denom=${denomId} email=${userEmail}`);
        const result = await placeXoxodayOrder(productId, denomId, 1, existing.userId, userEmail, orderId);

        if (result.success) {
          const updatedDd: Record<string, string> = {
            ...dd,
            _xoxodayOrderId:  orderId,
            _autoProcessed:   'true',
            _processedAt:     new Date().toISOString(),
            _voucherCode:     result.voucherCode  || '',
            _voucherPin:      result.voucherPin   || '',
            _voucherLink:     result.voucherLink  || '',
            _voucherExpiry:   result.validity     || '',
            _voucherBrand:    dd._productName     || existing.prizeName || '',
          };

          const delivered = await prisma.iplPrizeClaim.update({
            where: { id },
            data: { status: 'delivered', deliveryDetails: updatedDd },
          });

          // Create a RedemptionRequest so it appears in the user's redeem history
          await prisma.redemptionRequest.create({
            data: {
              userId:        existing.userId,
              type:          'GIFT_CARD',
              status:        'completed',
              coinsRedeemed: 0,
              amountInr:     existing.prizeValue || 0,
              productId,
              productName:   existing.prizeName || 'Gift Card',
              denominationId: denomId,
              voucherCode:   result.voucherCode || '',
              voucherLink:   result.voucherLink || '',
              xoxodayOrderId: orderId,
              processedAt:   new Date(),
              adminNote:     `Auto-issued for IPL prize claim ${id}`,
              customFieldValues: {
                pin:         result.voucherPin  || '',
                validity:    result.validity    || '',
                source:      'ipl_prize',
                iplContestId: existing.iplContestId,
                claimId:     id,
              },
            },
          });

          // FCM — let user know their code is ready
          const prizeName = existing.prizeName || 'gift card';
          const fcmBody   = result.voucherCode
            ? `Your ${prizeName} code is ready! Open the app to copy it.`
            : `Your ${prizeName} is ready! Open the app to access it.`;
          sendFCMToUsers([existing.userId], '🎁 Gift Card Ready!', fcmBody, {
            type:    'prize_delivered',
            claimId: id,
            status:  'delivered',
          }).catch(e => logger.error('Prize auto-deliver FCM error:', e));

          success(res, delivered, `Gift card auto-delivered via Xoxoday! ${result.voucherCode ? `Code: ${result.voucherCode}` : 'Link sent to user.'}`);
          return;
        }

        // Xoxoday call failed — keep status as verified so admin can retry
        logger.error(`[IPL Prize] Xoxoday auto-deliver failed for claim ${id}: ${result.error}`);
        const withError = await prisma.iplPrizeClaim.update({
          where: { id },
          data: {
            status: 'verified',
            deliveryDetails: {
              ...dd,
              _xoxodayError:   result.error || 'Auto-delivery failed',
              _xoxodayErrorAt: new Date().toISOString(),
            },
          },
        });
        success(res, withError, `⚠️ Xoxoday error: ${result.error}. Claim set to verified — click Verify again to retry.`);
        return;
      }

      // productId / denomId missing — fall through to manual update
      logger.warn(`[IPL Prize] XOXODAY claim ${id} missing product or denomination — skipping auto-deliver`);
    }

    // ── Standard manual update (non-XOXODAY or manual voucher entry) ─────────
    const updateData: any = {};
    if (status) updateData.status = status;

    if (voucherCode || voucherPin || voucherExpiry || voucherBrand || adminNote) {
      updateData.deliveryDetails = {
        ...dd,
        ...(voucherCode   && { _voucherCode:   voucherCode }),
        ...(voucherPin    && { _voucherPin:     voucherPin }),
        ...(voucherExpiry && { _voucherExpiry:  voucherExpiry }),
        ...(voucherBrand  && { _voucherBrand:   voucherBrand }),
        ...(adminNote     && { _adminNote:      adminNote }),
      };
      // Auto-set status to delivered when code is manually added
      if (voucherCode && !status) updateData.status = 'delivered';
    }

    const claim = await prisma.iplPrizeClaim.update({ where: { id }, data: updateData });
    success(res, claim, 'Claim updated!');

    // Send push notification to user about status change
    const finalStatus = updateData.status;
    const msg = finalStatus ? PRIZE_STATUS_MESSAGES[finalStatus] : null;
    if (msg) {
      const prizeName = claim.prizeName || 'your prize';
      sendFCMToUsers([claim.userId], msg.title, msg.body(prizeName), {
        type: 'prize_status',
        claimId: id,
        status: finalStatus,
      }).catch(e => logger.error('Prize status FCM error:', e));
    }
  } catch (err) {
    logger.error('updateIplPrizeClaim error:', err);
    error(res, 'Failed to update claim', 500);
  }
}
