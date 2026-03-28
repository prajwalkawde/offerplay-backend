"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function seedRates() {
    const rates = [
        { countryCode: 'IN', countryName: 'India', currencyCode: 'INR', currencySymbol: '₹', coinsPerUnit: 10 },
        { countryCode: 'US', countryName: 'United States', currencyCode: 'USD', currencySymbol: '$', coinsPerUnit: 1000 },
        { countryCode: 'GB', countryName: 'United Kingdom', currencyCode: 'GBP', currencySymbol: '£', coinsPerUnit: 1200 },
        { countryCode: 'AE', countryName: 'UAE', currencyCode: 'AED', currencySymbol: 'AED', coinsPerUnit: 270 },
        { countryCode: 'SG', countryName: 'Singapore', currencyCode: 'SGD', currencySymbol: 'S$', coinsPerUnit: 740 },
        { countryCode: 'AU', countryName: 'Australia', currencyCode: 'AUD', currencySymbol: 'A$', coinsPerUnit: 650 },
        { countryCode: 'CA', countryName: 'Canada', currencyCode: 'CAD', currencySymbol: 'CA$', coinsPerUnit: 730 },
        { countryCode: 'DE', countryName: 'Germany', currencyCode: 'EUR', currencySymbol: '€', coinsPerUnit: 1080 },
        { countryCode: 'DEFAULT', countryName: 'Default', currencyCode: 'USD', currencySymbol: '$', coinsPerUnit: 1000 },
    ];
    for (const rate of rates) {
        await prisma.coinConversionRate.upsert({
            where: { countryCode: rate.countryCode },
            update: rate,
            create: rate,
        });
        console.log(`Upserted: ${rate.countryName} (${rate.countryCode})`);
    }
    console.log('✅ Rates seeded!');
    await prisma.$disconnect();
}
seedRates().catch(console.error);
