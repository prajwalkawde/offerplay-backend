import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function seed() {
  const defaults = [
    { day: 1, coins: 10, label: 'Day 1', icon: '🪙', isSpecial: false },
    { day: 2, coins: 15, label: 'Day 2', icon: '🪙', isSpecial: false },
    { day: 3, coins: 20, label: 'Day 3', icon: '💫', isSpecial: false },
    { day: 4, coins: 25, label: 'Day 4', icon: '⭐', isSpecial: false },
    { day: 5, coins: 30, label: 'Day 5', icon: '🌟', isSpecial: false },
    { day: 6, coins: 35, label: 'Day 6', icon: '✨', isSpecial: false },
    { day: 7, coins: 100, label: 'Day 7 🎉', icon: '👑', isSpecial: true },
  ];

  for (const d of defaults) {
    await prisma.dailyStreakConfig.upsert({
      where: { day: d.day },
      update: d,
      create: d,
    });
  }
  console.log('Streak config seeded!');
  await prisma.$disconnect();
}

seed().catch(console.error);
