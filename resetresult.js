const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function reset() {
  const r1 = await prisma.iplContestEntry.updateMany({
    where: { rank: 1, coinsWon: 1000 },
    data: {
      rank: null,
      totalPoints: 0,
      coinsWon: 0,
      status: 'active',
    }
  });

  const r2 = await prisma.iplContest.updateMany({
    where: { status: 'completed' },
    data: { status: 'published' }
  });

  console.log('Reset done! Entries:', r1.count, 'Contests:', r2.count);
  await prisma.$disconnect();
}

reset().catch(console.error);