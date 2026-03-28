"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Run once to seed TEAM_LOGO_* settings into AppSettings.
 * Usage: npx ts-node src/seedTeamLogos.ts
 */
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
const TEAM_LOGO_SETTINGS = [
    { code: 'MI', name: 'Mumbai Indians' },
    { code: 'CSK', name: 'Chennai Super Kings' },
    { code: 'RCB', name: 'Royal Challengers Bengaluru' },
    { code: 'KKR', name: 'Kolkata Knight Riders' },
    { code: 'SRH', name: 'Sunrisers Hyderabad' },
    { code: 'DC', name: 'Delhi Capitals' },
    { code: 'PBKS', name: 'Punjab Kings' },
    { code: 'RR', name: 'Rajasthan Royals' },
    { code: 'GT', name: 'Gujarat Titans' },
    { code: 'LSG', name: 'Lucknow Super Giants' },
];
async function main() {
    console.log('Seeding team logo settings...');
    for (const team of TEAM_LOGO_SETTINGS) {
        const key = `TEAM_LOGO_${team.code}`;
        await prisma.appSettings.upsert({
            where: { key },
            update: {}, // Don't overwrite if already set
            create: {
                key,
                value: '',
                label: `${team.name} Logo URL`,
                description: `CDN URL for ${team.name} (${team.code}) logo image. Leave blank to use emoji fallback.`,
                category: 'TEAMS',
                isSecret: false,
            },
        });
        console.log(`  ✓ ${key}`);
    }
    console.log('Done.');
}
main()
    .catch(e => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
