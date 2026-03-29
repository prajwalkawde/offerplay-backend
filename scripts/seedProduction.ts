import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding production database...');

  // ═══ ADMIN USER ═══
  const hash = await bcrypt.hash('Admin@123', 10);
  await prisma.adminUser.upsert({
    where: { email: 'admin@offerplay.com' },
    update: { passwordHash: hash },
    create: {
      email: 'admin@offerplay.com',
      passwordHash: hash,
      name: 'Super Admin',
      role: 'SUPER_ADMIN',
    },
  });
  console.log('✅ Admin user created');

  // ═══ TEST SETTINGS ═══
  const settings = [
    {
      key: 'TEST_MODE_ENABLED',
      label: 'Test Mode Enabled',
      category: 'TESTING',
      isSecret: false,
      value: 'true',
      description: 'Enable OTP bypass for test phones',
    },
    {
      key: 'TEST_PHONE_1',
      label: 'Test Phone 1',
      category: 'TESTING',
      isSecret: false,
      value: '8381071568',
      description: 'Google Play tester phone 1',
    },
    {
      key: 'TEST_OTP_1',
      label: 'Test OTP 1',
      category: 'TESTING',
      isSecret: false,
      value: '652262',
      description: 'OTP bypass for tester 1',
    },
    {
      key: 'TEST_PHONE_2',
      label: 'Test Phone 2',
      category: 'TESTING',
      isSecret: false,
      value: '8432171505',
      description: 'Google Play tester phone 2',
    },
    {
      key: 'TEST_OTP_2',
      label: 'Test OTP 2',
      category: 'TESTING',
      isSecret: false,
      value: '652262',
      description: 'OTP bypass for tester 2',
    },
    {
      key: 'TEST_PHONE_3',
      label: 'Test Phone 3',
      category: 'TESTING',
      isSecret: false,
      value: '',
      description: 'Google Play tester phone 3',
    },
    {
      key: 'TEST_OTP_3',
      label: 'Test OTP 3',
      category: 'TESTING',
      isSecret: false,
      value: '',
      description: 'OTP bypass for tester 3',
    },
  ];

  for (const s of settings) {
    await prisma.appSettings.upsert({
      where: { key: s.key },
      update: { value: s.value },
      create: s,
    });
    console.log('✅ Setting:', s.key);
  }

  // ═══ REFERRAL SETTINGS ═══
  const referralSettings = [
    {
      key: 'REFERRAL_COINS',
      label: 'Referral Reward Coins',
      category: 'GENERAL',
      isSecret: false,
      value: '50',
      description: 'Coins given per referral',
    },
    {
      key: 'SIGNUP_BONUS_COINS',
      label: 'Signup Bonus Coins',
      category: 'GENERAL',
      isSecret: false,
      value: '50',
      description: 'Coins given on signup',
    },
  ];

  for (const s of referralSettings) {
    await prisma.appSettings.upsert({
      where: { key: s.key },
      update: {},
      create: s,
    });
    console.log('✅ Setting:', s.key);
  }

  console.log('🎉 Production seed complete!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
