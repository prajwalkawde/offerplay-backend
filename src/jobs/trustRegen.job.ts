import cron from 'node-cron';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { writeAudit } from '../services/auditLog.service';

const REGEN_AMOUNT = 1;       // +1 trust per day
const QUIET_DAYS_REQUIRED = 7; // No fraud events in last N days
const MAX_TRUST = 100;

/**
 * Daily trust score regeneration. Without this, a user who tripped a single
 * signal (correctly or as a false positive) stays at low trust forever even
 * after months of clean behavior. With it, users recover at +1/day after a
 * 7-day quiet window.
 *
 * Approach: bulk update with a SQL filter so we only touch rows that need it.
 *   - trustScore < 100 (room to grow)
 *   - lastFraudEventAt is NULL OR older than QUIET_DAYS_REQUIRED days
 *   - NOT isBanned (banned users must be unbanned by admin first; trust regen
 *     for banned users would silently restore their reward access)
 */
export async function runTrustRegen(): Promise<{ updated: number }> {
  const cutoff = new Date(Date.now() - QUIET_DAYS_REQUIRED * 24 * 60 * 60 * 1000);

  // updateMany with raw min() isn't supported in Prisma — but since REGEN_AMOUNT
  // is small (1) and MAX_TRUST is small (100), an increment-with-filter is fine
  // and the next run will skip anyone already at MAX_TRUST.
  const result = await prisma.userTrustScore.updateMany({
    where: {
      isBanned: false,
      trustScore: { lt: MAX_TRUST },
      OR: [
        { lastFraudEventAt: null },
        { lastFraudEventAt: { lt: cutoff } },
      ],
    },
    data: { trustScore: { increment: REGEN_AMOUNT } },
  });

  // Cap any rows that overshot 100 (race condition in the rare case where a
  // row is at 100 and gets a concurrent update). Cheap to run.
  await prisma.userTrustScore.updateMany({
    where: { trustScore: { gt: MAX_TRUST } },
    data: { trustScore: MAX_TRUST },
  });

  return { updated: result.count };
}

export function startTrustRegenJob(): void {
  // 04:00 UTC daily — quiet hour after most other jobs
  cron.schedule('0 4 * * *', async () => {
    try {
      const { updated } = await runTrustRegen();
      logger.info('[TrustRegen] daily run complete', { updated });
      // Single aggregate audit entry per run (uid='_system' since it's bulk)
      await writeAudit({
        uid: '_system',
        action: 'TRUST_REGEN',
        actor: 'system',
        reason: `Bulk regen: +1 trust applied to ${updated} users with no fraud events in last 7d`,
      });
    } catch (err) {
      logger.error('[TrustRegen] daily run failed', { err });
    }
  });

  logger.info('[TrustRegen] scheduled daily at 04:00 UTC');
}
