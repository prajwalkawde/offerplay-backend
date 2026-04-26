import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// IST helper: returns a Date for a given date + IST time
function ist(date: string, hour: number, minute: number): Date {
  // date format: 'YYYY-MM-DD', time in IST (UTC+5:30)
  return new Date(`${date}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+05:30`);
}

const MATCHES = [
  // ── April 17 ──────────────────────────────────────────────────────────────
  { matchNumber: 25, team1: 'GT',   team2: 'KKR',  matchDate: ist('2026-04-17', 19, 30), venue: 'Narendra Modi Stadium, Ahmedabad' },

  // ── April 18 ──────────────────────────────────────────────────────────────
  { matchNumber: 26, team1: 'RCB',  team2: 'DC',   matchDate: ist('2026-04-18', 15, 30), venue: 'M. Chinnaswamy Stadium, Bengaluru' },
  { matchNumber: 27, team1: 'SRH',  team2: 'CSK',  matchDate: ist('2026-04-18', 19, 30), venue: 'Rajiv Gandhi International Stadium, Hyderabad' },

  // ── April 19 ──────────────────────────────────────────────────────────────
  { matchNumber: 28, team1: 'KKR',  team2: 'RR',   matchDate: ist('2026-04-19', 15, 30), venue: 'Eden Gardens, Kolkata' },
  { matchNumber: 29, team1: 'PBKS', team2: 'LSG',  matchDate: ist('2026-04-19', 19, 30), venue: 'Maharaja Yadavindra Singh International Cricket Stadium, Mullanpur' },

  // ── April 20 ──────────────────────────────────────────────────────────────
  { matchNumber: 30, team1: 'GT',   team2: 'MI',   matchDate: ist('2026-04-20', 19, 30), venue: 'Narendra Modi Stadium, Ahmedabad' },

  // ── April 21 ──────────────────────────────────────────────────────────────
  { matchNumber: 31, team1: 'SRH',  team2: 'DC',   matchDate: ist('2026-04-21', 19, 30), venue: 'Rajiv Gandhi International Stadium, Hyderabad' },

  // ── April 22 ──────────────────────────────────────────────────────────────
  { matchNumber: 32, team1: 'LSG',  team2: 'RR',   matchDate: ist('2026-04-22', 19, 30), venue: 'BRSABV Ekana Cricket Stadium, Lucknow' },

  // ── April 23 ──────────────────────────────────────────────────────────────
  { matchNumber: 33, team1: 'MI',   team2: 'CSK',  matchDate: ist('2026-04-23', 19, 30), venue: 'Wankhede Stadium, Mumbai' },

  // ── April 24 ──────────────────────────────────────────────────────────────
  { matchNumber: 34, team1: 'RCB',  team2: 'GT',   matchDate: ist('2026-04-24', 19, 30), venue: 'M. Chinnaswamy Stadium, Bengaluru' },

  // ── April 25 ──────────────────────────────────────────────────────────────
  { matchNumber: 35, team1: 'DC',   team2: 'PBKS', matchDate: ist('2026-04-25', 15, 30), venue: 'Arun Jaitley Stadium, Delhi' },
  { matchNumber: 36, team1: 'RR',   team2: 'SRH',  matchDate: ist('2026-04-25', 19, 30), venue: 'Sawai Mansingh Stadium, Jaipur' },

  // ── April 26 ──────────────────────────────────────────────────────────────
  { matchNumber: 37, team1: 'CSK',  team2: 'GT',   matchDate: ist('2026-04-26', 15, 30), venue: 'MA Chidambaram Stadium, Chennai' },
  { matchNumber: 38, team1: 'LSG',  team2: 'KKR',  matchDate: ist('2026-04-26', 19, 30), venue: 'BRSABV Ekana Cricket Stadium, Lucknow' },

  // ── April 27 ──────────────────────────────────────────────────────────────
  { matchNumber: 39, team1: 'DC',   team2: 'RCB',  matchDate: ist('2026-04-27', 19, 30), venue: 'Arun Jaitley Stadium, Delhi' },

  // ── April 28 ──────────────────────────────────────────────────────────────
  { matchNumber: 40, team1: 'PBKS', team2: 'RR',   matchDate: ist('2026-04-28', 19, 30), venue: 'New International Cricket Stadium, New Chandigarh' },

  // ── April 29 ──────────────────────────────────────────────────────────────
  { matchNumber: 41, team1: 'MI',   team2: 'SRH',  matchDate: ist('2026-04-29', 19, 30), venue: 'Wankhede Stadium, Mumbai' },

  // ── April 30 ──────────────────────────────────────────────────────────────
  { matchNumber: 42, team1: 'GT',   team2: 'RCB',  matchDate: ist('2026-04-30', 19, 30), venue: 'Narendra Modi Stadium, Ahmedabad' },

  // ── May 1 ─────────────────────────────────────────────────────────────────
  { matchNumber: 43, team1: 'RR',   team2: 'DC',   matchDate: ist('2026-05-01', 19, 30), venue: 'Sawai Mansingh Stadium, Jaipur' },

  // ── May 2 ─────────────────────────────────────────────────────────────────
  { matchNumber: 44, team1: 'CSK',  team2: 'MI',   matchDate: ist('2026-05-02', 19, 30), venue: 'MA Chidambaram Stadium, Chennai' },

  // ── May 3 ─────────────────────────────────────────────────────────────────
  { matchNumber: 45, team1: 'SRH',  team2: 'KKR',  matchDate: ist('2026-05-03', 15, 30), venue: 'Rajiv Gandhi International Stadium, Hyderabad' },
  { matchNumber: 46, team1: 'GT',   team2: 'PBKS', matchDate: ist('2026-05-03', 19, 30), venue: 'Narendra Modi Stadium, Ahmedabad' },

  // ── May 4 ─────────────────────────────────────────────────────────────────
  { matchNumber: 47, team1: 'MI',   team2: 'LSG',  matchDate: ist('2026-05-04', 19, 30), venue: 'Wankhede Stadium, Mumbai' },

  // ── May 5 ─────────────────────────────────────────────────────────────────
  { matchNumber: 48, team1: 'DC',   team2: 'CSK',  matchDate: ist('2026-05-05', 19, 30), venue: 'Arun Jaitley Stadium, Delhi' },

  // ── May 6 ─────────────────────────────────────────────────────────────────
  { matchNumber: 49, team1: 'SRH',  team2: 'PBKS', matchDate: ist('2026-05-06', 19, 30), venue: 'Rajiv Gandhi International Stadium, Hyderabad' },

  // ── May 7 ─────────────────────────────────────────────────────────────────
  { matchNumber: 50, team1: 'LSG',  team2: 'RCB',  matchDate: ist('2026-05-07', 19, 30), venue: 'BRSABV Ekana Cricket Stadium, Lucknow' },

  // ── May 8 ─────────────────────────────────────────────────────────────────
  { matchNumber: 51, team1: 'DC',   team2: 'KKR',  matchDate: ist('2026-05-08', 19, 30), venue: 'Arun Jaitley Stadium, Delhi' },

  // ── May 9 ─────────────────────────────────────────────────────────────────
  { matchNumber: 52, team1: 'RR',   team2: 'GT',   matchDate: ist('2026-05-09', 19, 30), venue: 'Sawai Mansingh Stadium, Jaipur' },

  // ── May 10 ────────────────────────────────────────────────────────────────
  { matchNumber: 53, team1: 'CSK',  team2: 'LSG',  matchDate: ist('2026-05-10', 15, 30), venue: 'MA Chidambaram Stadium, Chennai' },
  { matchNumber: 54, team1: 'RCB',  team2: 'MI',   matchDate: ist('2026-05-10', 19, 30), venue: 'Shaheed Veer Narayan Singh International Cricket Stadium, Raipur' },

  // ── May 11 ────────────────────────────────────────────────────────────────
  { matchNumber: 55, team1: 'PBKS', team2: 'DC',   matchDate: ist('2026-05-11', 19, 30), venue: 'HPCA Stadium, Dharamshala' },

  // ── May 12 ────────────────────────────────────────────────────────────────
  { matchNumber: 56, team1: 'GT',   team2: 'SRH',  matchDate: ist('2026-05-12', 19, 30), venue: 'Narendra Modi Stadium, Ahmedabad' },

  // ── May 13 ────────────────────────────────────────────────────────────────
  { matchNumber: 57, team1: 'RCB',  team2: 'KKR',  matchDate: ist('2026-05-13', 19, 30), venue: 'Shaheed Veer Narayan Singh International Cricket Stadium, Raipur' },

  // ── May 14 ────────────────────────────────────────────────────────────────
  { matchNumber: 58, team1: 'PBKS', team2: 'MI',   matchDate: ist('2026-05-14', 19, 30), venue: 'HPCA Stadium, Dharamshala' },

  // ── May 15 ────────────────────────────────────────────────────────────────
  { matchNumber: 59, team1: 'LSG',  team2: 'CSK',  matchDate: ist('2026-05-15', 19, 30), venue: 'BRSABV Ekana Cricket Stadium, Lucknow' },

  // ── May 16 ────────────────────────────────────────────────────────────────
  { matchNumber: 60, team1: 'KKR',  team2: 'GT',   matchDate: ist('2026-05-16', 19, 30), venue: 'Eden Gardens, Kolkata' },

  // ── May 17 ────────────────────────────────────────────────────────────────
  { matchNumber: 61, team1: 'PBKS', team2: 'RCB',  matchDate: ist('2026-05-17', 15, 30), venue: 'HPCA Stadium, Dharamshala' },
  { matchNumber: 62, team1: 'DC',   team2: 'RR',   matchDate: ist('2026-05-17', 19, 30), venue: 'Arun Jaitley Stadium, Delhi' },

  // ── May 18 ────────────────────────────────────────────────────────────────
  { matchNumber: 63, team1: 'CSK',  team2: 'SRH',  matchDate: ist('2026-05-18', 19, 30), venue: 'MA Chidambaram Stadium, Chennai' },

  // ── May 19 ────────────────────────────────────────────────────────────────
  { matchNumber: 64, team1: 'RR',   team2: 'LSG',  matchDate: ist('2026-05-19', 19, 30), venue: 'Sawai Mansingh Stadium, Jaipur' },

  // ── May 20 ────────────────────────────────────────────────────────────────
  { matchNumber: 65, team1: 'KKR',  team2: 'MI',   matchDate: ist('2026-05-20', 19, 30), venue: 'Eden Gardens, Kolkata' },

  // ── May 21 ────────────────────────────────────────────────────────────────
  { matchNumber: 66, team1: 'GT',   team2: 'CSK',  matchDate: ist('2026-05-21', 19, 30), venue: 'Narendra Modi Stadium, Ahmedabad' },

  // ── May 22 ────────────────────────────────────────────────────────────────
  { matchNumber: 67, team1: 'SRH',  team2: 'RCB',  matchDate: ist('2026-05-22', 19, 30), venue: 'Rajiv Gandhi International Stadium, Hyderabad' },

  // ── May 23 ────────────────────────────────────────────────────────────────
  { matchNumber: 68, team1: 'LSG',  team2: 'PBKS', matchDate: ist('2026-05-23', 19, 30), venue: 'BRSABV Ekana Cricket Stadium, Lucknow' },

  // ── May 24 ────────────────────────────────────────────────────────────────
  { matchNumber: 69, team1: 'MI',   team2: 'RR',   matchDate: ist('2026-05-24', 15, 30), venue: 'Wankhede Stadium, Mumbai' },
  { matchNumber: 70, team1: 'KKR',  team2: 'DC',   matchDate: ist('2026-05-24', 19, 30), venue: 'Eden Gardens, Kolkata' },
];

async function main() {
  console.log('🗑️  Deleting all existing IPL matches and related data...');

  // Delete in FK order
  await prisma.iplPrizeClaim.deleteMany({});
  console.log('  ✅ Deleted all IPL prize claims');

  await prisma.iplPrediction.deleteMany({});
  console.log('  ✅ Deleted all IPL predictions');

  await prisma.iplContestEntry.deleteMany({});
  console.log('  ✅ Deleted all IPL contest entries');

  await prisma.iplQuestion.deleteMany({});
  console.log('  ✅ Deleted all IPL questions');

  await prisma.iplContest.deleteMany({});
  console.log('  ✅ Deleted all IPL contests');

  await prisma.iplMatch.deleteMany({});
  console.log('  ✅ Deleted all IPL matches');

  console.log(`\n📅 Inserting ${MATCHES.length} correct IPL 2026 matches (Match 25–70)...`);

  for (const m of MATCHES) {
    await prisma.iplMatch.create({ data: m });
    console.log(`  ✅ Match ${m.matchNumber}: ${m.team1} vs ${m.team2} — ${m.matchDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}`);
  }

  console.log(`\n🎉 Done! ${MATCHES.length} matches inserted.`);
}

main()
  .catch(e => { console.error('❌ Error:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
