import { PrismaClient, ContestType, ContestStatus, PrizeType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { generateReferralCode } from './utils/crypto';

const prisma = new PrismaClient();

// IPL 2026 Teams
const TEAMS = ['MI', 'CSK', 'RCB', 'KKR', 'DC', 'PBKS', 'RR', 'SRH', 'LSG', 'GT'];

function ipl2026Matches(): Array<{
  matchNumber: number; team1: string; team2: string; matchDate: Date; venue: string;
}> {
  const venues: Record<string, string> = {
    MI: 'Wankhede Stadium, Mumbai',
    CSK: 'M. A. Chidambaram Stadium, Chennai',
    RCB: 'M. Chinnaswamy Stadium, Bengaluru',
    KKR: 'Eden Gardens, Kolkata',
    DC: 'Arun Jaitley Stadium, Delhi',
    PBKS: 'Punjab Cricket Association Stadium, Mohali',
    RR: 'Sawai Mansingh Stadium, Jaipur',
    SRH: 'Rajiv Gandhi International Stadium, Hyderabad',
    LSG: 'BRSABV Ekana Cricket Stadium, Lucknow',
    GT: 'Narendra Modi Stadium, Ahmedabad',
  };

  const fixtures: Array<[string, string]> = [
    ['MI','CSK'],['RCB','KKR'],['DC','PBKS'],['RR','SRH'],['LSG','GT'],
    ['CSK','RCB'],['KKR','MI'],['PBKS','RR'],['SRH','LSG'],['GT','DC'],
    ['MI','RCB'],['CSK','KKR'],['RR','DC'],['PBKS','GT'],['LSG','SRH'],
    ['KKR','RR'],['RCB','DC'],['MI','PBKS'],['CSK','LSG'],['GT','SRH'],
    ['DC','KKR'],['RR','MI'],['SRH','CSK'],['PBKS','RCB'],['GT','LSG'],
    ['MI','GT'],['RCB','RR'],['KKR','DC'],['LSG','PBKS'],['CSK','SRH'],
    ['RR','GT'],['DC','MI'],['PBKS','KKR'],['SRH','RCB'],['LSG','CSK'],
    ['GT','KKR'],['MI','SRH'],['RCB','LSG'],['CSK','PBKS'],['DC','RR'],
    ['KKR','LSG'],['SRH','GT'],['RR','CSK'],['PBKS','MI'],['RCB','DC'],
    ['LSG','RR'],['GT','RCB'],['MI','CSK'],['KKR','SRH'],['DC','PBKS'],
    ['CSK','GT'],['RR','KKR'],['SRH','DC'],['PBKS','LSG'],['RCB','MI'],
    ['GT','PBKS'],['MI','RR'],['KKR','CSK'],['DC','LSG'],['SRH','RCB'],
    ['LSG','MI'],['PBKS','SRH'],['RCB','CSK'],['KKR','GT'],['RR','DC'],
    ['MI','KKR'],['CSK','DC'],['GT','RR'],['SRH','PBKS'],['LSG','RCB'],
    // Playoffs
    ['TBD1','TBD2'],['TBD3','TBD4'],['TBD5','TBD6'],['TBD7','TBD8'],
  ];

  const startDate = new Date('2026-03-22T19:30:00+05:30');
  return fixtures.map((f, i) => {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + Math.floor(i * 1.2));
    if (i % 2 === 1) d.setHours(15, 30, 0, 0);

    return {
      matchNumber: i + 1,
      team1: f[0],
      team2: f[1],
      matchDate: d,
      venue: venues[f[0]] ?? 'TBD',
    };
  });
}

async function main(): Promise<void> {
  console.log('🌱 Seeding database...');

  // ─── Admin User ─────────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash('Admin@123', 12);
  await prisma.adminUser.upsert({
    where: { email: 'admin@offerplay.com' },
    update: {},
    create: { name: 'Super Admin', email: 'admin@offerplay.com', passwordHash, role: 'superadmin' },
  });
  console.log('✅ Admin user created: admin@offerplay.com / Admin@123');

  // ─── Games ───────────────────────────────────────────────────────────────────
  const games = await Promise.all([
    prisma.game.upsert({
      where: { id: 'game-quiz-001' },
      update: {},
      create: { id: 'game-quiz-001', name: 'Cricket Quiz', description: 'Test your cricket knowledge', category: 'quiz', icon: 'https://cdn.offerplay.in/icons/quiz.png' },
    }),
    prisma.game.upsert({
      where: { id: 'game-ludo-001' },
      update: {},
      create: { id: 'game-ludo-001', name: 'Ludo Star', description: 'Classic Ludo board game', category: 'board', icon: 'https://cdn.offerplay.in/icons/ludo.png' },
    }),
    prisma.game.upsert({
      where: { id: 'game-carrom-001' },
      update: {},
      create: { id: 'game-carrom-001', name: 'Carrom Board', description: 'Multiplayer Carrom', category: 'board', icon: 'https://cdn.offerplay.in/icons/carrom.png' },
    }),
    prisma.game.upsert({
      where: { id: 'game-memory-001' },
      update: {},
      create: { id: 'game-memory-001', name: 'Memory Match', description: 'Flip cards, find pairs', category: 'puzzle', icon: 'https://cdn.offerplay.in/icons/memory.png' },
    }),
    prisma.game.upsert({
      where: { id: 'game-snake-001' },
      update: {},
      create: { id: 'game-snake-001', name: 'Snake & Ladder', description: 'Classic S&L', category: 'board', icon: 'https://cdn.offerplay.in/icons/snakeladder.png' },
    }),
  ]);
  console.log(`✅ ${games.length} games seeded`);

  // ─── Contests ────────────────────────────────────────────────────────────────
  const now = new Date();
  const regStart = new Date(now.getTime() - 5 * 60 * 1000);
  const regEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const gameStart = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const gameEnd = new Date(now.getTime() + 3 * 60 * 60 * 1000);

  await Promise.all([
    prisma.contest.upsert({
      where: { id: 'contest-quiz-001' },
      update: {},
      create: {
        id: 'contest-quiz-001',
        gameId: 'game-quiz-001',
        name: 'Cricket Quiz Mega Contest',
        type: ContestType.MEGA,
        entryFee: 100,
        maxPlayers: 1000,
        minPlayers: 10,
        regStartTime: regStart,
        regEndTime: regEnd,
        gameStartTime: gameStart,
        gameEndTime: gameEnd,
        prizeType: PrizeType.COINS,
        totalPrizePool: 50000,
        prizeDistribution: { '1': 20000, '2': 10000, '3': 5000, '4': 3000, '5': 2000 },
        status: ContestStatus.REGISTRATION_OPEN,
      },
    }),
    prisma.contest.upsert({
      where: { id: 'contest-ludo-001' },
      update: {},
      create: {
        id: 'contest-ludo-001',
        gameId: 'game-ludo-001',
        name: 'Ludo 1v1 Challenge',
        type: ContestType.ONE_V_ONE,
        entryFee: 50,
        maxPlayers: 2,
        minPlayers: 2,
        regStartTime: regStart,
        regEndTime: regEnd,
        gameStartTime: gameStart,
        gameEndTime: gameEnd,
        prizeType: PrizeType.COINS,
        totalPrizePool: 90,
        prizeDistribution: { '1': 90 },
        status: ContestStatus.REGISTRATION_OPEN,
      },
    }),
    prisma.contest.upsert({
      where: { id: 'contest-memory-001' },
      update: {},
      create: {
        id: 'contest-memory-001',
        gameId: 'game-memory-001',
        name: 'Memory Master Weekend',
        type: ContestType.MEGA,
        entryFee: 0,
        maxPlayers: 500,
        minPlayers: 5,
        regStartTime: regStart,
        regEndTime: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        gameStartTime: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        gameEndTime: new Date(now.getTime() + 26 * 60 * 60 * 1000),
        prizeType: PrizeType.COINS,
        totalPrizePool: 5000,
        prizeDistribution: { '1': 2000, '2': 1500, '3': 1000, '4': 300, '5': 200 },
        status: ContestStatus.REGISTRATION_OPEN,
      },
    }),
  ]);
  console.log('✅ 3 contests seeded');

  // ─── IPL 2026 Matches ────────────────────────────────────────────────────────
  const matches = ipl2026Matches();
  let matchCount = 0;

  for (const m of matches) {
    const existing = await prisma.iplMatch.findFirst({ where: { matchNumber: m.matchNumber } });
    if (!existing) {
      await prisma.iplMatch.create({ data: m });
      matchCount++;
    }
  }
  console.log(`✅ ${matchCount} IPL 2026 matches seeded (${matches.length} total)`);

  // ─── Sample Questions for first 5 matches ────────────────────────────────────
  const first5 = await prisma.iplMatch.findMany({
    where: { matchNumber: { lte: 5 } },
    orderBy: { matchNumber: 'asc' },
  });

  const questionTemplates = [
    {
      question: 'Who will win the toss?',
      optionsFn: (m: { team1: string; team2: string }) => [m.team1, m.team2],
      points: 50,
    },
    {
      question: 'Who will win the match?',
      optionsFn: (m: { team1: string; team2: string }) => [m.team1, m.team2, 'No Result'],
      points: 100,
    },
    {
      question: 'Will there be a century in this match?',
      optionsFn: () => ['Yes', 'No'],
      points: 75,
    },
    {
      question: 'Total sixes in the match',
      optionsFn: () => ['0-5', '6-10', '11-15', '16+'],
      points: 60,
    },
    {
      question: 'First wicket to fall — over number',
      optionsFn: () => ['1-3', '4-6', '7-10', '11+', 'No wicket'],
      points: 80,
    },
  ];

  for (const match of first5) {
    for (const tmpl of questionTemplates) {
      const exists = await prisma.iplQuestion.findFirst({ where: { matchId: match.id, question: tmpl.question } });
      if (!exists) {
        await prisma.iplQuestion.create({
          data: {
            matchId: match.id,
            question: tmpl.question,
            options: tmpl.optionsFn(match),
            points: tmpl.points,
          },
        });
      }
    }
  }
  console.log('✅ IPL questions seeded for first 5 matches');

  console.log('\n🎉 Database seeding complete!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
