import axios, { AxiosError } from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ─── Base URL ─────────────────────────────────────────────────────────────────
// All Cashfree Payout V1 endpoints (auth + beneficiary + transfers) share one base.
const getBaseUrl = (): string =>
  env.CASHFREE_ENV === 'PROD'
    ? 'https://api.cashfree.com/payout'
    : 'https://sandbox.cashfree.com/payout';

// ─── Token cache ──────────────────────────────────────────────────────────────
let _cachedToken: string = '';
let _tokenExpiry: number = 0;

async function getCashfreeToken(): Promise<string> {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;

  try {
    const res = await axios.post(
      `${getBaseUrl()}/v1/authorize`,
      {},
      {
        headers: {
          'X-Client-Id':     env.CASHFREE_APP_ID,
          'X-Client-Secret': env.CASHFREE_SECRET_KEY,
          'Content-Type':    'application/json',
        },
        timeout: 15000,
      },
    );

    const body = res.data;
    if (body?.status !== 'SUCCESS' || !body?.data?.token) {
      logger.error(`[Cashfree] Auth failed: ${JSON.stringify(body)}`);
      return '';
    }

    _cachedToken = body.data.token as string;
    _tokenExpiry = body.data.expiry
      ? (parseInt(body.data.expiry, 10) - 60) * 1000
      : Date.now() + 25 * 60 * 1000;

    logger.info(`[Cashfree] Token obtained, expires at ${new Date(_tokenExpiry).toISOString()}`);
    return _cachedToken;
  } catch (err) {
    const e = err as AxiosError;
    logger.error(`[Cashfree] Auth request failed (${e.response?.status}): ${JSON.stringify(e.response?.data)}`);
    return '';
  }
}

// Headers for authenticated V1 Payout calls
async function authHeaders() {
  const token = await getCashfreeToken();
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
  };
}

// ─── Response validation ──────────────────────────────────────────────────────
function isCashfreeError(data: any): boolean {
  return data?.status === 'ERROR' || (data?.subCode && parseInt(data.subCode, 10) >= 400);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBeneId(prefix: string, userId: string, key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  return `${prefix}_${userId.slice(0, 8)}_${safe}`.slice(0, 50);
}

function sanitisePhone(phone?: string | null): string {
  if (!phone) return '9999999999';
  const digits = phone.replace(/\D/g, '');
  const local  = digits.startsWith('91') && digits.length === 12 ? digits.slice(2) : digits;
  return local.length >= 8 ? local.slice(-10) : '9999999999';
}

function sanitiseName(name?: string | null): string {
  const clean = (name || 'OfferPlay User').replace(/[^a-zA-Z\s]/g, '').trim();
  return clean.length >= 2 ? clean.slice(0, 100) : 'OfferPlay User';
}

// ─── Beneficiary ──────────────────────────────────────────────────────────────

async function createOrGetBeneficiary(beneId: string, beneData: Record<string, string>): Promise<boolean> {
  const base    = getBaseUrl();
  const headers = await authHeaders();

  // Check if beneficiary already exists
  try {
    const res = await axios.get(`${base}/v1/beneficiary/${beneId}`, { headers, timeout: 15000 });
    if (!isCashfreeError(res.data)) {
      logger.info(`[Cashfree] Beneficiary ${beneId} already exists — reusing`);
      return true;
    }
    logger.info(`[Cashfree] Beneficiary check returned error body: ${JSON.stringify(res.data)}`);
  } catch (err) {
    const status = (err as AxiosError)?.response?.status;
    if (status !== 404) {
      logger.warn(`[Cashfree] GET beneficiary ${beneId} HTTP ${status}`);
    }
    // 404 = doesn't exist yet → create below
  }

  // Create beneficiary
  try {
    const res = await axios.post(
      `${base}/v1/beneficiary`,
      { beneId, ...beneData },
      { headers, timeout: 15000 },
    );
    if (isCashfreeError(res.data)) {
      if (String(res.data?.subCode) === '409') {
        logger.info(`[Cashfree] Beneficiary ${beneId} already exists (body 409) — continuing`);
        return true;
      }
      logger.error(`[Cashfree] Failed to create beneficiary: ${JSON.stringify(res.data)}`);
      return false;
    }
    logger.info(`[Cashfree] Created beneficiary ${beneId}`);
    return true;
  } catch (err) {
    const e = err as AxiosError<{ message?: string; subCode?: string }>;
    if (e.response?.status === 409 || e.response?.data?.subCode === '409') {
      logger.info(`[Cashfree] Beneficiary ${beneId} conflict (409) — continuing`);
      return true;
    }
    logger.error(`[Cashfree] Failed to create beneficiary: ${JSON.stringify(e.response?.data)}`);
    return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CashfreeResult {
  success:      boolean;
  referenceId?: string;
  error?:       string;
}

export const transferToUPI = async (
  orderId:    string,
  upiId:      string,
  amount:     number,
  name:       string,
  userId:     string,
  userPhone?: string,
  userEmail?: string,
): Promise<CashfreeResult> => {
  try {
    if (!env.CASHFREE_APP_ID || env.CASHFREE_APP_ID.startsWith('your-')) {
      logger.warn('[Cashfree] Not configured — returning mock UPI result');
      return { success: true, referenceId: `MOCK_UPI_${orderId}` };
    }

    const beneId = makeBeneId('OP_UPI', userId, upiId);
    const phone  = sanitisePhone(userPhone);
    const email  = userEmail?.includes('@') ? userEmail : `user${userId.slice(0, 6)}@offerplay.in`;

    const beneOk = await createOrGetBeneficiary(beneId, {
      beneName:  sanitiseName(name),
      vpa:       upiId.trim(),
      email,
      phone,
    });
    if (!beneOk) return { success: false, error: 'Could not register UPI beneficiary' };

    const headers = await authHeaders();
    const body = {
      beneId,
      amount:        amount.toFixed(2),
      transferId:    orderId,
      transferMode:  'upi',
      remarks:       `OfferPlay payout ${orderId}`.slice(0, 70),
    };

    const res  = await axios.post(`${getBaseUrl()}/v1/transfers`, body, { headers, timeout: 30000 });
    const data = res.data;
    logger.info(`[Cashfree] UPI transfer response: ${JSON.stringify(data)}`);

    if (isCashfreeError(data)) {
      return { success: false, error: data?.message || `Cashfree error ${data?.subCode}` };
    }

    const status = (data?.data?.status || data?.status || '').toUpperCase();
    const cfRef  = data?.data?.referenceId || data?.referenceId || orderId;

    if (['RECEIVED', 'QUEUED', 'SUCCESS', 'COMPLETED', 'SENT_TO_BENEFICIARY'].includes(status)) {
      return { success: true, referenceId: String(cfRef) };
    }
    return { success: false, error: data?.data?.reason || data?.message || `Status: ${status}` };

  } catch (err: unknown) {
    const e   = err as AxiosError<{ message?: string }>;
    const msg = e.response?.data?.message || (e as Error).message || 'UPI transfer failed';
    logger.error(`[Cashfree] UPI transfer error (${e.response?.status}): ${JSON.stringify(e.response?.data)}`);
    return { success: false, error: msg };
  }
};

export const transferToBank = async (
  orderId:       string,
  accountNumber: string,
  ifscCode:      string,
  accountName:   string,
  amount:        number,
  userId:        string,
  transferMode:  'imps' | 'neft' | 'rtgs' = 'imps',
  userPhone?:    string,
  userEmail?:    string,
): Promise<CashfreeResult> => {
  try {
    if (!env.CASHFREE_APP_ID || env.CASHFREE_APP_ID.startsWith('your-')) {
      logger.warn('[Cashfree] Not configured — returning mock bank result');
      return { success: true, referenceId: `MOCK_BANK_${orderId}` };
    }

    const resolvedMode = amount >= 200000 ? 'rtgs' : transferMode;
    const beneId = makeBeneId('OP_BANK', userId, accountNumber);
    const phone  = sanitisePhone(userPhone);
    const email  = userEmail?.includes('@') ? userEmail : `user${userId.slice(0, 6)}@offerplay.in`;

    const beneOk = await createOrGetBeneficiary(beneId, {
      beneName:      sanitiseName(accountName),
      bankAccount:   accountNumber.trim(),
      ifsc:          ifscCode.trim().toUpperCase(),
      email,
      phone,
    });
    if (!beneOk) return { success: false, error: 'Could not register bank beneficiary' };

    const headers = await authHeaders();
    const body = {
      beneId,
      amount:       amount.toFixed(2),
      transferId:   orderId,
      transferMode: resolvedMode,
      remarks:      `OfferPlay payout ${orderId}`.slice(0, 70),
    };

    const res    = await axios.post(`${getBaseUrl()}/v1/transfers`, body, { headers, timeout: 30000 });
    const data   = res.data;
    const status = (data?.data?.status || data?.status || '').toUpperCase();
    const cfRef  = data?.data?.referenceId || data?.referenceId || orderId;

    logger.info(`[Cashfree] Bank (${resolvedMode}) response: ${JSON.stringify(data)}`);

    if (isCashfreeError(data)) {
      return { success: false, error: data?.message || `Cashfree error ${data?.subCode}` };
    }
    if (['RECEIVED', 'QUEUED', 'SUCCESS', 'COMPLETED', 'SENT_TO_BENEFICIARY'].includes(status)) {
      return { success: true, referenceId: String(cfRef) };
    }
    return { success: false, error: data?.data?.reason || data?.message || `Status: ${status}` };

  } catch (err: unknown) {
    const e   = err as AxiosError<{ message?: string }>;
    const msg = e.response?.data?.message || (e as Error).message || 'Bank transfer failed';
    logger.error(`[Cashfree] Bank transfer error (${e.response?.status}): ${JSON.stringify(e.response?.data)}`);
    return { success: false, error: msg };
  }
};

export const checkTransferStatus = async (transferId: string): Promise<string> => {
  try {
    const headers = await authHeaders();
    const res     = await axios.get(`${getBaseUrl()}/v1/transfers?transferId=${transferId}`, { headers, timeout: 15000 });
    if (isCashfreeError(res.data)) return 'UNKNOWN';
    return (res.data?.data?.status || res.data?.status || 'UNKNOWN').toUpperCase();
  } catch (err) {
    logger.warn(`[Cashfree] checkTransferStatus failed: ${(err as AxiosError)?.response?.status}`);
    return 'UNKNOWN';
  }
};
