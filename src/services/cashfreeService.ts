import axios, { AxiosError } from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ─── Base URL ─────────────────────────────────────────────────────────────────
const getBaseUrl = (): string =>
  env.CASHFREE_ENV === 'PROD'
    ? 'https://api.cashfree.com/payout'
    : 'https://sandbox.cashfree.com/payout';

// ─── Token cache ──────────────────────────────────────────────────────────────
// Cashfree Payout V2 requires a Bearer token obtained via POST /v2/authorize.
// Tokens are valid for ~30 minutes; we cache and refresh automatically.
let _cachedToken:  string = '';
let _tokenExpiry:  number = 0;

async function getCashfreeToken(): Promise<string> {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;

  try {
    const res = await axios.post(
      `${getBaseUrl()}/v2/authorize`,
      {},
      {
        headers: {
          'x-client-id':     env.CASHFREE_APP_ID,
          'x-client-secret': env.CASHFREE_SECRET_KEY,
          'Content-Type':    'application/json',
        },
        timeout: 15000,
      },
    );

    // Success body: { status: "SUCCESS", subCode: "200", data: { token, expiry } }
    const body = res.data;
    if (body?.status !== 'SUCCESS' || !body?.data?.token) {
      logger.error(`[Cashfree] Auth failed: ${JSON.stringify(body)}`);
      return '';
    }

    _cachedToken = body.data.token as string;
    // expiry comes as Unix seconds; subtract 60s buffer
    _tokenExpiry = body.data.expiry
      ? (parseInt(body.data.expiry, 10) - 60) * 1000
      : Date.now() + 25 * 60 * 1000;   // fallback: 25 min

    logger.info(`[Cashfree] Token obtained, expires at ${new Date(_tokenExpiry).toISOString()}`);
    return _cachedToken;
  } catch (err) {
    const e = err as AxiosError;
    logger.error(`[Cashfree] Auth request failed (${e.response?.status}): ${JSON.stringify(e.response?.data)}`);
    return '';
  }
}

// Headers for all authenticated V2 Payout calls
async function authHeaders() {
  const token = await getCashfreeToken();
  return {
    'Authorization': `Bearer ${token}`,
    'x-api-version': '2024-01-01',
    'Content-Type':  'application/json',
  };
}

// ─── Response validation ──────────────────────────────────────────────────────
// Cashfree returns HTTP 200 even for auth errors — must check body.status
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

  // Check if beneficiary exists — must also validate body (HTTP 200 ≠ success)
  try {
    const res = await axios.get(`${base}/beneficiary/${beneId}`, { headers, timeout: 15000 });
    if (!isCashfreeError(res.data)) {
      logger.info(`[Cashfree] Beneficiary ${beneId} already exists — reusing`);
      return true;
    }
    // Body-level error (e.g. 404-in-body or auth error) — fall through to create
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
      `${base}/beneficiary`,
      { beneficiary_id: beneId, ...beneData },
      { headers, timeout: 15000 },
    );
    if (isCashfreeError(res.data)) {
      // 409 equivalent in body = already exists
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
      beneficiary_name:  sanitiseName(name),
      vpa:               upiId.trim(),
      beneficiary_email: email,
      beneficiary_phone: phone,
    });
    if (!beneOk) return { success: false, error: 'Could not register UPI beneficiary' };

    const headers = await authHeaders();
    const body = {
      transfer_id:       orderId,
      transfer_amount:   amount,
      transfer_currency: 'INR',
      transfer_mode:     'upi',
      beneficiary_id:    beneId,
      remarks:           `OfferPlay payout ${orderId}`.slice(0, 70),
    };

    const res  = await axios.post(`${getBaseUrl()}/v2/transfers`, body, { headers, timeout: 30000 });
    const data = res.data;
    logger.info(`[Cashfree] UPI transfer response: ${JSON.stringify(data)}`);

    if (isCashfreeError(data)) {
      return { success: false, error: data?.message || `Cashfree error ${data?.subCode}` };
    }

    const status = (data?.data?.status || data?.status || '').toUpperCase();
    const cfRef  = data?.data?.cf_transfer_id || data?.cf_transfer_id || orderId;

    if (['RECEIVED', 'QUEUED', 'SUCCESS', 'COMPLETED', 'SENT_TO_BENEFICIARY'].includes(status)) {
      return { success: true, referenceId: String(cfRef) };
    }
    return { success: false, error: data?.data?.status_description || data?.message || `Status: ${status}` };

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
      beneficiary_name:    sanitiseName(accountName),
      bank_account_number: accountNumber.trim(),
      bank_ifsc:           ifscCode.trim().toUpperCase(),
      beneficiary_email:   email,
      beneficiary_phone:   phone,
    });
    if (!beneOk) return { success: false, error: 'Could not register bank beneficiary' };

    const headers = await authHeaders();
    const body = {
      transfer_id:       orderId,
      transfer_amount:   amount,
      transfer_currency: 'INR',
      transfer_mode:     resolvedMode,
      beneficiary_id:    beneId,
      remarks:           `OfferPlay payout ${orderId}`.slice(0, 70),
    };

    const res    = await axios.post(`${getBaseUrl()}/v2/transfers`, body, { headers, timeout: 30000 });
    const data   = res.data;
    const status = (data?.data?.status || data?.status || '').toUpperCase();
    const cfRef  = data?.data?.cf_transfer_id || data?.cf_transfer_id || orderId;

    logger.info(`[Cashfree] Bank (${resolvedMode}) response: ${JSON.stringify(data)}`);

    if (isCashfreeError(data)) {
      return { success: false, error: data?.message || `Cashfree error ${data?.subCode}` };
    }
    if (['RECEIVED', 'QUEUED', 'SUCCESS', 'COMPLETED', 'SENT_TO_BENEFICIARY'].includes(status)) {
      return { success: true, referenceId: String(cfRef) };
    }
    return { success: false, error: data?.data?.status_description || data?.message || `Status: ${status}` };

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
    const res     = await axios.get(`${getBaseUrl()}/v2/transfers/${transferId}`, { headers, timeout: 15000 });
    if (isCashfreeError(res.data)) return 'UNKNOWN';
    return (res.data?.data?.status || res.data?.status || 'UNKNOWN').toUpperCase();
  } catch (err) {
    logger.warn(`[Cashfree] checkTransferStatus failed: ${(err as AxiosError)?.response?.status}`);
    return 'UNKNOWN';
  }
};
