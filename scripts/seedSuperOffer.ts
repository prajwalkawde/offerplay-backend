import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log('Seeding Super Offer settings and tiers...');

  // Upsert singleton settings record (id always = 1)
  await prisma.superOfferSettings.upsert({
    where: { id: 1 },
    update: { isActive: true, cooldownHours: 24 },
    create: { id: 1, isActive: true, cooldownHours: 24 },
  });

  // Delete existing tiers so we start clean
  await prisma.superOfferTier.deleteMany({ where: { superOfferSettingsId: 1 } });

  // Recreate tiers from spec
  await prisma.superOfferTier.createMany({
    data: [
      {
        superOfferSettingsId: 1,
        attemptNumber: 1,
        gemsCost: 20,
        coinReward: 100,
        rewardType: 'COINS',
        quizGemReward: 5,
        hasAppInstallStep: false,
        requiredUsageMinutes: 2,
        isDefault: false,
      },
      {
        superOfferSettingsId: 1,
        attemptNumber: 2,
        gemsCost: 18,
        coinReward: 200,
        rewardType: 'COINS',
        quizGemReward: 10,
        hasAppInstallStep: true,
        requiredUsageMinutes: 2,
        isDefault: false,
      },
      {
        // attemptNumber=0 + isDefault=true = used for attempt 3 and beyond
        superOfferSettingsId: 1,
        attemptNumber: 0,
        gemsCost: 15,
        coinReward: 200,
        rewardType: 'COINS',
        quizGemReward: 10,
        hasAppInstallStep: true,
        requiredUsageMinutes: 2,
        isDefault: true,
      },
    ],
  });

  const tiers = await prisma.superOfferTier.findMany({ where: { superOfferSettingsId: 1 } });
  console.log(`✅ Created ${tiers.length} tiers`);
  console.log('✅ Super Offer seeded successfully');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
