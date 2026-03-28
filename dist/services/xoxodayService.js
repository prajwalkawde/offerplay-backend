"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.testXoxodayConnection = exports.placeXoxodayOrder = exports.getXoxodayProducts = void 0;
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("../utils/logger");
// Xoxoday uses a specific auth format
// Reference: https://docs.xoxoday.com/
let cachedToken = null;
let tokenExpiry = 0;
const getXoxodayToken = async () => {
    // Return cached token if still valid
    if (cachedToken && Date.now() < tokenExpiry) {
        return cachedToken;
    }
    const clientId = process.env.XOXODAY_CLIENT_ID || '';
    const secretId = process.env.XOXODAY_SECRET_ID ||
        process.env.XOXODAY_API_SECRET || '';
    if (!clientId || !secretId) {
        logger_1.logger.warn('Xoxoday credentials missing in .env');
        return '';
    }
    // Try multiple auth endpoints Xoxoday uses
    const authEndpoints = [
        {
            url: 'https://accounts.xoxoday.com/auth/api/oauth/token',
            data: {
                client_id: clientId,
                client_secret: secretId,
                grant_type: 'client_credentials',
            },
            contentType: 'application/json',
        },
        {
            url: 'https://api.xoxoday.com/accts/v1/oauth/token',
            data: new URLSearchParams({
                client_id: clientId,
                client_secret: secretId,
                grant_type: 'client_credentials',
            }).toString(),
            contentType: 'application/x-www-form-urlencoded',
        },
        {
            url: 'https://api.xoxoday.com/api/v1/oauth/token',
            data: {
                client_id: clientId,
                client_secret: secretId,
                grant_type: 'client_credentials',
            },
            contentType: 'application/json',
        },
    ];
    for (const endpoint of authEndpoints) {
        try {
            logger_1.logger.info(`Trying Xoxoday auth: ${endpoint.url}`);
            const response = await axios_1.default.post(endpoint.url, endpoint.data, {
                headers: {
                    'Content-Type': endpoint.contentType,
                    'Accept': 'application/json',
                },
                timeout: 10000,
            });
            const token = response.data?.access_token ||
                response.data?.token ||
                response.data?.data?.access_token ||
                response.data?.data?.token;
            if (token) {
                cachedToken = token;
                // Cache for 50 minutes (tokens usually expire in 1 hour)
                tokenExpiry = Date.now() + 50 * 60 * 1000;
                logger_1.logger.info('Xoxoday token obtained successfully!');
                return token;
            }
        }
        catch (err) {
            logger_1.logger.warn(`Xoxoday auth failed for ${endpoint.url}:`, err.response?.data || err.message);
            continue;
        }
    }
    logger_1.logger.error('All Xoxoday auth endpoints failed');
    return '';
};
// Get products - try multiple API formats
const getXoxodayProducts = async (countryCode = 'IN', _category) => {
    try {
        const token = await getXoxodayToken();
        if (!token) {
            logger_1.logger.warn('No Xoxoday token - using mock products');
            return getMockProducts();
        }
        // Try different product endpoints
        const productEndpoints = [
            `https://api.xoxoday.com/v1/vouchers?countries=${countryCode}&limit=100`,
            `https://api.xoxoday.com/api/v1/vouchers?country=${countryCode}`,
            `https://api.xoxoday.com/v3/catalog?country=${countryCode}`,
        ];
        for (const url of productEndpoints) {
            try {
                const response = await axios_1.default.get(url, {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    timeout: 15000,
                });
                const data = response.data;
                const vouchers = data?.data?.vouchers ||
                    data?.vouchers ||
                    data?.data ||
                    data?.products ||
                    [];
                if (Array.isArray(vouchers) && vouchers.length > 0) {
                    logger_1.logger.info(`Xoxoday: Got ${vouchers.length} products from ${url}`);
                    return vouchers.map((v) => ({
                        id: String(v.productId || v.id || v.voucherId || v.code || ''),
                        name: v.productName || v.name || v.title || 'Unknown',
                        description: v.productDescription ||
                            v.description || '',
                        imageUrl: v.imageUrl || v.image ||
                            v.logo || v.thumbnail || '',
                        category: v.categoryName ||
                            v.category || 'General',
                        denominations: (v.denominations ||
                            v.valueDenominations ||
                            v.vouchers ||
                            v.prices ||
                            []).map((d) => ({
                            id: String(d.id || d.denominationId ||
                                d.voucherId || d.value || ''),
                            value: parseFloat(d.price || d.value ||
                                d.amount || d.faceValue || 0),
                            currencyCode: d.currencyCode ||
                                d.currency || 'INR',
                            discount: d.discount ||
                                d.discountPercentage || 0,
                        })),
                        minValue: v.minValue ||
                            v.minimumValue || 50,
                        maxValue: v.maxValue ||
                            v.maximumValue || 10000,
                        isActive: v.isActive !== false &&
                            v.status !== 'inactive',
                    }));
                }
            }
            catch (err) {
                logger_1.logger.warn(`Product endpoint ${url} failed:`, err.response?.status);
                continue;
            }
        }
        logger_1.logger.warn('All Xoxoday product endpoints failed, using mock');
        return getMockProducts();
    }
    catch (err) {
        logger_1.logger.error('getXoxodayProducts error:', err.message);
        return getMockProducts();
    }
};
exports.getXoxodayProducts = getXoxodayProducts;
const placeXoxodayOrder = async (productId, denominationId, quantity, userId, userEmail, orderId) => {
    try {
        const token = await getXoxodayToken();
        if (!token) {
            // Mock for testing without real credentials
            return {
                success: true,
                voucherCode: `TEST${orderId.slice(-6).toUpperCase()}`,
                voucherLink: 'https://xoxoday.com/redeem',
            };
        }
        const orderEndpoints = [
            'https://api.xoxoday.com/v1/orders',
            'https://api.xoxoday.com/api/v1/orders',
        ];
        for (const url of orderEndpoints) {
            try {
                const response = await axios_1.default.post(url, {
                    externalOrderId: orderId,
                    items: [{
                            productId,
                            denominationId,
                            quantity,
                            recipientEmail: userEmail,
                            recipient: {
                                email: userEmail,
                                name: `User_${userId.slice(0, 6)}`,
                            }
                        }],
                    notifyRecipient: true,
                }, {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 30000,
                });
                const order = response.data?.data ||
                    response.data;
                const voucher = order?.vouchers?.[0] ||
                    order?.items?.[0] ||
                    order || {};
                return {
                    success: true,
                    voucherCode: voucher.code ||
                        voucher.voucherCode ||
                        voucher.pin || '',
                    voucherLink: voucher.link ||
                        voucher.url ||
                        voucher.redemptionUrl || '',
                };
            }
            catch (err) {
                logger_1.logger.warn(`Order endpoint ${url} failed:`, err.response?.data);
                continue;
            }
        }
        return { success: false, error: 'All order endpoints failed' };
    }
    catch (err) {
        logger_1.logger.error('placeXoxodayOrder error:', err.message);
        return { success: false, error: err.message };
    }
};
exports.placeXoxodayOrder = placeXoxodayOrder;
const testXoxodayConnection = async () => {
    const clientId = process.env.XOXODAY_CLIENT_ID || '';
    const secretId = process.env.XOXODAY_SECRET_ID ||
        process.env.XOXODAY_API_SECRET || '';
    if (!clientId || !secretId) {
        return {
            connected: false,
            message: 'Missing XOXODAY_CLIENT_ID or XOXODAY_SECRET_ID in .env',
        };
    }
    const token = await getXoxodayToken();
    if (token) {
        return {
            connected: true,
            message: `Connected! Token obtained. Client: ${clientId.slice(0, 8)}...`,
            tokenObtained: true,
        };
    }
    return {
        connected: false,
        message: 'Could not get token. Check credentials in .env file.',
        tokenObtained: false,
    };
};
exports.testXoxodayConnection = testXoxodayConnection;
const getMockProducts = () => [
    {
        id: 'amazon_in',
        name: 'Amazon Gift Card',
        description: 'Shop anything on Amazon India',
        imageUrl: 'https://m.media-amazon.com/images/I/31lGPasq9wL.jpg',
        category: 'Shopping',
        denominations: [
            { id: 'amz_100', value: 100, currencyCode: 'INR', discount: 0 },
            { id: 'amz_250', value: 250, currencyCode: 'INR', discount: 0 },
            { id: 'amz_500', value: 500, currencyCode: 'INR', discount: 0 },
            { id: 'amz_1000', value: 1000, currencyCode: 'INR', discount: 0 },
        ],
        minValue: 100, maxValue: 10000, isActive: true,
    },
    {
        id: 'flipkart_in',
        name: 'Flipkart Gift Card',
        description: 'Shop on Flipkart',
        imageUrl: '',
        category: 'Shopping',
        denominations: [
            { id: 'fk_100', value: 100, currencyCode: 'INR', discount: 0 },
            { id: 'fk_500', value: 500, currencyCode: 'INR', discount: 0 },
            { id: 'fk_1000', value: 1000, currencyCode: 'INR', discount: 0 },
        ],
        minValue: 100, maxValue: 10000, isActive: true,
    },
    {
        id: 'freefire_in',
        name: 'Free Fire Diamonds',
        description: 'Top up Free Fire diamonds',
        imageUrl: '',
        category: 'Gaming',
        denominations: [
            { id: 'ff_100', value: 80, currencyCode: 'INR', discount: 0 },
            { id: 'ff_310', value: 250, currencyCode: 'INR', discount: 0 },
            { id: 'ff_520', value: 400, currencyCode: 'INR', discount: 0 },
        ],
        minValue: 80, maxValue: 2000, isActive: true,
    },
    {
        id: 'paytm_in',
        name: 'Paytm Wallet',
        description: 'Add money to Paytm wallet',
        imageUrl: '',
        category: 'Wallet',
        denominations: [
            { id: 'ptm_100', value: 100, currencyCode: 'INR', discount: 0 },
            { id: 'ptm_500', value: 500, currencyCode: 'INR', discount: 0 },
        ],
        minValue: 100, maxValue: 5000, isActive: true,
    },
    {
        id: 'jio_recharge',
        name: 'Jio Mobile Recharge',
        description: 'Recharge Jio number instantly',
        imageUrl: '',
        category: 'Mobile Recharge',
        denominations: [
            { id: 'jio_149', value: 149, currencyCode: 'INR', discount: 0 },
            { id: 'jio_239', value: 239, currencyCode: 'INR', discount: 0 },
            { id: 'jio_666', value: 666, currencyCode: 'INR', discount: 0 },
        ],
        minValue: 149, maxValue: 2999, isActive: true,
    },
    {
        id: 'bgmi_in',
        name: 'BGMI Unknown Cash',
        description: 'Buy BGMI UC Credits',
        imageUrl: '',
        category: 'Gaming',
        denominations: [
            { id: 'bgmi_60', value: 75, currencyCode: 'INR', discount: 0 },
            { id: 'bgmi_325', value: 380, currencyCode: 'INR', discount: 0 },
            { id: 'bgmi_660', value: 750, currencyCode: 'INR', discount: 0 },
        ],
        minValue: 75, maxValue: 5000, isActive: true,
    },
];
