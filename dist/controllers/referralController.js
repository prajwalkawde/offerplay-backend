"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processAdminClaim = exports.getAdminMilestoneClaims = exports.claimMilestone = exports.getMilestones = exports.creditReferralCommission = exports.applyReferralCode = exports.getReferralDashboard = void 0;
const database_1 = require("../config/database");
const response_1 = require("../utils/response");
const logger_1 = require("../utils/logger");
// ─── GET /api/referral/dashboard ──────────────────────────────────────────────
const getReferralDashboard = async (req, res) => {
    try {
        const userId = req.userId;
        const user = await database_1.prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, referralCode: true, referralCount: true },
        });
        if (!user) {
            (0, response_1.error)(res, 'User not found', 404);
            return;
        }
        // Generate referral code if somehow missing
        let referralCode = user.referralCode;
        if (!referralCode) {
            referralCode = generateReferralCode(user.name || 'USER');
            await database_1.prisma.user.update({ where: { id: userId }, data: { referralCode } });
        }
        const [settings, referrals, commissions] = await Promise.all([
            database_1.prisma.referralSettings.findFirst().catch(() => null),
            database_1.prisma.referral.findMany({
                where: { referrerId: userId },
                include: { referred: { select: { id: true, name: true, createdAt: true } } },
                orderBy: { createdAt: 'desc' },
            }),
            database_1.prisma.referralCommission.findMany({
                where: { referrerId: userId },
                orderBy: { createdAt: 'desc' },
                take: 50,
            }),
        ]);
        const cfg = settings ?? {
            signupBonus: 100, referrerSignupBonus: 50,
            taskCommissionPct: 10, surveyCommissionPct: 10,
            offerwallCommissionPct: 10, contestWinCommissionPct: 5,
            isLifetimeCommission: true, maxReferrals: null,
        };
        const creditedComms = commissions.filter(c => c.status === 'credited');
        const pendingComms = commissions.filter(c => c.status === 'pending');
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);
        const totalEarned = creditedComms.reduce((s, c) => s + c.amount, 0);
        const pending = pendingComms.reduce((s, c) => s + c.amount, 0);
        const thisMonth = creditedComms
            .filter(c => new Date(c.createdAt) >= startOfMonth)
            .reduce((s, c) => s + c.amount, 0);
        // Also include legacy coinsEarned from Referral records if commissions are empty
        const legacyTotal = commissions.length === 0
            ? referrals.reduce((s, r) => s + (r.coinsEarned || 0), 0)
            : 0;
        (0, response_1.success)(res, {
            referralCode,
            stats: {
                totalReferrals: referrals.length,
                activeReferrals: referrals.filter(r => r.status === 'active').length,
                totalEarned: totalEarned + legacyTotal,
                thisMonth,
                pending,
                paid: totalEarned,
            },
            settings: {
                signupBonus: cfg.signupBonus,
                referrerSignupBonus: cfg.referrerSignupBonus,
                taskCommissionPct: cfg.taskCommissionPct,
                surveyCommissionPct: cfg.surveyCommissionPct,
                offerwallCommissionPct: cfg.offerwallCommissionPct,
                contestWinCommissionPct: cfg.contestWinCommissionPct,
                isLifetimeCommission: cfg.isLifetimeCommission,
                maxReferrals: cfg.maxReferrals,
            },
            referrals: referrals.map(r => ({
                id: r.id,
                userId: r.referredId,
                name: maskName(r.referred.name || 'User'),
                avatar: (r.referred.name?.charAt(0) || 'U').toUpperCase(),
                status: r.status,
                totalEarned: r.totalEarned || r.coinsEarned || 0,
                joinedAt: r.createdAt,
                daysAgo: Math.floor((Date.now() - new Date(r.createdAt).getTime()) / 86400000),
            })),
            commissions: commissions.map(c => ({
                id: c.id,
                type: c.type,
                amount: c.amount,
                percentage: c.percentage,
                description: c.description || getCommissionDesc(c),
                status: c.status,
                createdAt: c.createdAt,
            })),
        });
    }
    catch (err) {
        logger_1.logger.error('getReferralDashboard error', { err });
        (0, response_1.error)(res, 'Failed to load referral data', 500);
    }
};
exports.getReferralDashboard = getReferralDashboard;
// ─── POST /api/referral/apply ──────────────────────────────────────────────────
const applyReferralCode = async (req, res) => {
    try {
        const userId = req.userId;
        const { referralCode } = req.body;
        if (!referralCode?.trim()) {
            (0, response_1.error)(res, 'Referral code required', 400);
            return;
        }
        const referrer = await database_1.prisma.user.findUnique({
            where: { referralCode: referralCode.trim().toUpperCase() },
        });
        if (!referrer) {
            (0, response_1.error)(res, 'Invalid referral code', 400);
            return;
        }
        if (referrer.id === userId) {
            (0, response_1.error)(res, 'Cannot refer yourself', 400);
            return;
        }
        const existing = await database_1.prisma.referral.findUnique({ where: { referredId: userId } });
        if (existing) {
            (0, response_1.error)(res, 'You have already used a referral code', 400);
            return;
        }
        const settings = await database_1.prisma.referralSettings.findFirst().catch(() => null);
        const signupBonus = settings?.signupBonus ?? 100;
        const referrerBonus = settings?.referrerSignupBonus ?? 50;
        await database_1.prisma.$transaction(async (tx) => {
            const referral = await tx.referral.create({
                data: { referrerId: referrer.id, referredId: userId, status: 'active' },
            });
            await tx.user.update({
                where: { id: referrer.id },
                data: { referralCount: { increment: 1 } },
            });
            await tx.user.update({
                where: { id: userId },
                data: { referredBy: referrer.id },
            });
            if (signupBonus > 0) {
                await tx.user.update({ where: { id: userId }, data: { coinBalance: { increment: signupBonus } } });
                await tx.transaction.create({
                    data: { userId, type: 'EARN_REFERRAL', amount: signupBonus, description: 'Welcome bonus from referral', status: 'completed' },
                });
            }
            if (referrerBonus > 0) {
                await tx.user.update({ where: { id: referrer.id }, data: { coinBalance: { increment: referrerBonus } } });
                await tx.transaction.create({
                    data: { userId: referrer.id, type: 'EARN_REFERRAL', amount: referrerBonus, description: 'Friend joined using your referral code', status: 'completed', refId: referral.id },
                });
                await tx.referralCommission.create({
                    data: {
                        referralId: referral.id,
                        referrerId: referrer.id,
                        referredId: userId,
                        type: 'SIGNUP',
                        amount: referrerBonus,
                        percentage: 100,
                        sourceAmount: referrerBonus,
                        description: 'Friend signup bonus',
                        status: 'credited',
                        creditedAt: new Date(),
                    },
                });
                await tx.referral.update({
                    where: { id: referral.id },
                    data: { totalEarned: { increment: referrerBonus }, coinsEarned: { increment: referrerBonus } },
                });
            }
        });
        (0, response_1.success)(res, { signupBonus, referrerName: referrer.name }, `Referral applied! You earned ${signupBonus} coins!`);
    }
    catch (err) {
        logger_1.logger.error('applyReferralCode error', { err });
        (0, response_1.error)(res, 'Failed to apply referral code', 500);
    }
};
exports.applyReferralCode = applyReferralCode;
// ─── Internal: credit commission when referred user earns ─────────────────────
const creditReferralCommission = async (userId, earnedAmount, type) => {
    try {
        const referral = await database_1.prisma.referral.findFirst({
            where: { referredId: userId, status: 'active' },
        });
        if (!referral)
            return;
        const settings = await database_1.prisma.referralSettings.findFirst().catch(() => null);
        const pctMap = {
            TASK: settings?.taskCommissionPct ?? 10,
            SURVEY: settings?.surveyCommissionPct ?? 10,
            OFFERWALL: settings?.offerwallCommissionPct ?? 10,
            CONTEST: settings?.contestWinCommissionPct ?? 5,
        };
        const pct = pctMap[type];
        const commission = Math.floor(earnedAmount * (pct / 100));
        if (commission <= 0)
            return;
        await database_1.prisma.$transaction(async (tx) => {
            await tx.user.update({ where: { id: referral.referrerId }, data: { coinBalance: { increment: commission } } });
            await tx.transaction.create({
                data: {
                    userId: referral.referrerId,
                    type: 'EARN_REFERRAL',
                    amount: commission,
                    description: `${pct}% of friend's ${type.toLowerCase()} (${commission} coins)`,
                    status: 'completed',
                    refId: referral.id,
                },
            });
            await tx.referralCommission.create({
                data: {
                    referralId: referral.id,
                    referrerId: referral.referrerId,
                    referredId: userId,
                    type,
                    amount: commission,
                    percentage: pct,
                    sourceAmount: earnedAmount,
                    description: `${pct}% of friend's ${type.toLowerCase()}`,
                    status: 'credited',
                    creditedAt: new Date(),
                },
            });
            await tx.referral.update({
                where: { id: referral.id },
                data: {
                    totalEarned: { increment: commission },
                    coinsEarned: { increment: commission },
                    lastActiveAt: new Date(),
                },
            });
        });
        logger_1.logger.info(`Referral commission: ${commission} coins to ${referral.referrerId} for ${type}`);
    }
    catch (err) {
        logger_1.logger.error('creditReferralCommission error', { err });
    }
};
exports.creditReferralCommission = creditReferralCommission;
// ─── GET /api/referral/milestones ─────────────────────────────────────────────
const getMilestones = async (req, res) => {
    try {
        const userId = req.userId;
        const [milestones, referralCount, claims] = await Promise.all([
            database_1.prisma.referralMilestone.findMany({ where: { isActive: true }, orderBy: { requiredReferrals: 'asc' } }),
            database_1.prisma.referral.count({ where: { referrerId: userId } }),
            database_1.prisma.referralMilestoneClaim.findMany({ where: { userId } }),
        ]);
        const claimMap = new Map(claims.map(c => [c.milestoneId, c]));
        (0, response_1.success)(res, {
            milestones: milestones.map(m => {
                const claim = claimMap.get(m.id);
                return {
                    ...m,
                    isUnlocked: referralCount >= m.requiredReferrals,
                    isClaimed: !!claim,
                    claimStatus: claim?.status ?? null,
                    progress: Math.min(referralCount, m.requiredReferrals),
                    progressPct: Math.min((referralCount / m.requiredReferrals) * 100, 100),
                };
            }),
            currentReferrals: referralCount,
        });
    }
    catch (err) {
        logger_1.logger.error('getMilestones error', { err });
        (0, response_1.error)(res, 'Failed to load milestones', 500);
    }
};
exports.getMilestones = getMilestones;
// ─── POST /api/referral/milestones/:id/claim ──────────────────────────────────
const claimMilestone = async (req, res) => {
    try {
        const userId = req.userId;
        const id = req.params.id;
        const { deliveryEmail, deliveryAddress } = req.body;
        const milestone = await database_1.prisma.referralMilestone.findUnique({ where: { id } });
        if (!milestone) {
            (0, response_1.error)(res, 'Milestone not found', 404);
            return;
        }
        const existing = await database_1.prisma.referralMilestoneClaim.findUnique({
            where: { userId_milestoneId: { userId, milestoneId: id } },
        });
        if (existing) {
            (0, response_1.error)(res, 'Already claimed!', 400);
            return;
        }
        const referralCount = await database_1.prisma.referral.count({ where: { referrerId: userId } });
        if (referralCount < milestone.requiredReferrals) {
            (0, response_1.error)(res, `Need ${milestone.requiredReferrals} referrals, you have ${referralCount}`, 400);
            return;
        }
        await database_1.prisma.$transaction(async (tx) => {
            await tx.referralMilestoneClaim.create({
                data: {
                    userId,
                    milestoneId: id,
                    status: milestone.rewardType === 'INVENTORY' ? 'pending' : 'claimed',
                    deliveryAddress: deliveryAddress ?? null,
                    deliveryEmail: deliveryEmail ?? null,
                },
            });
            if (milestone.rewardType === 'COINS' && milestone.rewardCoins) {
                await tx.user.update({ where: { id: userId }, data: { coinBalance: { increment: milestone.rewardCoins } } });
                await tx.transaction.create({
                    data: {
                        userId,
                        type: 'REFERRAL_MILESTONE',
                        amount: milestone.rewardCoins,
                        description: `Milestone: ${milestone.title}`,
                        status: 'completed',
                        refId: id,
                    },
                });
            }
            if (milestone.rewardType === 'TICKETS' && milestone.rewardTickets) {
                await tx.user.update({ where: { id: userId }, data: { ticketBalance: { increment: milestone.rewardTickets } } });
            }
        });
        const msg = milestone.rewardType === 'INVENTORY'
            ? 'Claim submitted! Admin will process your gift.'
            : `${milestone.title} reward claimed!`;
        (0, response_1.success)(res, {
            rewardType: milestone.rewardType,
            rewardCoins: milestone.rewardCoins,
            rewardTickets: milestone.rewardTickets,
            isPhysical: milestone.rewardType === 'INVENTORY',
        }, msg);
    }
    catch (err) {
        logger_1.logger.error('claimMilestone error', { err });
        (0, response_1.error)(res, 'Failed to claim milestone', 500);
    }
};
exports.claimMilestone = claimMilestone;
// ─── ADMIN: GET /api/referral/admin/claims ────────────────────────────────────
const getAdminMilestoneClaims = async (_req, res) => {
    try {
        const claims = await database_1.prisma.referralMilestoneClaim.findMany({
            where: { status: 'pending' },
            include: {
                user: { select: { name: true, phone: true, coinBalance: true } },
                milestone: true,
            },
            orderBy: { claimedAt: 'desc' },
        });
        (0, response_1.success)(res, claims);
    }
    catch (err) {
        logger_1.logger.error('getAdminMilestoneClaims error', { err });
        (0, response_1.error)(res, 'Failed', 500);
    }
};
exports.getAdminMilestoneClaims = getAdminMilestoneClaims;
// ─── ADMIN: PUT /api/referral/admin/claims/:id ────────────────────────────────
const processAdminClaim = async (req, res) => {
    try {
        const id = req.params.id;
        const { status, adminNote } = req.body;
        const claim = await database_1.prisma.referralMilestoneClaim.update({
            where: { id },
            data: {
                status,
                adminNote: adminNote ?? null,
                completedAt: status === 'completed' ? new Date() : null,
            },
        });
        (0, response_1.success)(res, claim, 'Updated!');
    }
    catch (err) {
        logger_1.logger.error('processAdminClaim error', { err });
        (0, response_1.error)(res, 'Failed', 500);
    }
};
exports.processAdminClaim = processAdminClaim;
// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateReferralCode(name) {
    const clean = name.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'USER';
    const num = Math.floor(1000 + Math.random() * 9000);
    return `${clean}${num}`;
}
function maskName(name) {
    return name.split(' ').map(p => p.charAt(0).toUpperCase() + '*'.repeat(Math.max(p.length - 1, 2))).join(' ');
}
function getCommissionDesc(c) {
    const map = {
        SIGNUP: 'New signup bonus',
        TASK: `Task commission (${c.percentage}% of ${c.sourceAmount})`,
        SURVEY: `Survey commission (${c.percentage}%)`,
        OFFERWALL: `Offerwall commission (${c.percentage}%)`,
        CONTEST: `Contest win commission (${c.percentage}%)`,
    };
    return map[c.type] || c.type;
}
