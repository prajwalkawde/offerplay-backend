import { Prisma, SupportTicketStatus, SupportTicketType } from '@prisma/client';
import { prisma } from '../config/database';

export interface CreateTicketInput {
  uid: string;
  type: SupportTicketType;
  subject: string;
  message: string;
  contactEmail?: string;
  contactPhone?: string;
}

export interface ListTicketFilters {
  status?: SupportTicketStatus;
  type?: SupportTicketType;
  uid?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface UpdateTicketInput {
  status?: SupportTicketStatus;
  adminNote?: string;
  resolvedBy?: string;
}

// ─── createTicket ─────────────────────────────────────────────────────────────

export async function createTicket(input: CreateTicketInput) {
  // For ACCOUNT_SUSPENDED tickets, snapshot the user's fraud context so admin
  // can review the ban reason without re-querying. Other types: no snapshot.
  let context: Prisma.JsonValue | undefined;
  if (input.type === 'ACCOUNT_SUSPENDED') {
    const trust = await prisma.userTrustScore.findUnique({ where: { uid: input.uid } });
    const user = await prisma.user.findUnique({
      where: { id: input.uid },
      select: { status: true, name: true, phone: true, email: true },
    });
    context = {
      userStatus: user?.status ?? 'unknown',
      trustScore: trust?.trustScore ?? null,
      isBanned: trust?.isBanned ?? false,
      isRestricted: trust?.isRestricted ?? false,
      banReason: trust?.banReason ?? null,
      bannedAt: trust?.bannedAt?.toISOString() ?? null,
      bannedBy: trust?.bannedBy ?? null,
      totalFraudEvents: trust?.totalFraudEvents ?? 0,
      lastFraudEventAt: trust?.lastFraudEventAt?.toISOString() ?? null,
    };
  }

  return prisma.supportTicket.create({
    data: {
      uid: input.uid,
      type: input.type,
      subject: input.subject.trim().slice(0, 200),
      message: input.message.trim().slice(0, 5000),
      contactEmail: input.contactEmail?.trim() || null,
      contactPhone: input.contactPhone?.trim() || null,
      context: context ?? Prisma.JsonNull,
    },
  });
}

// ─── listMyTickets (mobile) ───────────────────────────────────────────────────

export async function listMyTickets(uid: string) {
  return prisma.supportTicket.findMany({
    where: { uid },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      type: true,
      subject: true,
      status: true,
      createdAt: true,
      resolvedAt: true,
    },
  });
}

// ─── adminListTickets ─────────────────────────────────────────────────────────

export async function adminListTickets(filters: ListTicketFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, filters.limit ?? 25);
  const skip = (page - 1) * limit;

  const where: Prisma.SupportTicketWhereInput = {};
  if (filters.status) where.status = filters.status;
  if (filters.type) where.type = filters.type;
  if (filters.uid) where.uid = filters.uid;
  if (filters.search) {
    where.OR = [
      { subject: { contains: filters.search, mode: 'insensitive' } },
      { message: { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.supportTicket.count({ where }),
  ]);

  // Hydrate user info per ticket so the admin table can show name/phone
  const uids = [...new Set(tickets.map(t => t.uid))];
  const users = await prisma.user.findMany({
    where: { id: { in: uids } },
    select: { id: true, name: true, phone: true, email: true, status: true },
  });
  const usersById = new Map(users.map(u => [u.id, u]));

  return {
    tickets: tickets.map(t => ({ ...t, user: usersById.get(t.uid) ?? null })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

// ─── adminGetTicket — full ticket + user details + trust record ──────────────

export async function adminGetTicket(id: number) {
  const ticket = await prisma.supportTicket.findUnique({ where: { id } });
  if (!ticket) return null;

  const [user, trust] = await Promise.all([
    prisma.user.findUnique({
      where: { id: ticket.uid },
      select: {
        id: true, name: true, phone: true, email: true, status: true,
        coinBalance: true, ticketBalance: true, createdAt: true, lastLoginAt: true,
      },
    }),
    prisma.userTrustScore.findUnique({ where: { uid: ticket.uid } }),
  ]);

  return { ticket, user, trust };
}

// ─── adminUpdateTicket ────────────────────────────────────────────────────────

export async function adminUpdateTicket(id: number, input: UpdateTicketInput) {
  const data: Prisma.SupportTicketUpdateInput = {};
  if (input.status) data.status = input.status;
  if (input.adminNote !== undefined) data.adminNote = input.adminNote;
  if (input.status === 'RESOLVED' || input.status === 'CLOSED') {
    data.resolvedAt = new Date();
    if (input.resolvedBy) data.resolvedBy = input.resolvedBy;
  }
  return prisma.supportTicket.update({ where: { id }, data });
}
