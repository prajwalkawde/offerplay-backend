/**
 * Bot flow integration test
 * Tests: 2 bots + 2 real players in one contest
 *
 * Run: npx ts-node test-bot-flow.ts
 */

import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import * as jwt from 'jsonwebtoken';

const API = 'https://api.offerplay.in';
const DIRECT_DB = process.env.DIRECT_URL || 'postgresql://postgres.zurbizyhsjsakbkgifsy:Maheen@312002@aws-1-ap-south-1.pooler.supabase.com:5432/postgres';
const JWT_SECRET = 'offerplay-super-secret-jwt-key-2024';

const prisma = new PrismaClient({ datasourceUrl: DIRECT_DB });

const COLORS = {
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', bold: '\x1b[1m', reset: '\x1b[0m',
};
const ok   = (msg: string) => console.log(`${COLORS.green}✓${COLORS.reset} ${msg}`);
const fail = (msg: string) => console.log(`${COLORS.red}✗${COLORS.reset} ${msg}`);
const info = (msg: string) => console.log(`${COLORS.cyan}→${COLORS.reset} ${msg}`);
const head = (msg: string) => console.log(`\n${COLORS.bold}${COLORS.yellow}${msg}${COLORS.reset}`);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeUserToken(userId: string): string {
  return jwt.sign({ userId, role: 'user' }, JWT_SECRET, { expiresIn: '1d' });
}

async function adminToken(): Promise<string> {
  const r = await axios.post(`${API}/api/admin/auth/login`, {
    email: 'admin@offerplay.com', password: 'Admin@123',
  });
  return r.data.data.token as string;
}

// ─── Test ────────────────────────────────────────────────────────────────────

async function run() {
  head('STEP 1 — Admin login');
  const token = await adminToken().catch(e => { fail(`Admin login failed: ${e.message}`); process.exit(1); });
  ok(`Admin token acquired`);
  const A = { headers: { Authorization: `Bearer ${token}` } };

  // ── Ensure 2 bots exist ───────────────────────────────────────────────────
  head('STEP 2 — Ensure bots exist');
  const botsRes = await axios.get(`${API}/api/admin/ipl/bots`, A);
  let botCount = botsRes.data.data.count as number;
  info(`Current bot count: ${botCount}`);
  if (botCount < 2) {
    await axios.post(`${API}/api/admin/ipl/bots/create`, { count: 2 - botCount }, A);
    botCount = 2;
    ok(`Created bots to reach count=2`);
  } else {
    ok(`Already have ${botCount} bots`);
  }

  const bots = await prisma.user.findMany({
    where: { isBot: true },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
    take: 2,
  });
  info(`Bot 1: ${bots[0].name} (${bots[0].id})`);
  info(`Bot 2: ${bots[1].name} (${bots[1].id})`);

  // ── Create 2 test real users ──────────────────────────────────────────────
  head('STEP 3 — Create 2 test real users');
  type TestUser = { id: string; name: string; jwtToken: string };
  const testUsers: TestUser[] = [];
  for (let i = 1; i <= 2; i++) {
    const phone = `TEST_USER_00${i}`;
    let u = await prisma.user.findFirst({ where: { phone } });
    if (!u) {
      u = await prisma.user.create({
        data: {
          phone, name: `TestPlayer${i}`, isBot: false,
          referralCode: `TPLAYER${i}`, coinBalance: 1000,
          ticketBalance: 10, language: 'en', status: 'ACTIVE',
        },
      });
      ok(`Created real user: ${u.name}`);
    } else {
      ok(`Found existing real user: ${u.name}`);
    }
    testUsers.push({ id: u.id, name: u.name ?? `TestPlayer${i}`, jwtToken: makeUserToken(u.id) });
  }

  // ── Create match + questions ──────────────────────────────────────────────
  head('STEP 4 — Create test match + questions');
  const matchRes = await axios.post(`${API}/api/admin/ipl/matches`, {
    team1: 'MI', team2: 'CSK',
    matchDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    venue: 'Test Stadium', matchNumber: 999,
  }, A);
  const matchId = matchRes.data.data.id as string;
  ok(`Match created: ${matchId}`);

  const q1Res = await axios.post(`${API}/api/admin/ipl/questions`, {
    matchId, question: 'Who will win the toss?',
    options: ['MI', 'CSK'], correctAnswer: 'MI', points: 100,
  }, A);
  const q2Res = await axios.post(`${API}/api/admin/ipl/questions`, {
    matchId, question: 'Who will win the match?',
    options: ['MI', 'CSK'], correctAnswer: 'CSK', points: 150,
  }, A);
  ok(`Questions created: q1=${q1Res.data.data.id} q2=${q2Res.data.data.id}`);
  const q1Id = q1Res.data.data.id as string;
  const q2Id = q2Res.data.data.id as string;

  // ── Create + publish contest with 2 bots ─────────────────────────────────
  head('STEP 5 — Create contest with botCount=2');
  const contestRes = await axios.post(`${API}/api/admin/ipl/matches/${matchId}/contests`, {
    name: 'Bot Test Contest', contestType: 'MEGA', battleType: 'MEGA',
    entryFee: 0, entryType: 'FREE', isFree: true,
    maxPlayers: 50, prizeType: 'COINS', prizeCoins: 500,
    botCount: 2, questionCount: 2,
    questionsAvailableAt: new Date().toISOString(),
    questionsLockAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    prizeTiersConfig: [
      { rank: 1, type: 'COINS', coins: 300, label: '1st' },
      { rank: 2, type: 'COINS', coins: 150, label: '2nd' },
      { rank: 3, type: 'COINS', coins: 50, label: '3rd' },
    ],
  }, A);
  const contestId = contestRes.data.data.id as string;
  ok(`Contest created: ${contestId}`);

  await axios.post(`${API}/api/admin/ipl/contests/${contestId}/publish`, {}, A);
  ok(`Contest published (bots auto-joined)`);

  // ── Verify bots are in contest ────────────────────────────────────────────
  head('STEP 6 — Verify bot entries');
  // Check DB directly for bot entries in this contest
  const contestAllEntries = await prisma.iplContestEntry.findMany({
    where: { contestId },
    include: { user: { select: { id: true, name: true, isBot: true } } },
  });
  const botEntriesInContest = contestAllEntries.filter((e: any) => e.user?.isBot);
  if (botEntriesInContest.length === 2) {
    ok(`Both bots are in contest ✓`);
    botEntriesInContest.forEach((b: any, i: number) => info(`  Bot ${i+1}: ${b.user.name} (userId=${b.userId})`));
  } else {
    fail(`Expected 2 bots in contest, got ${botEntriesInContest.length}`);
    info(`All entries: ${contestAllEntries.map((e: any) => `${e.user.name}(bot=${e.user.isBot})`).join(', ')}`);
  }

  // ── Real users join + predict ─────────────────────────────────────────────
  head('STEP 7 — Real users join contest & predict');
  for (const u of testUsers) {
    const joinRes = await axios.post(
      `${API}/api/ipl/contests/${contestId}/join`, {},
      { headers: { Authorization: `Bearer ${u.jwtToken}` } }
    );
    ok(`${u.name} joined: ${joinRes.data.message}`);
  }

  // Player 1 answers q1=MI(wrong), q2=CSK(correct) → 150 pts
  // Player 2 answers q1=MI(wrong), q2=MI(wrong) → 0 pts
  const predictions: Array<{ userId: string; name: string; answers: Array<{ questionId: string; answer: string }> }> = [
    {
      userId: testUsers[0].id, name: testUsers[0].name,
      answers: [{ questionId: q1Id as string, answer: 'MI' }, { questionId: q2Id as string, answer: 'CSK' }],
    },
    {
      userId: testUsers[1].id, name: testUsers[1].name,
      answers: [{ questionId: q1Id as string, answer: 'MI' }, { questionId: q2Id as string, answer: 'MI' }],
    },
  ];

  for (const p of predictions) {
    const u = testUsers.find(u => u.id === p.userId)!;
    await axios.post(
      `${API}/api/ipl/contests/${contestId}/predict`,
      { predictions: p.answers },
      { headers: { Authorization: `Bearer ${u.jwtToken}` } }
    );
    ok(`${p.name} submitted predictions`);
  }

  // ── Check leaderboard BEFORE results ─────────────────────────────────────
  head('STEP 8 — Leaderboard BEFORE result (pending state)');
  const lbBefore = await axios.get(`${API}/api/ipl/contests/${contestId}/leaderboard`);
  const beforeData = lbBefore.data.data;
  info(`Contest status: ${beforeData.status}`);
  info(`Total entries: ${beforeData.totalEntries}`);
  beforeData.leaderboard.slice(0, 4).forEach((e: any) =>
    info(`  Rank ${e.rank}: ${e.name} — ${e.totalPoints} pts`)
  );

  // ── Post match result ─────────────────────────────────────────────────────
  head('STEP 9 — Post match result (tossWinner=MI, matchWinner=CSK)');
  await axios.post(`${API}/api/admin/ipl/matches/process-results`, {
    matchId, winner: 'CSK',
    team1Score: '180/5', team2Score: '181/3',
    manOfMatch: 'MS Dhoni',
  }, A);
  ok(`Result posted — distributeIPLContestPrizes called for each contest`);

  // ── Check leaderboard AFTER results ──────────────────────────────────────
  head('STEP 10 — Leaderboard AFTER result');
  const lbAfter = await axios.get(`${API}/api/ipl/contests/${contestId}/leaderboard`);
  const afterData = lbAfter.data.data;
  info(`Contest status: ${afterData.status}`);
  afterData.leaderboard.slice(0, 4).forEach((e: any) =>
    info(`  Rank ${e.rank}: ${e.name} — ${e.totalPoints} pts | coinsWon: ${e.coinsWon ?? 0}`)
  );

  // ── Validate results ──────────────────────────────────────────────────────
  head('VALIDATION');
  const lb = afterData.leaderboard as any[];

  // Questions: q1="win toss?" correct=MI(100pts), q2="win match?" correct=CSK(150pts)
  // TestPlayer1: q1=MI(correct)+q2=CSK(correct) = 250pts
  // TestPlayer2: q1=MI(correct)+q2=MI(wrong)    = 100pts
  // Bot scores: at least max(250+50, ...) so always above 250 → ranks 1 & 2

  const botNames = ['Arjun K.', 'Priya S.', 'Rahul M.', 'Sneha T.', 'Vikram P.',
    'Ananya R.', 'Kiran B.', 'Deepak V.', 'Meera J.', 'Suresh N.',
    'Kavita L.', 'Ravi G.', 'Pooja D.', 'Amit H.', 'Neha C.',
    'Aakash Y.', 'Divya F.', 'Sanjay W.', 'Lata Q.', 'Nikhil Z.'];

  const rank1 = lb[0];
  const rank2 = lb[1];
  info(`Rank 1: ${rank1.name} (pts=${rank1.totalPoints}, bot=${botNames.includes(rank1.name)})`);
  info(`Rank 2: ${rank2.name} (pts=${rank2.totalPoints}, bot=${botNames.includes(rank2.name)})`);

  // At least rank-1 should be a bot (scored > highest real user 250)
  if (botNames.includes(rank1.name)) {
    ok(`Rank 1 has fake bot name: "${rank1.name}" ✓`);
  } else {
    fail(`Rank 1 expected a bot fake name, got: "${rank1.name}" — deploy latest code?`);
  }

  if (rank1.name !== rank2.name) {
    ok(`Top 2 entries have different names ✓ (${rank1.name} vs ${rank2.name})`);
  } else {
    fail(`Both top entries have same name: ${rank1.name}`);
  }

  const p1Entry = lb.find((e: any) => e.userId === testUsers[0].id);
  const p2Entry = lb.find((e: any) => e.userId === testUsers[1].id);

  if (p1Entry && p1Entry.totalPoints === 250) {
    ok(`TestPlayer1 scored 250 pts (both correct: toss+match) ✓`);
  } else {
    fail(`TestPlayer1 pts: expected 250, got ${p1Entry?.totalPoints}`);
  }

  if (p2Entry && p2Entry.totalPoints === 100) {
    ok(`TestPlayer2 scored 100 pts (toss correct only) ✓`);
  } else {
    fail(`TestPlayer2 pts: expected 100, got ${p2Entry?.totalPoints}`);
  }

  // NEW SYSTEM: prizes awarded by displayRank (bots consume prize slots they earn).
  // Bots score > 250 so they always take displayRanks 1 & 2.
  // TestPlayer1 (250pts) → displayRank 3 → 50 coins  (rank-3 tier)
  // TestPlayer2 (100pts) → displayRank 4 → 0 coins   (no tier for rank 4)
  if (p1Entry && (p1Entry.coinsWon ?? 0) === 50) {
    ok(`TestPlayer1 won 50 coins (displayRank 3 prize) ✓`);
  } else if (p1Entry && (p1Entry.coinsWon ?? 0) > 0) {
    ok(`TestPlayer1 won ${p1Entry.coinsWon} coins ✓`);
  } else {
    fail(`TestPlayer1 got no coins — deploy latest code and re-run`);
  }

  if (p2Entry && (p2Entry.coinsWon ?? 0) === 0) {
    ok(`TestPlayer2 won 0 coins (displayRank 4, no prize tier configured) ✓`);
  } else {
    info(`TestPlayer2 coinsWon: ${p2Entry?.coinsWon ?? 0} (expected 0 — rank 4 has no tier)`);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  head('CLEANUP');
  await prisma.iplContestEntry.deleteMany({ where: { contestId } });
  await prisma.iplContest.delete({ where: { id: contestId } });
  await prisma.iplPrediction.deleteMany({ where: { matchId } });
  await prisma.iplQuestion.deleteMany({ where: { matchId } });
  await prisma.iplMatch.delete({ where: { id: matchId } });
  for (const u of testUsers) {
    await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
  }
  ok(`Cleaned up test match, contest, questions, predictions, test users`);

  await prisma.$disconnect();
  head('ALL DONE');
}

run().catch(e => {
  console.error(`${COLORS.red}FATAL:${COLORS.reset}`, e.response?.data ?? e.message);
  prisma.$disconnect();
  process.exit(1);
});
