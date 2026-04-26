import { Request, Response } from 'express';
import { SupportTicketStatus, SupportTicketType } from '@prisma/client';
import { prisma } from '../config/database';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import * as supportService from '../services/support.service';
import { writeAudit } from '../services/auditLog.service';

const VALID_STATUS: SupportTicketStatus[] = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
const VALID_TYPE: SupportTicketType[] = [
  'ACCOUNT_SUSPENDED', 'PAYMENT_ISSUE', 'GAMEPLAY_ISSUE', 'REWARD_NOT_RECEIVED', 'OTHER',
];

export async function listTickets(req: Request, res: Response): Promise<void> {
  try {
    const status = (req.query.status as string)?.toUpperCase();
    const type = (req.query.type as string)?.toUpperCase();
    const result = await supportService.adminListTickets({
      status: VALID_STATUS.includes(status as SupportTicketStatus) ? (status as SupportTicketStatus) : undefined,
      type: VALID_TYPE.includes(type as SupportTicketType) ? (type as SupportTicketType) : undefined,
      uid: req.query.uid ? String(req.query.uid) : undefined,
      search: req.query.search ? String(req.query.search) : undefined,
      page: req.query.page ? parseInt(String(req.query.page), 10) : 1,
      limit: req.query.limit ? parseInt(String(req.query.limit), 10) : 25,
    });
    success(res, result);
  } catch (err) {
    logger.error('[AdminSupport] listTickets', err);
    error(res, 'Failed to list tickets', 500);
  }
}

export async function getTicket(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) { error(res, 'Invalid id', 400); return; }
    const result = await supportService.adminGetTicket(id);
    if (!result) { error(res, 'Ticket not found', 404); return; }
    success(res, result);
  } catch (err) {
    logger.error('[AdminSupport] getTicket', err);
    error(res, 'Failed to fetch ticket', 500);
  }
}

export async function updateTicket(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) { error(res, 'Invalid id', 400); return; }
    const { status, adminNote } = req.body as { status?: string; adminNote?: string };
    const adminId = req.adminId ?? 'admin';

    const updated = await supportService.adminUpdateTicket(id, {
      status: status && VALID_STATUS.includes(status.toUpperCase() as SupportTicketStatus)
        ? (status.toUpperCase() as SupportTicketStatus)
        : undefined,
      adminNote,
      resolvedBy: adminId,
    });
    success(res, updated, 'Ticket updated');
  } catch (err) {
    logger.error('[AdminSupport] updateTicket', err);
    error(res, 'Failed to update ticket', 500);
  }
}

// Inline action: from the ticket detail modal, admin can ban/unban the user
// directly. Mirrors the same logic as admin.users.updateUserStatus so the
// fraud middleware respects the change.
export async function ticketUserAction(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) { error(res, 'Invalid id', 400); return; }
    const { action } = req.body as { action?: 'unban' | 'ban' };
    if (action !== 'unban' && action !== 'ban') {
      error(res, "action must be 'unban' or 'ban'", 400);
      return;
    }

    const ticket = await prisma.supportTicket.findUnique({ where: { id }, select: { uid: true } });
    if (!ticket) { error(res, 'Ticket not found', 404); return; }

    const adminId = req.adminId ?? 'admin';

    if (action === 'unban') {
      await Promise.all([
        prisma.user.update({ where: { id: ticket.uid }, data: { status: 'ACTIVE' } }),
        prisma.userTrustScore.updateMany({
          where: { uid: ticket.uid },
          data: {
            isBanned: false, isRestricted: false, trustScore: 100, totalFraudEvents: 0,
            banReason: null, bannedAt: null, bannedBy: null,
          },
        }),
      ]);
      await writeAudit({
        uid: ticket.uid, action: 'SUPPORT_UNBAN', actor: `admin:${adminId}`,
        reason: `Unbanned via support ticket #${id}`,
      });
      success(res, { uid: ticket.uid, action }, 'User unbanned');
    } else {
      await Promise.all([
        prisma.user.update({ where: { id: ticket.uid }, data: { status: 'BANNED' } }),
        prisma.userTrustScore.upsert({
          where: { uid: ticket.uid },
          update: {
            isBanned: true, isRestricted: true,
            banReason: `Manual ban via support ticket #${id}`,
            bannedAt: new Date(), bannedBy: adminId,
          },
          create: {
            uid: ticket.uid, isBanned: true, isRestricted: true,
            banReason: `Manual ban via support ticket #${id}`,
            bannedAt: new Date(), bannedBy: adminId,
          },
        }),
      ]);
      await writeAudit({
        uid: ticket.uid, action: 'SUPPORT_BAN', actor: `admin:${adminId}`,
        reason: `Banned via support ticket #${id}`,
      });
      success(res, { uid: ticket.uid, action }, 'User banned');
    }
  } catch (err) {
    logger.error('[AdminSupport] ticketUserAction', err);
    error(res, 'Failed to apply action', 500);
  }
}

// Aggregate counts for dashboard badges
export async function getCounts(req: Request, res: Response): Promise<void> {
  try {
    const [open, inProgress] = await Promise.all([
      prisma.supportTicket.count({ where: { status: 'OPEN' } }),
      prisma.supportTicket.count({ where: { status: 'IN_PROGRESS' } }),
    ]);
    success(res, { open, inProgress });
  } catch (err) {
    logger.error('[AdminSupport] getCounts', err);
    error(res, 'Failed', 500);
  }
}
