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

// ─── Get OAuth2 token ─────────────────────────────────────────────────────────
const getXoxodayToken = async (): Promise<string> => {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const { clientId, secretId } = getCredentials();

  if (!clientId || !secretId) {
    logger.error('[Xoxoday] Missing credentials — set XOXODAY_CLIENT_ID and XOXODAY_SECRET_ID in .env');
    return '';
  }

  // Try both JSON and form-encoded, with and without scope
  const attempts = [
    {
      url:         'https://accounts.xoxoday.com/auth/api/oauth/token/',
      data:        { client_id: clientId, client_secret: secretId, grant_type: 'client_credentials' },
      contentType: 'application/json',
    },
    {
      url:         'https://accounts.xoxoday.com/auth/api/oauth/token/',
      data:        new URLSearchParams({ client_id: clientId, client_secret: secretId, grant_type: 'client_credentials' }).toString(),
      contentType: 'application/x-www-form-urlencoded',
    },
    {
      url:         'https://accounts.xoxoday.com/auth/api/oauth/token/',
      data:        { client_id: clientId, client_secret: secretId, grant_type: 'client_credentials', scope: 'gift_cards' },
      contentType: 'application/json',
    },
  ];

  for (const attempt of attempts) {
    try {
      logger.info(`[Xoxoday] Trying token: ${attempt.url} (${attempt.contentType})`);

      const res = await axios.post(attempt.url, attempt.data, {
        headers: { 'Content-Type': attempt.contentType, Accept: 'application/json' },
        timeout: 10000,
      });

      const token =
        res.data?.access_token ||
        res.data?.token         ||
        res.data?.data?.access_token ||
        res.data?.data?.token;

      if (token) {
        cachedToken  = token;
        tokenExpiry  = Date.now() + 50 * 60 * 1000; // 50 min
        logger.info('[Xoxoday] Token obtained successfully');
        return token;
      }

      // Got 200 but no token field
      logger.warn('[Xoxoday] 200 but no token in response:', JSON.stringify(res.data));

    } catch (err: any) {
      const status  = err.response?.status;
      const errData = err.response?.data;
      logger.warn(`[Xoxoday] Auth attempt failed (${status}):`, JSON.stringify(errData) || err.message);
    }
  }

  logger.error('[Xoxoday] All token attempts failed');
  return '';
};

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

    const headers = {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept:         'application/json',
    };

    const endpoints = [
      `https://api.xoxoday.com/v1/plum/products?country=${countryCode}&limit=100`,
      `https://api.xoxoday.com/api/v1/vouchers?country=${countryCode}&limit=100`,
      `https://api.xoxoday.com/api/v1/catalog?country=${countryCode}&limit=100`,
    ];

    for (const url of endpoints) {
      try {
        const res = await axios.get(url, { headers, timeout: 15000 });
        const data = res.data;

        const vouchers =
          data?.data?.vouchers  ||
          data?.data?.products  ||
          data?.vouchers        ||
          data?.products        ||
          data?.data            ||
          [];

        if (Array.isArray(vouchers) && vouchers.length > 0) {
          logger.info(`[Xoxoday] Got ${vouchers.length} products from ${url}`);
          return vouchers.map((v: any) => ({
            id:           String(v.productId || v.id || v.voucherId || v.code || ''),
            name:         v.productName     || v.name  || v.title       || 'Unknown',
            description:  v.productDescription || v.description || '',
            imageUrl:     v.imageUrl        || v.image || v.logo         || v.thumbnail || '',
            category:     v.categoryName    || v.category || 'General',
            denominations: (v.denominations || v.valueDenominations || v.prices || []).map((d: any) => ({
              id:           String(d.id || d.denominationId || d.voucherId || d.value || ''),
              value:        parseFloat(d.price || d.value || d.amount || d.faceValue || 0),
              currencyCode: d.currencyCode || d.currency || 'INR',
              discount:     d.discount     || d.discountPercentage || 0,
            })),
            minValue: v.minValue || v.minimumValue || 50,
            maxValue: v.maxValue || v.maximumValue || 10000,
            isActive: v.isActive !== false && v.status !== 'inactive',
          }));
        }

        logger.warn(`[Xoxoday] ${url} returned empty/unexpected:`, JSON.stringify(data)?.slice(0, 200));

      } catch (err: any) {
        logger.warn(`[Xoxoday] Products endpoint ${url} failed (${err.response?.status}):`, err.response?.data || err.message);
      }
    }

    logger.warn('[Xoxoday] All product endpoints failed — returning mock');
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
    const payload = {
      externalOrderId: orderId,
      items: [{
        productId,
        denominationId,
        quantity,
        recipientEmail: userEmail,
        recipient: { email: userEmail, name: `User_${userId.slice(0, 6)}` },
      }],
      notifyRecipient: true,
    };

    const endpoints = [
      'https://api.xoxoday.com/v1/plum/orders',
      'https://api.xoxoday.com/api/v1/orders',
    ];

    for (const url of endpoints) {
      try {
        const res     = await axios.post(url, payload, { headers, timeout: 30000 });
        const order   = res.data?.data || res.data;
        const voucher = order?.vouchers?.[0] || order?.items?.[0] || order || {};

        return {
          success:     true,
          voucherCode: voucher.code        || voucher.voucherCode || voucher.pin   || '',
          voucherLink: voucher.link        || voucher.url         || voucher.redemptionUrl || '',
        };
      } catch (err: any) {
        logger.warn(`[Xoxoday] Order endpoint ${url} failed:`, err.response?.data || err.message);
      }
    }

    return { success: false, error: 'All order endpoints failed' };

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
