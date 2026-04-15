import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TERMS_CONTENT = `# Terms of Service

## 1. Eligibility
You must be at least 18 years old to use OfferPlay. By using this app you confirm that you meet this age requirement and are legally permitted to participate in reward-based activities in your jurisdiction.

## 2. Account Rules
- One account per person — multiple accounts are strictly prohibited.
- You are responsible for maintaining the security of your account credentials.
- Sharing, buying, or selling accounts is not permitted.
- We reserve the right to suspend or permanently ban accounts that violate these terms.

## 3. Coins & Rewards
- Coins are virtual reward points earned by completing tasks, surveys, watching ads, referring friends, and participating in quiz contests.
- Coins have no monetary value and cannot be transferred between accounts.
- Coins expire 12 months from the date they were earned.
- Fraudulent or invalid completions will result in coin reversal and account termination.

## 4. Quiz Contests
- All quiz contests on OfferPlay are FREE to enter — no entry fee required.
- Contests are skill-based; results are determined by correct answers and response speed.
- OfferPlay reserves the right to cancel or modify any contest at any time.
- In the event of a cancellation, no coins are deducted as all contests are free.

## 5. Redemption
- Minimum redemption is 1000 coins.
- Coins can be redeemed for gift cards, vouchers, and other rewards as shown in the Redeem tab.
- Redemptions are processed within 24–48 hours, subject to verification.
- OfferPlay reserves the right to verify any redemption request and withhold rewards for suspected fraud.
- Redeemed coins cannot be reversed once processed.

## 6. Prohibited Activities
- Use of VPNs, proxies, or emulators to fake locations or device data.
- Multiple account creation or use of bots/scripts to automate tasks.
- Fraudulent survey or offer completions.
- Any activity that manipulates coins, rankings, or contest outcomes.
- Violation of any applicable law or regulation.

Violations will result in immediate permanent ban and forfeiture of all coins.

## 7. Intellectual Property
All content, logos, and branding in OfferPlay are the property of OfferPlay and may not be reproduced without written permission.

## 8. Limitation of Liability
OfferPlay is not liable for any indirect, incidental, or consequential damages arising from use of the app. We do not guarantee uninterrupted access or specific reward availability.

## 9. Changes to Terms
We may update these terms at any time. Continued use of the app after changes constitutes acceptance of the updated terms. Significant changes will be communicated via in-app notification.

## 10. Contact
For support or legal inquiries:
support@offerplay.in`;

const PRIVACY_CONTENT = `# Privacy Policy

OfferPlay is committed to protecting your privacy. This policy explains what data we collect, how we use it, and your rights.

## 1. Information We Collect
- **Account data:** Phone number, email address, and name provided during registration.
- **Device data:** Device model, OS version, unique device identifiers, and IP address.
- **Usage data:** Tasks completed, surveys taken, contests joined, coins earned and redeemed.
- **Referral data:** Referral codes used and friends invited.

## 2. How We Use Your Information
- To create and manage your OfferPlay account.
- To credit and process coin rewards accurately.
- To process gift card and voucher redemptions.
- To detect and prevent fraud, abuse, and cheating.
- To send important account notifications and updates.
- To improve app features and user experience.

## 3. What We Do NOT Do
- We never sell your personal data to third parties.
- We never share your data with advertisers without your consent.
- We never store payment card details — redemptions are handled by verified third-party processors.

## 4. Third-Party Services
We work with trusted partners to deliver our services:
- **PubScale & CPX Research** — for surveys and offer walls.
- **Xoxoday** — for gift card fulfilment and rewards processing.
- **Firebase / Google Analytics** — for app analytics and crash reporting.

These services operate under their own privacy policies.

## 5. Data Security
We implement industry-standard security measures including encrypted data transmission (HTTPS), secure cloud servers, and access controls to protect your information.

## 6. Data Retention
We retain your account data for as long as your account is active. You may request deletion of your data at any time by contacting us.

## 7. Children's Privacy
OfferPlay is strictly for users aged 18 and above. We do not knowingly collect data from anyone under 18.

## 8. Your Rights
- Request access to the data we hold about you.
- Request correction of inaccurate data.
- Request deletion of your account and associated data.
- Opt out of non-essential communications.

## 9. Changes to This Policy
We may update this Privacy Policy periodically. We will notify you of significant changes via the app.

## 10. Contact Us
For privacy concerns or data requests:
support@offerplay.in`;

const PAYMENT_CONTENT = `# Rewards & Payout Policy

## 1. How Rewards Work
OfferPlay operates on a coin-based reward system. You earn coins by completing tasks, surveys, watching ads, referring friends, and winning quiz contests. Coins can then be redeemed for gift cards and vouchers.

## 2. Coin Value
- Coins are virtual points with no fixed monetary value.
- The redemption rate and available rewards are shown in the Redeem tab and may change over time.
- Coins cannot be exchanged for cash, transferred to bank accounts, or sent to other users.

## 3. Redemption Options
- **Gift Cards** — Popular brands including Amazon, Flipkart, and more.
- **Vouchers** — Shopping, food, and entertainment vouchers.

Available options vary by region and may be updated periodically.

## 4. Minimum Redemption
- Minimum redemption threshold is 1000 coins.
- Specific thresholds for individual reward options are shown at the time of redemption.

## 5. Processing Time
- Gift card and voucher redemptions are typically processed within 24–48 hours.
- Some rewards may be delivered instantly; others may take up to 5 business days.
- Processing times may be longer during high-demand periods or public holidays.

## 6. Verification
- OfferPlay reserves the right to verify any redemption request before processing.
- We may request identity verification to prevent fraud and comply with applicable regulations.
- Suspected fraudulent redemptions will be cancelled and the account will be suspended.

## 7. Failed or Delayed Redemptions
If your redemption is not processed within the stated time, contact us at support@offerplay.in with your registered email/phone, redemption amount, and date of request. We will investigate and resolve valid claims within 5 business days.

## 8. Expiry & Forfeiture
- Coins expire 12 months from the date of earning.
- Coins in accounts that are banned or terminated for policy violations are forfeited.
- Coins obtained through fraud or manipulation are void and will be removed.

## 9. Taxes
Users are responsible for any applicable taxes on rewards received. OfferPlay does not deduct tax at source but provides transaction records on request.

## 10. Contact
For any reward or payout queries:
support@offerplay.in`;

async function seedPolicies() {
  console.log('Seeding policy content...');

  const policies = [
    {
      key: 'POLICY_TERMS',
      label: 'Terms of Service',
      value: TERMS_CONTENT,
      category: 'LEGAL',
      description: 'Terms of Service shown in the app and at offerplay.in/terms',
    },
    {
      key: 'POLICY_PRIVACY',
      label: 'Privacy Policy',
      value: PRIVACY_CONTENT,
      category: 'LEGAL',
      description: 'Privacy Policy shown in the app and at offerplay.in/privacy',
    },
    {
      key: 'POLICY_PAYMENT',
      label: 'Rewards & Payout Policy',
      value: PAYMENT_CONTENT,
      category: 'LEGAL',
      description: 'Rewards & Payout Policy shown in the app and at offerplay.in/payment-policy',
    },
  ];

  for (const policy of policies) {
    await prisma.appSettings.upsert({
      where: { key: policy.key },
      update: {
        value: policy.value,
        label: policy.label,
        category: policy.category,
        description: policy.description,
      },
      create: {
        key: policy.key,
        value: policy.value,
        label: policy.label,
        category: policy.category,
        description: policy.description,
      },
    });
    console.log(`✅ Upserted: ${policy.key}`);
  }

  console.log('Done seeding policies.');
  await prisma.$disconnect();
}

seedPolicies().catch(e => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
