import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const getCashfreeBaseUrl = (): string =>
  env.CASHFREE_ENV === 'PROD'
    ? 'https://api.cashfree.com/payout'
    : 'https://payout-gamma.cashfree.com';

const cashfreeHeaders = () => ({
  'X-Client-Id': env.CASHFREE_APP_ID,
  'X-Client-Secret': env.CASHFREE_SECRET_KEY,
  'Content-Type': 'application/json',
});

const getCashfreeToken = async (): Promise<string> => {
  try {
    const response = await axios.post(
      `${getCashfreeBaseUrl()}/v1/authorize`,
      {},
      { headers: cashfreeHeaders() }
    );
    return (response.data?.data?.token as string) || '';
  } catch (err) {
    logger.error('Cashfree auth failed:', err);
    return '';
  }
};

export interface CashfreeResult {
  success: boolean;
  referenceId?: string;
  error?: string;
}

export const transferToUPI = async (
  orderId: string,
  upiId: string,
  amount: number,
  name: string,
  userId: string
): Promise<CashfreeResult> => {
  try {
    if (!env.CASHFREE_APP_ID || env.CASHFREE_APP_ID.startsWith('your-')) {
      logger.warn('Cashfree not configured — using mock');
      return { success: true, referenceId: `MOCK_${orderId}` };
    }

    const token = await getCashfreeToken();
    if (!token) return { success: false, error: 'Cashfree auth failed' };

    const response = await axios.post(
      `${getCashfreeBaseUrl()}/v1.2/directtransfer`,
      {
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
      },
      { headers: { ...cashfreeHeaders(), Authorization: `Bearer ${token}` } }
    );

    if (response.data?.status === 'SUCCESS') {
      return { success: true, referenceId: response.data?.data?.referenceId as string };
    }
    return { success: false, error: (response.data?.message as string) || 'Transfer failed' };
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } }; message?: string };
    logger.error('Cashfree UPI transfer error:', err);
    return { success: false, error: e.response?.data?.message || e.message || 'Transfer failed' };
  }
};

export const transferToBank = async (
  orderId: string,
  accountNumber: string,
  ifscCode: string,
  accountName: string,
  amount: number,
  userId: string
): Promise<CashfreeResult> => {
  try {
    if (!env.CASHFREE_APP_ID || env.CASHFREE_APP_ID.startsWith('your-')) {
      return { success: true, referenceId: `MOCK_BANK_${orderId}` };
    }

    const token = await getCashfreeToken();
    if (!token) return { success: false, error: 'Cashfree auth failed' };

    const response = await axios.post(
      `${getCashfreeBaseUrl()}/v1.2/directtransfer`,
      {
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
      },
      { headers: { ...cashfreeHeaders(), Authorization: `Bearer ${token}` } }
    );

    if (response.data?.status === 'SUCCESS') {
      return { success: true, referenceId: response.data?.data?.referenceId as string };
    }
    return { success: false, error: (response.data?.message as string) || 'Transfer failed' };
  } catch (err: unknown) {
    const e = err as { response?: { data?: { message?: string } }; message?: string };
    logger.error('Cashfree bank transfer error:', err);
    return { success: false, error: e.response?.data?.message || e.message || 'Transfer failed' };
  }
};

export const checkTransferStatus = async (transferId: string): Promise<string> => {
  try {
    const token = await getCashfreeToken();
    const response = await axios.get(
      `${getCashfreeBaseUrl()}/v1.2/transfers/${transferId}`,
      { headers: { ...cashfreeHeaders(), Authorization: `Bearer ${token}` } }
    );
    return (response.data?.data?.status as string) || 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
};
