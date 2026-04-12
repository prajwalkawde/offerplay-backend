import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const settings = await prisma.securitySettings.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      enableIpTracking: true,
      ipMonitorThreshold: 2,
      ipSuspiciousThreshold: 4,
      ipFraudFarmThreshold: 8,
      ipScoreDeductSuspicious: 20,
      ipScoreDeductFraudFarm: 60,
      enableVpnDetection: false,
      blockVpnUsers: false,
      vpnScoreDeduct: 30,
      vpnCacheTtlHours: 24,
      enableDeviceFingerprint: true,
      maxAccountsPerDevice: 1,
      deviceScoreDeduct: 80,
      enableRequestSigning: true,
      enablePlayIntegrity: true,
      enableRootDetection: true,
      enableEmulatorDetection: true,
      enableBehaviorAnalysis: true,
      enablePerfectScoreCheck: true,
      enableRapidWithdrawalCheck: true,
      enableUsageSpoofCheck: true,
      minQuizDurationMs: 30000,
      perfectScoreStreakLimit: 5,
      rapidWithdrawalMinutes: 60,
      autobanTrustScore: 20,
      autoRestrictTrustScore: 50,
    },
  });

  console.log('SecuritySettings seeded:', settings.id);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
