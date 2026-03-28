"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.spendTickets = exports.creditTickets = exports.getTicketBalance = void 0;
const database_1 = require("../config/database");
const logger_1 = require("../utils/logger");
const getTicketBalance = async (userId) => {
    const user = await database_1.prisma.user.findUnique({
        where: { id: userId },
        select: { ticketBalance: true },
    });
    return user?.ticketBalance || 0;
};
exports.getTicketBalance = getTicketBalance;
const creditTickets = async (userId, amount, reason, refId) => {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    const [user] = await database_1.prisma.$transaction([
        database_1.prisma.user.update({
            where: { id: userId },
            data: { ticketBalance: { increment: amount } },
        }),
        database_1.prisma.ticketTransaction.create({
            data: {
                userId,
                amount,
                type: 'EARN_TICKET',
                refId,
                description: reason,
                expiresAt,
            },
        }),
    ]);
    logger_1.logger.info(`Tickets credited: ${userId} +${amount} (${reason})`);
    return user.ticketBalance;
};
exports.creditTickets = creditTickets;
const spendTickets = async (userId, amount, reason, refId) => {
    const user = await database_1.prisma.user.findUnique({
        where: { id: userId },
        select: { ticketBalance: true },
    });
    if (!user || user.ticketBalance < amount) {
        return {
            success: false,
            newBalance: user?.ticketBalance || 0,
            error: `Insufficient tickets. Need ${amount}, have ${user?.ticketBalance || 0}`,
        };
    }
    const [updated] = await database_1.prisma.$transaction([
        database_1.prisma.user.update({
            where: { id: userId },
            data: { ticketBalance: { decrement: amount } },
        }),
        database_1.prisma.ticketTransaction.create({
            data: {
                userId,
                amount: -amount,
                type: 'SPEND_TICKET',
                refId,
                description: reason,
            },
        }),
    ]);
    return { success: true, newBalance: updated.ticketBalance };
};
exports.spendTickets = spendTickets;
