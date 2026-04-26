// Immutable audit trail for every consequential security action — auto-bans,
// auto-restricts, admin manual bans/unbans, admin trust score edits, support
// ticket inline actions, daily trust regen.
//
// All writes are best-effort (errors logged but never thrown to the caller)
// — an audit-log outage must not block a real action like an admin unban.

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

export type AuditAction =
  | 'AUTO_BAN'
  | 'AUTO_RESTRICT'
  | 'ADMIN_BAN'
  | 'ADMIN_UNBAN'
  | 'ADMIN_RESTRICT'
  | 'ADMIN_UNRESTRICT'
  | 'ADMIN_TRUST_SET'
  | 'SUPPORT_BAN'
  | 'SUPPORT_UNBAN'
  | 'TRUST_REGEN';

export interface TrustSnapshot {
  isBanned?: boolean;
  isRestricted?: boolean;
  trustScore?: number;
}

export interface WriteAuditInput {
  uid: string;
  action: AuditAction;
  actor: string;          // 'system' | `admin:${adminId}` | `user:${uid}`
  before?: TrustSnapshot | null;
  after?: TrustSnapshot | null;
  reason?: string | null;
}

export async function writeAudit(input: WriteAuditInput): Promise<void> {
  try {
    await prisma.securityAuditLog.create({
      data: {
        uid: input.uid,
        action: input.action,
        actor: input.actor,
        beforeJson: (input.before ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        afterJson: (input.after ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        reason: input.reason ?? undefined,
      },
    });
  } catch (err) {
    // Never throw — audit failures must not block real actions
    logger.warn('[Audit] write failed', { err, action: input.action, uid: input.uid });
  }
}

// ─── Read API for the admin dashboard ────────────────────────────────────────

export interface ListAuditFilters {
  uid?: string;
  action?: AuditAction;
  actor?: string;
  page?: number;
  limit?: number;
}

export async function listAudit(filters: ListAuditFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(200, filters.limit ?? 50);
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};
  if (filters.uid) where.uid = filters.uid;
  if (filters.action) where.action = filters.action;
  if (filters.actor) where.actor = { contains: filters.actor };

  const [rows, total] = await Promise.all([
    prisma.securityAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.securityAuditLog.count({ where }),
  ]);

  return { rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}
