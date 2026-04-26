import { Request, Response } from 'express';
import { SupportTicketType } from '@prisma/client';
import { success, error } from '../utils/response';
import { logger } from '../utils/logger';
import * as supportService from '../services/support.service';

const VALID_TYPES: SupportTicketType[] = [
  'ACCOUNT_SUSPENDED',
  'PAYMENT_ISSUE',
  'GAMEPLAY_ISSUE',
  'REWARD_NOT_RECEIVED',
  'OTHER',
];

export async function createTicket(req: Request, res: Response): Promise<void> {
  try {
    const { type, subject, message, contactEmail, contactPhone } = req.body as {
      type?: string;
      subject?: string;
      message?: string;
      contactEmail?: string;
      contactPhone?: string;
    };

    if (!subject || !message) {
      error(res, 'subject and message are required', 400);
      return;
    }
    if (subject.trim().length < 3 || message.trim().length < 10) {
      error(res, 'Please provide a meaningful subject (3+ chars) and message (10+ chars)', 400);
      return;
    }

    const ticketType: SupportTicketType =
      type && VALID_TYPES.includes(type as SupportTicketType)
        ? (type as SupportTicketType)
        : 'OTHER';

    const ticket = await supportService.createTicket({
      uid: req.userId!,
      type: ticketType,
      subject,
      message,
      contactEmail,
      contactPhone,
    });

    success(res, { ticket_id: ticket.id, status: ticket.status }, 'Support ticket created');
  } catch (err) {
    logger.error('createTicket error', { err, uid: req.userId });
    error(res, 'Failed to create support ticket', 500);
  }
}

export async function listMyTickets(req: Request, res: Response): Promise<void> {
  try {
    const tickets = await supportService.listMyTickets(req.userId!);
    success(res, { tickets });
  } catch (err) {
    logger.error('listMyTickets error', { err, uid: req.userId });
    error(res, 'Failed to fetch tickets', 500);
  }
}
