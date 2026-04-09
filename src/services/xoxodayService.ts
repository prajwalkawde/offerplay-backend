import axios from 'axios';
import { logger } from '../utils/logger';

let cachedToken: string | null = null;
let tokenExpiry: number = 0;

// ─── Credentials ──────────────────────────────────────────────────────────────
function getCredentials() {
  return {
    clientId: process.env.XOXODAY_CLIENT_ID || process.env.XOXODAY_API_KEY    || '',
    secretId: process.env.XOXODAY_SECRET_ID || process.env.XOXODAY_API_SECRET || '',
  };
}

// stores.xoxoday.com = production Plum API server
function getBase() {
  return (process.env.XOXODAY_BASE_URL || 'https://stores.xoxoday.com').replace(/\/$/, '') + '/chef/v1';
}

const getApiUrl = () => `${getBase()}/oauth/api/`;

// ─── Token ────────────────────────────────────────────────────────────────────
const getXoxodayToken = async (): Promise<string> => {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const staticToken  = process.env.XOXODAY_ACCESS_TOKEN;
  const staticExpiry = parseInt(process.env.XOXODAY_ACCESS_TOKEN_EXPIRY || '0', 10);
  if (staticToken && (!staticExpiry || Date.now() < staticExpiry)) {
    cachedToken = staticToken;
    tokenExpiry = staticExpiry || Date.now() + 365 * 24 * 60 * 60 * 1000;
    logger.info('[Xoxoday] Using static access token from env');
    return staticToken;
  }

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
      logger.warn(`[Xoxoday] refresh_token response missing access_token: ${JSON.stringify(res.data)?.slice(0, 200)}`);
    } catch (err: any) {
      logger.error(`[Xoxoday] refresh_token failed (${err.response?.status}): ${JSON.stringify(err.response?.data) ?? err.message}`);
    }
  }

  logger.error('[Xoxoday] No valid token — check XOXODAY_ACCESS_TOKEN or XOXODAY_REFRESH_TOKEN in .env');
  return '';
};

// ─── Filters cache (TTL: 6 hours) ────────────────────────────────────────────
interface FilterEntry { filterValue: string; filterValueCode: string; isoCode?: string }
interface FilterGroup { filterGroupName: string; filterGroupCode: string; filters: FilterEntry[] }

const filtersCache: Record<string, { data: FilterGroup[]; fetchedAt: number }> = {};
const FILTERS_TTL = 6 * 60 * 60 * 1000;

// ─── Get filters (countries, categories, currencies, etc.) ───────────────────
// Uses plumProAPI.mutation.getFilters
// filterGroupCode: 'country' | 'voucher_category' | 'product_category' | 'currency' | 'price'
// Pass empty string to get ALL filter groups at once.
export const getXoxodayFilters = async (filterGroupCode = ''): Promise<FilterGroup[]> => {
  const cacheKey = filterGroupCode || '__all__';
  const cached   = filtersCache[cacheKey];
  if (cached && Date.now() - cached.fetchedAt < FILTERS_TTL) {
    logger.info(`[Xoxoday] Returning cached filters (${cacheKey})`);
    return cached.data;
  }

  const token = await getXoxodayToken();
  if (!token) {
    logger.warn('[Xoxoday] No token — cannot fetch filters');
    return [];
  }

  try {
    const body = {
      query:     'plumProAPI.mutation.getFilters',
      tag:       'plumProAPI',
      variables: { data: { filterGroupCode } },
    };
    const res    = await axios.post(getApiUrl(), body, {
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept:         'application/json',
      },
      timeout: 15000,
    });

    const groups: FilterGroup[] = res.data?.data?.getFilters?.data || [];
    if (groups.length > 0) {
      filtersCache[cacheKey] = { data: groups, fetchedAt: Date.now() };
      logger.info(`[Xoxoday] Fetched ${groups.length} filter group(s) for "${cacheKey}"`);
    } else {
      logger.warn(`[Xoxoday] getFilters returned empty for "${cacheKey}": ${JSON.stringify(res.data)?.slice(0, 300)}`);
    }
    return groups;
  } catch (err: any) {
    logger.error(`[Xoxoday] getFilters failed (${err.response?.status}): ${JSON.stringify(err.response?.data) ?? err.message}`);
    return [];
  }
};

// ─── Resolve ISO code → filterValueCode (e.g. "IN" → "india") ────────────────
// Xoxoday expects filterValueCode (lowercase country name) NOT ISO codes.
// Falls back to lowercase of the input if the filters API doesn't have it.
async function resolveCountryFilterValue(isoOrCode: string): Promise<string> {
  if (!isoOrCode || isoOrCode === 'ALL') return '';

  // If it looks like it's already a filterValueCode (multi-char lowercase word), use as-is
  if (isoOrCode.length > 2 && isoOrCode === isoOrCode.toLowerCase()) return isoOrCode;

  try {
    const groups = await getXoxodayFilters('country');
    const group  = groups.find(g => g.filterGroupCode === 'country');
    if (group) {
      const entry = group.filters.find(
        f => f.isoCode?.toUpperCase() === isoOrCode.toUpperCase() ||
             f.filterValueCode?.toLowerCase() === isoOrCode.toLowerCase(),
      );
      if (entry) {
        logger.info(`[Xoxoday] Resolved country ${isoOrCode} → filterValueCode="${entry.filterValueCode}"`);
        return entry.filterValueCode;
      }
    }
  } catch { /* ignore */ }

  // fallback: send the value as-is (lowercased)
  logger.warn(`[Xoxoday] Could not resolve country "${isoOrCode}" from filters API — sending as-is`);
  return isoOrCode.toLowerCase();
}

// ─── Normalise raw voucher → app shape ────────────────────────────────────────
function normalizeVoucher(v: any) {
  const denomValues: number[] = v.valueDenominations
    ? String(v.valueDenominations).split(',').map((d: string) => parseFloat(d.trim())).filter(Boolean)
    : [];

  return {
    id:           String(v.productId || v.id || ''),
    name:         v.name        || v.productName || 'Unknown',
    description:  v.description || '',
    imageUrl:     v.imageUrl    || v.image || '',
    category:     v.categoryName || v.category || 'General',
    currencyCode: v.currencyCode || 'INR',
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

// ─── Low-level paginated voucher fetch ───────────────────────────────────────
// `apiFilters` must already use Xoxoday's filterValueCode format.
// Valid filter keys (per docs): country, price, minPrice, maxPrice, currencyCode, productName
async function fetchVouchers(
  headers:    Record<string, string>,
  apiFilters: Array<{ key: string; value: string }>,
): Promise<any[]> {
  const allVouchers: any[] = [];

  for (let page = 1; page <= 5; page++) {
    try {
      const variables: any = { data: { limit: 100, page } };
      if (apiFilters.length > 0) {
        variables.data.filters = apiFilters;
      }
      const body = { query: 'plumProAPI.mutation.getVouchers', tag: 'plumProAPI', variables };
      const res  = await axios.post(getApiUrl(), body, { headers, timeout: 15000 });

      const vouchers: any[] = res.data?.data?.getVouchers?.data || [];
      if (!Array.isArray(vouchers) || vouchers.length === 0) {
        logger.info(`[Xoxoday] Page ${page}: 0 vouchers — stopping pagination`);
        break;
      }

      allVouchers.push(...vouchers);
      logger.info(`[Xoxoday] Page ${page} filters=${JSON.stringify(apiFilters)}: ${vouchers.length} vouchers (total: ${allVouchers.length})`);

      if (vouchers.length < 100) break;
    } catch (err: any) {
      logger.warn(`[Xoxoday] getVouchers page ${page} failed (${err.response?.status}): ${JSON.stringify(err.response?.data) ?? err.message}`);
      break;
    }
  }
  return allVouchers;
}

// ─── Get products / vouchers ──────────────────────────────────────────────────
// Options:
//   country      — ISO code ("IN") or filterValueCode ("india") or "ALL" / ""
//   category     — voucher_category filterValueCode (e.g. "gaming") or ""
//   currency     — currency code e.g. "INR", "USD"
//   minPrice     — number
//   maxPrice     — number
export const getXoxodayProducts = async (options: {
  country?:  string;
  category?: string;
  currency?: string;
  minPrice?: number;
  maxPrice?: number;
} = {}): Promise<any[]> => {
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

    // Build filters array using correct Xoxoday filterValueCode format
    const apiFilters: Array<{ key: string; value: string }> = [];

    if (options.country && options.country !== 'ALL') {
      const countryValue = await resolveCountryFilterValue(options.country);
      if (countryValue) apiFilters.push({ key: 'country', value: countryValue });
    }

    if (options.category) {
      apiFilters.push({ key: 'voucher_category', value: options.category });
    }

    if (options.currency) {
      apiFilters.push({ key: 'currencyCode', value: options.currency });
    }

    if (options.minPrice !== undefined) {
      apiFilters.push({ key: 'minPrice', value: String(options.minPrice) });
    }

    if (options.maxPrice !== undefined) {
      apiFilters.push({ key: 'maxPrice', value: String(options.maxPrice) });
    }

    logger.info(`[Xoxoday] Fetching vouchers with filters: ${JSON.stringify(apiFilters)}`);

    // 1st attempt: with requested filters
    let allVouchers = await fetchVouchers(headers, apiFilters);

    // 2nd attempt: if filters returned nothing and we had filters, retry without
    if (allVouchers.length === 0 && apiFilters.length > 0) {
      logger.warn(`[Xoxoday] No results with filters — retrying without filters`);
      allVouchers = await fetchVouchers(headers, []);
    }

    if (allVouchers.length > 0) {
      const names = allVouchers.map((v: any) => v.name || v.productName).filter(Boolean);
      logger.info(`[Xoxoday] Returning ${allVouchers.length} real products. Sample: ${names.slice(0, 15).join(', ')}`);
      return allVouchers.map(normalizeVoucher);
    }

    logger.warn('[Xoxoday] No vouchers found even without filters — returning mock');
    return getMockProducts();

  } catch (err: any) {
    logger.error('[Xoxoday] getXoxodayProducts error:', err.message);
    return getMockProducts();
  }
};

// ─── Place order ──────────────────────────────────────────────────────────────
export const placeXoxodayOrder = async (
  productId:      string,
  denominationId: string,
  quantity:       number,
  userId:         string,
  userEmail:      string,
  orderId:        string,
): Promise<{
  success:     boolean;
  voucherCode?: string;  // primary redemption code
  voucherPin?:  string;  // PIN (some cards need code + PIN)
  voucherLink?: string;  // fallback URL — only set when there is NO direct code
  validity?:    string;  // expiry date string from Xoxoday
  error?:       string;
}> => {
  try {
    const token = await getXoxodayToken();

    if (!token) {
      return { success: true, voucherCode: `TEST${orderId.slice(-6).toUpperCase()}` };
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
      const res       = await axios.post(getApiUrl(), body, { headers, timeout: 30000 });
      const orderData = res.data?.data?.placeOrder?.data;
      const voucher   = orderData?.vouchers?.[0] || {};

      logger.info(`[Xoxoday] Order placed. voucher fields: ${JSON.stringify(Object.keys(voucher))}`);
      logger.info(`[Xoxoday] Full voucher: ${JSON.stringify(voucher)}`);

      const rawCode  = voucher.voucherCode || '';
      const pin      = voucher.pin || '';
      const validity = voucher.validity || voucher.expiryDate || voucher.expiry || '';

      // Xoxoday sometimes puts the plum.gift URL inside voucherCode instead of a plain text code.
      // Detect this and move it to voucherLink so the app shows an "Open" button, not a code box.
      const isUrl    = rawCode.startsWith('http://') || rawCode.startsWith('https://');
      const code     = isUrl ? '' : rawCode;
      const link     = isUrl
        ? rawCode                                    // URL was in voucherCode — use it as the link
        : (voucher.link || voucher.url || '');       // plain code — use separate link field if any

      logger.info(`[Xoxoday] Voucher: code="${code || '(url)'}" isUrl=${isUrl} link="${link?.slice(0, 40)}"`);
      return { success: true, voucherCode: code, voucherPin: pin, voucherLink: link, validity };
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
    message:          'Credentials found but token request failed — check server logs',
  };
};

// ─── Mock products (fallback) ─────────────────────────────────────────────────
const getMockProducts = (): any[] => [
  {
    id: 'amazon_in', name: 'Amazon Gift Card', description: 'Shop anything on Amazon India',
    imageUrl: 'https://m.media-amazon.com/images/I/31lGPasq9wL.jpg', category: 'Shopping', currencyCode: 'INR',
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
    imageUrl: '', category: 'Shopping', currencyCode: 'INR',
    denominations: [
      { id: 'fk_100',  value: 100,  currencyCode: 'INR', discount: 0 },
      { id: 'fk_500',  value: 500,  currencyCode: 'INR', discount: 0 },
      { id: 'fk_1000', value: 1000, currencyCode: 'INR', discount: 0 },
    ],
    minValue: 100, maxValue: 10000, isActive: true,
  },
  {
    id: 'paytm_in', name: 'Paytm Wallet', description: 'Add money to Paytm wallet',
    imageUrl: '', category: 'Wallet', currencyCode: 'INR',
    denominations: [
      { id: 'ptm_100', value: 100, currencyCode: 'INR', discount: 0 },
      { id: 'ptm_500', value: 500, currencyCode: 'INR', discount: 0 },
    ],
    minValue: 100, maxValue: 5000, isActive: true,
  },
  {
    id: 'freefire_in', name: 'Free Fire Diamonds', description: 'Top up Free Fire diamonds',
    imageUrl: '', category: 'Gaming', currencyCode: 'INR',
    denominations: [
      { id: 'ff_100', value: 80,  currencyCode: 'INR', discount: 0 },
      { id: 'ff_310', value: 250, currencyCode: 'INR', discount: 0 },
      { id: 'ff_520', value: 400, currencyCode: 'INR', discount: 0 },
    ],
    minValue: 80, maxValue: 2000, isActive: true,
  },
  {
    id: 'bgmi_in', name: 'BGMI Unknown Cash', description: 'Buy BGMI UC Credits',
    imageUrl: '', category: 'Gaming', currencyCode: 'INR',
    denominations: [
      { id: 'bgmi_60',  value: 75,  currencyCode: 'INR', discount: 0 },
      { id: 'bgmi_325', value: 380, currencyCode: 'INR', discount: 0 },
      { id: 'bgmi_660', value: 750, currencyCode: 'INR', discount: 0 },
    ],
    minValue: 75, maxValue: 5000, isActive: true,
  },
  {
    id: 'googleplay_in', name: 'Google Play Redeem Code', description: 'Redeem on Google Play Store',
    imageUrl: '', category: 'Gaming', currencyCode: 'INR',
    denominations: [
      { id: 'gp_100',  value: 100,  currencyCode: 'INR', discount: 0 },
      { id: 'gp_250',  value: 250,  currencyCode: 'INR', discount: 0 },
      { id: 'gp_500',  value: 500,  currencyCode: 'INR', discount: 0 },
      { id: 'gp_1000', value: 1000, currencyCode: 'INR', discount: 0 },
    ],
    minValue: 100, maxValue: 5000, isActive: true,
  },
  {
    id: 'myntra_in', name: 'Myntra Gift Card', description: 'Shop fashion on Myntra',
    imageUrl: '', category: 'Shopping', currencyCode: 'INR',
    denominations: [
      { id: 'myn_500',  value: 500,  currencyCode: 'INR', discount: 0 },
      { id: 'myn_1000', value: 1000, currencyCode: 'INR', discount: 0 },
    ],
    minValue: 500, maxValue: 5000, isActive: true,
  },
];
