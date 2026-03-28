// Run: node scripts/seedAstrocrick.js
// Seeds the AstroCrick partner offer with 3 stages and 9 tasks.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seed() {
  console.log('Seeding AstroCrick offer...');

  // Clean up existing
  await prisma.customOfferTaskCompletion.deleteMany();
  await prisma.customOfferStageCompletion.deleteMany();
  await prisma.customOfferCompletion.deleteMany();
  await prisma.customOfferTask.deleteMany();
  await prisma.customOfferStage.deleteMany();
  await prisma.customOffer.deleteMany();

  const offer = await prisma.customOffer.create({
    data: {
      title:       'AstroCrick - Cricket Prediction App',
      description: 'Complete tasks on AstroCrick and earn massive ticket rewards!',
      partnerName: 'AstroCrick',
      partnerUrl:  'https://astrocrick.com',
      logoUrl:     'https://astrocrick.com/logo.png',
      badgeText:   '🔥 EXCLUSIVE',
      badgeColor:  '#FF6B35',
      isActive:    true,
      isFeatured:  true,
      maxCompletionsPerUser: 1,
      secretKey:   'astrocrick_secret_key_2026',
      stages: {
        create: [
          // ─── Stage 1: Get Started ──────────────────────────────────────────
          {
            stageNumber: 1,
            title:       'Stage 1: Get Started',
            description: 'Visit and join AstroCrick to unlock bigger rewards!',
            iconEmoji:   '🚀',
            unlocksAfterStage: null,
            tasks: {
              create: [
                {
                  taskNumber:   1,
                  title:        'Visit AstroCrick',
                  description:  'Open the AstroCrick website',
                  taskType:     'VISIT',
                  rewardTickets: 2,
                  rewardCoins:  0,
                  verifyMethod: 'REDIRECT',
                  actionLabel:  'Visit Website →',
                  actionUrl:    'https://astrocrick.com?ref=offerplay',
                  taskOrder:    1,
                },
                {
                  taskNumber:   2,
                  title:        'Create Account',
                  description:  'Register on AstroCrick using your details',
                  taskType:     'REGISTER',
                  rewardTickets: 3,
                  rewardCoins:  50,
                  verifyMethod: 'POSTBACK',
                  actionLabel:  'Register Now →',
                  actionUrl:    'https://astrocrick.com/register?ref=offerplay',
                  taskOrder:    2,
                },
                {
                  taskNumber:   3,
                  title:        'Login to AstroCrick',
                  description:  'Sign in to your AstroCrick account',
                  taskType:     'LOGIN',
                  rewardTickets: 2,
                  rewardCoins:  0,
                  verifyMethod: 'POSTBACK',
                  actionLabel:  'Login →',
                  actionUrl:    'https://astrocrick.com/login?ref=offerplay',
                  taskOrder:    3,
                },
              ],
            },
          },
          // ─── Stage 2: Add Coins ────────────────────────────────────────────
          {
            stageNumber: 2,
            title:       'Stage 2: Add Coins',
            description: 'Add coins to AstroCrick and earn tickets + OfferPlay coins!',
            iconEmoji:   '💰',
            unlocksAfterStage: 1,
            tasks: {
              create: [
                {
                  taskNumber:    1,
                  title:         'Add 10 Coins',
                  description:   'Add 10 coins to your AstroCrick wallet',
                  taskType:      'DEPOSIT',
                  requiredAmount: 10,
                  rewardTickets:  9,
                  rewardCoins:   0,
                  verifyMethod:  'POSTBACK',
                  actionLabel:   'Add 10 Coins →',
                  actionUrl:     'https://astrocrick.com/wallet?amount=10&ref=offerplay',
                  taskOrder:     1,
                },
                {
                  taskNumber:    2,
                  title:         'Add 20 Coins',
                  description:   'Add 20 coins to your AstroCrick wallet',
                  taskType:      'DEPOSIT',
                  requiredAmount: 20,
                  rewardTickets:  18,
                  rewardCoins:   50,
                  verifyMethod:  'POSTBACK',
                  actionLabel:   'Add 20 Coins →',
                  actionUrl:     'https://astrocrick.com/wallet?amount=20&ref=offerplay',
                  taskOrder:     2,
                },
                {
                  taskNumber:    3,
                  title:         'Add 50 Coins',
                  description:   'Add 50 coins to your AstroCrick wallet',
                  taskType:      'DEPOSIT',
                  requiredAmount: 50,
                  rewardTickets:  45,
                  rewardCoins:   200,
                  verifyMethod:  'POSTBACK',
                  actionLabel:   'Add 50 Coins →',
                  actionUrl:     'https://astrocrick.com/wallet?amount=50&ref=offerplay',
                  taskOrder:     3,
                },
              ],
            },
          },
          // ─── Stage 3: Big Rewards ──────────────────────────────────────────
          {
            stageNumber: 3,
            title:       'Stage 3: Big Rewards',
            description: 'Unlock massive ticket rewards with bigger deposits!',
            iconEmoji:   '🏆',
            unlocksAfterStage: 2,
            tasks: {
              create: [
                {
                  taskNumber:    1,
                  title:         'Add 100 Coins',
                  description:   'Add 100 coins — Get 90 tickets + 500 coins!',
                  taskType:      'DEPOSIT',
                  requiredAmount: 100,
                  rewardTickets:  90,
                  rewardCoins:   500,
                  verifyMethod:  'POSTBACK',
                  actionLabel:   'Add 100 Coins →',
                  actionUrl:     'https://astrocrick.com/wallet?amount=100&ref=offerplay',
                  taskOrder:     1,
                },
                {
                  taskNumber:    2,
                  title:         'Add 500 Coins',
                  description:   'Add 500 coins — Get 450 tickets + 2500 coins!',
                  taskType:      'DEPOSIT',
                  requiredAmount: 500,
                  rewardTickets:  450,
                  rewardCoins:   2500,
                  verifyMethod:  'POSTBACK',
                  actionLabel:   'Add 500 Coins →',
                  actionUrl:     'https://astrocrick.com/wallet?amount=500&ref=offerplay',
                  taskOrder:     2,
                },
                {
                  taskNumber:    3,
                  title:         'Add 1000 Coins',
                  description:   'Add 1000 coins — Get 900 tickets + 5000 coins!',
                  taskType:      'DEPOSIT',
                  requiredAmount: 1000,
                  rewardTickets:  900,
                  rewardCoins:   5000,
                  verifyMethod:  'POSTBACK',
                  actionLabel:   'Add 1000 Coins →',
                  actionUrl:     'https://astrocrick.com/wallet?amount=1000&ref=offerplay',
                  taskOrder:     3,
                },
              ],
            },
          },
        ],
      },
    },
    include: { stages: { include: { tasks: true } } },
  });

  console.log('\n✅ AstroCrick offer created!');
  console.log(`   ID: ${offer.id}`);
  offer.stages.forEach(s => {
    const tickets = s.tasks.reduce((sum, t) => sum + t.rewardTickets, 0);
    console.log(`   Stage ${s.stageNumber}: ${s.title}  (+${tickets} tickets)`);
    s.tasks.forEach(t => {
      console.log(`      Task ${t.taskNumber}: ${t.title}  +${t.rewardTickets}🎫 +${t.rewardCoins}🪙`);
    });
  });

  const totalTickets = offer.stages.flatMap(s => s.tasks).reduce((sum, t) => sum + t.rewardTickets, 0);
  const totalCoins   = offer.stages.flatMap(s => s.tasks).reduce((sum, t) => sum + t.rewardCoins, 0);
  console.log(`\n   Total: +${totalTickets} tickets, +${totalCoins} coins`);
  console.log('\n   Postback URL template:');
  console.log('   GET /api/custom-offers/postback');
  console.log('     ?user_id=USER_ID');
  console.log(`     &offer_id=${offer.id}`);
  console.log('     &task_id=TASK_ID');
  console.log('     &event_type=DEPOSIT');
  console.log('     &amount=10');
  console.log('     &transaction_id=UNIQUE_TXN_ID');
  console.log('     &signature=MD5(user_id+offer_id+task_id+secretKey)');

  await prisma.$disconnect();
}

seed().catch(e => {
  console.error(e);
  process.exit(1);
});
