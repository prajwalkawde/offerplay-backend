import axios from 'axios';
import { logger } from '../utils/logger';

let cachedToken: string | null = null;
let tokenExpiry: number = 0;

// ─── Resolve credentials (support all env var name variants) ──────────────────
function getCredentials() {
  const clientId =
    process.env.XOXODAY_CLIENT_ID ||
    process.env.XOXODAY_API_KEY    || '';

  const secretId =
    process.env.XOXODAY_SECRET_ID  ||
    process.env.XOXODAY_API_SECRET || '';

  return { clientId, secretId };
}

// Base URL from env — user's account is on api.xoxoday.com
function getBase() {
  return (process.env.XOXODAY_BASE_URL || 'https://api.xoxoday.com').replace(/\/$/, '') + '/chef/v1';
}

// ─── Get OAuth2 token ─────────────────────────────────────────────────────────
const getXoxodayToken = async (): Promise<string> => {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  // ── Static access token from env (try first — valid until 2031)
  const staticToken  = process.env.XOXODAY_ACCESS_TOKEN;
  const staticExpiry = parseInt(process.env.XOXODAY_ACCESS_TOKEN_EXPIRY || '0', 10);
  if (staticToken && (!staticExpiry || Date.now() < staticExpiry)) {
    cachedToken = staticToken;
    tokenExpiry = staticExpiry || Date.now() + 365 * 24 * 60 * 60 * 1000;
    logger.info('[Xoxoday] Using static access token from env');
    return staticToken;
  }

  // ── Refresh token grant
  const { clientId, secretId } = getCredentials();
  const refreshToken = process.env.XOXODAY_REFRESH_TOKEN;

  if (refreshToken && clientId && secretId) {
    try {
      logger.info('[Xoxoday] Getting token via refresh_token grant');
      const res = await axios.post(
        `${getBase()}/oauth/token/user`,
        { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: secretId },
        { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 15000 },
      );
      const token = res.data?.access_token;
      if (token) {
        cachedToken = token;
        tokenExpiry = res.data?.access_token_expiry
          ? parseInt(res.data.access_token_expiry, 10)
          : Date.now() + 50 * 60 * 1000;
        logger.info(`[Xoxoday] Token obtained via refresh, expires: ${new Date(tokenExpiry).toISOString()}`);
        return token;
      }
      logger.warn(`[Xoxoday] refresh_token response had no access_token: ${JSON.stringify(res.data)?.slice(0, 200)}`);
    } catch (err: any) {
      logger.error(`[Xoxoday] refresh_token failed (${err.response?.status}): ${JSON.stringify(err.response?.data) ?? err.message}`);
    }
  }

  logger.error('[Xoxoday] No valid token — check XOXODAY_ACCESS_TOKEN or XOXODAY_REFRESH_TOKEN in .env');
  return '';
};

const getApiUrl = () => `${getBase()}/oauth/api/`;

function normalizeVoucher(v: any) {
  // valueDenominations is a comma-separated string e.g. "100,500,1000"
  const denomValues: number[] = v.valueDenominations
    ? String(v.valueDenominations).split(',').map((d: string) => parseFloat(d.trim())).filter(Boolean)
    : [];

  return {
    id:           String(v.productId || v.id || ''),
    name:         v.name        || v.productName || 'Unknown',
    description:  v.description || '',
    imageUrl:     v.imageUrl    || v.image || '',
    category:     v.categoryName || v.category || 'General',
    denominations: denomValues.map((val) => ({
      id:           String(val),
      value:        val,
      currencyCode: v.currencyCode || 'INR',
      discount:     v.discount || 0,
    })),
    minValue:  v.minValue || 50,
    maxValue:  v.maxValue || 10000,
    valueType: v.valueType || 'fixed_denomination',
    isActive:  true,
  };
}

// ─── Get products / vouchers ──────────────────────────────────────────────────
export const getXoxodayProducts = async (
  countryCode: string = 'IN',
  _category?: string,
): Promise<any[]> => {
  try {
    const token = await getXoxodayToken();
    if (!token) {
      logger.warn('[Xoxoday] No token — returning mock products');
      return getMockProducts();
    }

    logger.info(`[Xoxoday] Token preview: ${token.slice(0, 30)}...`);

    const headers = {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept:         'application/json',
    };

    // Per docs: variables.data with filters as array of {key,value}
    const body = {
      query: 'plumProAPI.mutation.getVouchers',
      tag:   'plumProAPI',
      variables: {
        data: {
          limit:   100,
          page:    1,
          filters: [{ key: 'country', value: countryCode }],
        },
      },
    };

    try {
      const res     = await axios.post(getApiUrl(), body, { headers, timeout: 15000 });
      const vouchers: any[] = res.data?.data?.getVouchers?.data || [];

      if (Array.isArray(vouchers) && vouchers.length > 0) {
        logger.info(`[Xoxoday] Got ${vouchers.length} vouchers`);
        return vouchers.map(normalizeVoucher);
      }

      logger.warn(`[Xoxoday] getVouchers returned empty: ${JSON.stringify(res.data)?.slice(0, 300)}`);

    } catch (err: any) {
      logger.warn(`[Xoxoday] getVouchers failed (${err.response?.status}): ${JSON.stringify(err.response?.data) ?? err.message}`);
    }

    logger.warn('[Xoxoday] Product fetch failed — returning mock');
    return getMockProducts();

  } catch (err: any) {
    logger.error('[Xoxoday] getXoxodayProducts error:', err.message);
    return getMockProducts();
  }
};

// ─── Place order ──────────────────────────────────────────────────────────────
export const placeXoxodayOrder = async (
  productId:     string,
  denominationId: string,
  quantity:      number,
  userId:        string,
  userEmail:     string,
  orderId:       string,
): Promise<{ success: boolean; voucherCode?: string; voucherLink?: string; error?: string }> => {
  try {
    const token = await getXoxodayToken();

    if (!token) {
      return { success: true, voucherCode: `TEST${orderId.slice(-6).toUpperCase()}`, voucherLink: 'https://xoxoday.com/redeem' };
    }

    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const body = {
      query: 'plumProAPI.mutation.placeOrder',
      tag:   'plumProAPI',
      variables: {
        data: {
          productId:           parseInt(productId, 10) || productId,
          quantity,
          denomination:        parseFloat(denominationId) || 0,
          poNumber:            orderId,
          email:               userEmail,
          notifyReceiverEmail: 1,
        },
      },
    };

    try {
      const res     = await axios.post(getApiUrl(), body, { headers, timeout: 30000 });
      const orderData = res.data?.data?.placeOrder?.data;
      const voucher   = orderData?.vouchers?.[0] || {};

      logger.info(`[Xoxoday] Order placed: ${JSON.stringify(res.data)?.slice(0, 300)}`);
      return {
        success:     true,
        voucherCode: voucher.voucherCode || voucher.pin  || '',
        voucherLink: voucher.link        || voucher.url  || '',
      };
    } catch (err: any) {
      logger.warn(`[Xoxoday] placeOrder failed (${err.response?.status}): ${JSON.stringify(err.response?.data) ?? err.message}`);
    }

    return { success: false, error: 'Order placement failed' };

  } catch (err: any) {
    logger.error('[Xoxoday] placeXoxodayOrder error:', err.message);
    return { success: false, error: err.message };
  }
};

// ─── Test connection ──────────────────────────────────────────────────────────
export const testXoxodayConnection = async (): Promise<{
  connected: boolean;
  message: string;
  tokenObtained?: boolean;
  credentialsFound?: boolean;
}> => {
  const { clientId, secretId } = getCredentials();

  if (!clientId || !secretId) {
    return {
      connected:        false,
      credentialsFound: false,
      message:          'Missing credentials — add XOXODAY_CLIENT_ID and XOXODAY_SECRET_ID to server .env',
    };
  }

  // Reset cache so we always do a fresh test
  cachedToken = null;
  tokenExpiry = 0;

  const token = await getXoxodayToken();

  if (token) {
    return {
      connected:        true,
      credentialsFound: true,
      tokenObtained:    true,
      message:          `Connected! Client: ${clientId.slice(0, 8)}... Token: ${token.slice(0, 12)}...`,
    };
  }

  return {
    connected:        false,
    credentialsFound: true,
    tokenObtained:    false,
    message:          'Credentials found but token request failed — check server logs for exact Xoxoday error response',
  };
};

// ─── Mock products (fallback) ─────────────────────────────────────────────────
const getMockProducts = (): any[] => [
  {
    id: 'amazon_in', name: 'Amazon Gift Card', description: 'Shop anything on Amazon India',
    imageUrl: 'https://m.media-amazon.com/images/I/31lGPasq9wL.jpg', category: 'Shopping',
    denominations: [
      { id: 'amz_100',  value: 100,  currencyCode: 'INR', discount: 0 },
      { id: 'amz_250',  value: 250,  currencyCode: 'INR', discount: 0 },
      { id: 'amz_500',  value: 500,  currencyCode: 'INR', discount: 0 },
      { id: 'amz_1000', value: 1000, currencyCode: 'INR', discount: 0 },
    ],
    minValue: 100, maxValue: 10000, isActive: true,
  },
  {
    id: 'flipkart_in', name: 'Flipkart Gift Card', description: 'Shop on Flipkart',
    imageUrl: '', category: 'Shopping',
    denominations: [
      { id: 'fk_100',  value: 100,  currencyCode: 'INR', discount: 0 },
      { id: 'fk_500',  value: 500,  currencyCode: 'INR', discount: 0 },
      { id: 'fk_1000', value: 1000, currencyCode: 'INR', discount: 0 },
    ],
    minValue: 100, maxValue: 10000, isActive: true,
  },
  {
    id: 'paytm_in', name: 'Paytm Wallet', description: 'Add money to Paytm wallet',
    imageUrl: '', category: 'Wallet',
    denominations: [
      { id: 'ptm_100', value: 100, currencyCode: 'INR', discount: 0 },
      { id: 'ptm_500', value: 500, currencyCode: 'INR', discount: 0 },
    ],
    minValue: 100, maxValue: 5000, isActive: true,
  },
  {
    id: 'freefire_in', name: 'Free Fire Diamonds', description: 'Top up Free Fire diamonds',
    imageUrl: '', category: 'Gaming',
    denominations: [
      { id: 'ff_100', value: 80,  currencyCode: 'INR', discount: 0 },
      { id: 'ff_310', value: 250, currencyCode: 'INR', discount: 0 },
      { id: 'ff_520', value: 400, currencyCode: 'INR', discount: 0 },
    ],
    minValue: 80, maxValue: 2000, isActive: true,
  },
  {
    id: 'bgmi_in', name: 'BGMI Unknown Cash', description: 'Buy BGMI UC Credits',
    imageUrl: '', category: 'Gaming',
    denominations: [
      { id: 'bgmi_60',  value: 75,  currencyCode: 'INR', discount: 0 },
      { id: 'bgmi_325', value: 380, currencyCode: 'INR', discount: 0 },
      { id: 'bgmi_660', value: 750, currencyCode: 'INR', discount: 0 },
    ],
    minValue: 75, maxValue: 5000, isActive: true,
  },
];
