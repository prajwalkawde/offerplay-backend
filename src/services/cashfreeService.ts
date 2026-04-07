import axios, { AxiosError } from 'axios';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ─── Base URL ─────────────────────────────────────────────────────────────────
// V2 Payout API — no separate auth token needed.
// Auth is via x-client-id + x-client-secret + x-api-version headers on every request.
const getBaseUrl = (): string =>
  env.CASHFREE_ENV === 'PROD'
    ? 'https://api.cashfree.com/payout'
    : 'https://sandbox.cashfree.com/payout';

// ─── Headers ──────────────────────────────────────────────────────────────────
const v2Headers = () => ({
  'x-client-id':     env.CASHFREE_APP_ID,
  'x-client-secret': env.CASHFREE_SECRET_KEY,
  'x-api-version':   '2024-01-01',
  'Content-Type':    'application/json',
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Sanitise a string to be safe for Cashfree beneficiary_id (alphanumeric + _ only, max 50 chars) */
function makeBeneId(prefix: string, userId: string, key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  return `${prefix}_${userId.slice(0, 8)}_${safe}`.slice(0, 50);
}

/** Strip non-digits; return 10-digit Indian mobile if possible, else fallback */
function sanitisePhone(phone?: string | null): string {
  if (!phone) return '9999999999';
  const digits = phone.replace(/\D/g, '');
  // Remove leading 91/+91
  const local = digits.startsWith('91') && digits.length === 12 ? digits.slice(2) : digits;
  return local.length >= 8 ? local.slice(-10) : '9999999999';
}

/** Sanitise name to alphabets + whitespace only (Cashfree requirement) */
function sanitiseName(name?: string | null): string {
  const clean = (name || 'OfferPlay User').replace(/[^a-zA-Z\s]/g, '').trim();
  return clean.length >= 2 ? clean.slice(0, 100) : 'OfferPlay User';
}

// ─── Beneficiary Management ───────────────────────────────────────────────────
// V2 requires a beneficiary to be registered before creating a transfer.
// We use a deterministic beneId so the same user+account never creates duplicates.

async function createOrGetBeneficiary(beneId: string, beneData: Record<string, string>): Promise<boolean> {
  const base = getBaseUrl();
  const headers = v2Headers();

  // Check if beneficiary already exists
  try {
    await axios.get(`${base}/beneficiary/${beneId}`, { headers, timeout: 15000 });
    logger.info(`[Cashfree] Beneficiary ${beneId} already exists — reusing`);
    return true;
  } catch (err) {
    const status = (err as AxiosError)?.response?.status;
    if (status !== 404) {
      // Unexpected error checking existence
      logger.warn(`[Cashfree] GET beneficiary ${beneId} returned ${status}`);
    }
  }

  // Create beneficiary
  try {
    await axios.post(`${base}/beneficiary`, { beneficiary_id: beneId, ...beneData }, { headers, timeout: 15000 });
    logger.info(`[Cashfree] Created beneficiary ${beneId}`);
    return true;
  } catch (err) {
    const e = err as AxiosError<{ message?: string; code?: string }>;
    const status = e.response?.status;
    // 409 = already exists (race condition) — fine to proceed
    if (status === 409) {
      logger.info(`[Cashfree] Beneficiary ${beneId} conflict (already exists) — continuing`);
      return true;
    }
    logger.error(`[Cashfree] Failed to create beneficiary ${beneId}: ${status} — ${JSON.stringify(e.response?.data)}`);
    return false;
  }
}

// ─── Transfer status normalisation ────────────────────────────────────────────
// V2 terminal success states: SUCCESS, COMPLETED, SENT_TO_BENEFICIARY
// V2 terminal failure states: FAILED, REJECTED, REVERSED, MANUALLY_REJECTED

function isTransferSuccess(status: string): boolean {
  return ['SUCCESS', 'COMPLETED', 'SENT_TO_BENEFICIARY'].includes(status?.toUpperCase());
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CashfreeResult {
  success:      boolean;
  referenceId?: string;
  error?:       string;
}

/** UPI transfer — user only needs their UPI ID (VPA) */
export const transferToUPI = async (
  orderId:     string,
  upiId:       string,
  amount:      number,
  name:        string,
  userId:      string,
  userPhone?:  string,
  userEmail?:  string,
): Promise<CashfreeResult> => {
  try {
    if (!env.CASHFREE_APP_ID || env.CASHFREE_APP_ID.startsWith('your-')) {
      logger.warn('[Cashfree] Not configured — returning mock UPI result');
      return { success: true, referenceId: `MOCK_UPI_${orderId}` };
    }

    const beneId = makeBeneId('OP_UPI', userId, upiId);
    const phone  = sanitisePhone(userPhone);
    const email  = userEmail?.includes('@') ? userEmail : `user${userId.slice(0, 6)}@offerplay.in`;

    // Step 1: Register beneficiary with UPI VPA
    const beneOk = await createOrGetBeneficiary(beneId, {
      beneficiary_name:  sanitiseName(name),
      vpa:               upiId.trim(),   // VPA = UPI ID
      beneficiary_email: email,
      beneficiary_phone: phone,
    });
    if (!beneOk) return { success: false, error: 'Could not register UPI beneficiary' };

    // Step 2: Initiate transfer
    const body = {
      transfer_id:       orderId,
      transfer_amount:   amount,
      transfer_currency: 'INR',
      transfer_mode:     'upi',
      beneficiary_id:    beneId,
      remarks:           `OfferPlay reward payout ${orderId}`.slice(0, 70),
    };

    const res = await axios.post(`${getBaseUrl()}/v2/transfers`, body, {
      headers: v2Headers(),
      timeout: 30000,
    });

    const data = res.data;
    logger.info(`[Cashfree] UPI transfer response: ${JSON.stringify(data)}`);

    // RECEIVED / QUEUED means accepted for processing — treat as success
    const status = (data?.status || data?.transfer_status || '').toUpperCase();
    const cfRef  = data?.cf_transfer_id || data?.referenceId || orderId;

    if (['RECEIVED', 'QUEUED', 'SUCCESS', 'COMPLETED', 'SENT_TO_BENEFICIARY'].includes(status)) {
      return { success: true, referenceId: String(cfRef) };
    }
    return { success: false, error: data?.status_description || data?.message || `Transfer status: ${status}` };

  } catch (err: unknown) {
    const e = err as AxiosError<{ message?: string; status?: string }>;
    const msg = e.response?.data?.message || e.response?.data?.status || (e as Error).message || 'UPI transfer failed';
    logger.error(`[Cashfree] UPI transfer error (${e.response?.status}): ${JSON.stringify(e.response?.data)}`);
    return { success: false, error: msg };
  }
};

/**
 * Bank transfer — IMPS (instant), NEFT (batched), RTGS (high-value).
 *
 * User must provide:
 *   accountNumber  — bank account number
 *   ifscCode       — 11-character IFSC
 *   accountName    — account holder full name
 *   transferMode   — 'imps' | 'neft' | 'rtgs' (default: imps for amounts < ₹2L)
 *
 * Mode guide:
 *   IMPS  — instant 24×7, up to ₹5,00,000 per transaction
 *   NEFT  — batched Mon–Sat 8AM–7PM, any amount, usually within 2 hours
 *   RTGS  — real-time ₹2,00,000+, Mon–Sat 8AM–4:30PM
 */
export const transferToBank = async (
  orderId:      string,
  accountNumber: string,
  ifscCode:     string,
  accountName:  string,
  amount:       number,
  userId:       string,
  transferMode: 'imps' | 'neft' | 'rtgs' = 'imps',
  userPhone?:   string,
  userEmail?:   string,
): Promise<CashfreeResult> => {
  try {
    if (!env.CASHFREE_APP_ID || env.CASHFREE_APP_ID.startsWith('your-')) {
      logger.warn('[Cashfree] Not configured — returning mock bank result');
      return { success: true, referenceId: `MOCK_BANK_${orderId}` };
    }

    // Auto-upgrade to RTGS for large amounts
    const resolvedMode: string = amount >= 200000 ? 'rtgs' : transferMode;

    const beneId = makeBeneId('OP_BANK', userId, accountNumber);
    const phone  = sanitisePhone(userPhone);
    const email  = userEmail?.includes('@') ? userEmail : `user${userId.slice(0, 6)}@offerplay.in`;

    // Step 1: Register beneficiary with bank account
    const beneOk = await createOrGetBeneficiary(beneId, {
      beneficiary_name:        sanitiseName(accountName),
      bank_account_number:     accountNumber.trim(),
      bank_ifsc:               ifscCode.trim().toUpperCase(),
      beneficiary_email:       email,
      beneficiary_phone:       phone,
    });
    if (!beneOk) return { success: false, error: 'Could not register bank beneficiary' };

    // Step 2: Initiate transfer
    const body = {
      transfer_id:       orderId,
      transfer_amount:   amount,
      transfer_currency: 'INR',
      transfer_mode:     resolvedMode,
      beneficiary_id:    beneId,
      remarks:           `OfferPlay reward payout ${orderId}`.slice(0, 70),
    };

    const res = await axios.post(`${getBaseUrl()}/v2/transfers`, body, {
      headers: v2Headers(),
      timeout: 30000,
    });

    const data   = res.data;
    const status = (data?.status || data?.transfer_status || '').toUpperCase();
    const cfRef  = data?.cf_transfer_id || data?.referenceId || orderId;

    logger.info(`[Cashfree] Bank transfer (${resolvedMode}) response: status=${status} ref=${cfRef}`);

    if (['RECEIVED', 'QUEUED', 'SUCCESS', 'COMPLETED', 'SENT_TO_BENEFICIARY'].includes(status)) {
      return { success: true, referenceId: String(cfRef) };
    }
    return { success: false, error: data?.status_description || data?.message || `Transfer status: ${status}` };

  } catch (err: unknown) {
    const e = err as AxiosError<{ message?: string; status?: string }>;
    const msg = e.response?.data?.message || e.response?.data?.status || (e as Error).message || 'Bank transfer failed';
    logger.error(`[Cashfree] Bank transfer error (${e.response?.status}): ${JSON.stringify(e.response?.data)}`);
    return { success: false, error: msg };
  }
};

/** Check transfer status — returns a V2 terminal/intermediate status string */
export const checkTransferStatus = async (transferId: string): Promise<string> => {
  try {
    const res = await axios.get(`${getBaseUrl()}/v2/transfers/${transferId}`, {
      headers: v2Headers(),
      timeout: 15000,
    });
    const status = res.data?.status || res.data?.transfer_status || 'UNKNOWN';
    return status.toUpperCase();
  } catch (err) {
    const e = err as AxiosError;
    logger.warn(`[Cashfree] checkTransferStatus failed (${e.response?.status})`);
    return 'UNKNOWN';
  }
};
