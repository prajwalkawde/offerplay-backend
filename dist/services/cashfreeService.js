"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkTransferStatus = exports.transferToBank = exports.transferToUPI = void 0;
const axios_1 = __importDefault(require("axios"));
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const getCashfreeBaseUrl = () => env_1.env.CASHFREE_ENV === 'PROD'
    ? 'https://api.cashfree.com/payout'
    : 'https://payout-gamma.cashfree.com';
const cashfreeHeaders = () => ({
    'X-Client-Id': env_1.env.CASHFREE_APP_ID,
    'X-Client-Secret': env_1.env.CASHFREE_SECRET_KEY,
    'Content-Type': 'application/json',
});
const getCashfreeToken = async () => {
    try {
        const response = await axios_1.default.post(`${getCashfreeBaseUrl()}/v1/authorize`, {}, { headers: cashfreeHeaders() });
        return response.data?.data?.token || '';
    }
    catch (err) {
        logger_1.logger.error('Cashfree auth failed:', err);
        return '';
    }
};
const transferToUPI = async (orderId, upiId, amount, name, userId) => {
    try {
        if (!env_1.env.CASHFREE_APP_ID || env_1.env.CASHFREE_APP_ID.startsWith('your-')) {
            logger_1.logger.warn('Cashfree not configured — using mock');
            return { success: true, referenceId: `MOCK_${orderId}` };
        }
        const token = await getCashfreeToken();
        if (!token)
            return { success: false, error: 'Cashfree auth failed' };
        const response = await axios_1.default.post(`${getCashfreeBaseUrl()}/v1.2/directtransfer`, {
            amount: amount.toFixed(2),
            transferId: orderId,
            transferMode: 'upi',
            beneDetails: {
                beneId: `BENE_${userId}_${Date.now()}`,
                name: name || 'OfferPlay User',
                email: `user${userId.slice(0, 6)}@offerplay.in`,
                phone: '9999999999',
                bankAccount: upiId,
                ifsc: 'UPIID',
                address1: 'India',
                city: 'India',
                state: 'India',
                pincode: '000000',
            },
            remarks: `OfferPlay withdrawal - ${orderId}`,
        }, { headers: { ...cashfreeHeaders(), Authorization: `Bearer ${token}` } });
        if (response.data?.status === 'SUCCESS') {
            return { success: true, referenceId: response.data?.data?.referenceId };
        }
        return { success: false, error: response.data?.message || 'Transfer failed' };
    }
    catch (err) {
        const e = err;
        logger_1.logger.error('Cashfree UPI transfer error:', err);
        return { success: false, error: e.response?.data?.message || e.message || 'Transfer failed' };
    }
};
exports.transferToUPI = transferToUPI;
const transferToBank = async (orderId, accountNumber, ifscCode, accountName, amount, userId) => {
    try {
        if (!env_1.env.CASHFREE_APP_ID || env_1.env.CASHFREE_APP_ID.startsWith('your-')) {
            return { success: true, referenceId: `MOCK_BANK_${orderId}` };
        }
        const token = await getCashfreeToken();
        if (!token)
            return { success: false, error: 'Cashfree auth failed' };
        const response = await axios_1.default.post(`${getCashfreeBaseUrl()}/v1.2/directtransfer`, {
            amount: amount.toFixed(2),
            transferId: orderId,
            transferMode: 'banktransfer',
            beneDetails: {
                beneId: `BENE_BANK_${userId}_${Date.now()}`,
                name: accountName || 'OfferPlay User',
                email: `user${userId.slice(0, 6)}@offerplay.in`,
                phone: '9999999999',
                bankAccount: accountNumber,
                ifsc: ifscCode,
                address1: 'India',
                city: 'India',
                state: 'India',
                pincode: '000000',
            },
            remarks: `OfferPlay bank withdrawal - ${orderId}`,
        }, { headers: { ...cashfreeHeaders(), Authorization: `Bearer ${token}` } });
        if (response.data?.status === 'SUCCESS') {
            return { success: true, referenceId: response.data?.data?.referenceId };
        }
        return { success: false, error: response.data?.message || 'Transfer failed' };
    }
    catch (err) {
        const e = err;
        logger_1.logger.error('Cashfree bank transfer error:', err);
        return { success: false, error: e.response?.data?.message || e.message || 'Transfer failed' };
    }
};
exports.transferToBank = transferToBank;
const checkTransferStatus = async (transferId) => {
    try {
        const token = await getCashfreeToken();
        const response = await axios_1.default.get(`${getCashfreeBaseUrl()}/v1.2/transfers/${transferId}`, { headers: { ...cashfreeHeaders(), Authorization: `Bearer ${token}` } });
        return response.data?.data?.status || 'UNKNOWN';
    }
    catch {
        return 'UNKNOWN';
    }
};
exports.checkTransferStatus = checkTransferStatus;
