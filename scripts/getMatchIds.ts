import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  const matches = await prisma.iplMatch.findMany({
    where: { matchNumber: { gte: 25, lte: 30 } },
    select: { id: true, matchNumber: true, team1: true, team2: true, matchDate: true },
    orderBy: { matchNumber: 'asc' },
  });
  console.log(JSON.stringify(matches, null, 2));
  await prisma.$disconnect();
}
run().catch(e => { console.error(e); process.exit(1); });
