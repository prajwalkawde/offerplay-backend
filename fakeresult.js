const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fakeResult() {
  // Find your user - change phone number
  const user = await prisma.user.findFirst({
    where: { phone: { contains: '1568' } },
    select: { id: true, name: true, coinBalance: true }
  });
  
  if (!user) {
    console.log('User not found! Change the phone number in script');
    await prisma.$disconnect();
    return;
  }
  console.log('User found:', user.name, '| Coins:', user.coinBalance);

  // Find your contest entry
  const entry = await prisma.iplContestEntry.findFirst({
    where: { userId: user.id },
    include: { contest: true }
  });

  if (!entry) {
    console.log('No contest entry found! Join a contest first.');
    await prisma.$disconnect();
    return;
  }
  console.log('Contest:', entry.contest.name);

  // Make you rank 1 winner
  await prisma.iplContestEntry.update({
    where: { id: entry.id },
    data: {
      rank: 1,
      totalPoints: 850,
      coinsWon: 1000,
      status: 'won',
    }
  });

  // Mark contest completed
  await prisma.iplContest.update({
    where: { id: entry.contestId },
    data: { status: 'completed' }
  });

  // Credit coins
  await prisma.user.update({
    where: { id: user.id },
    data: { coinBalance: { increment: 1000 } }
  });

  console.log('SUCCESS! You are Rank 1 winner!');
  console.log('1000 coins credited to wallet!');
  await prisma.$disconnect();
}

fakeResult().catch(console.error);