import axios from 'axios';
import crypto from 'crypto';
import * as dotenv from 'dotenv';
dotenv.config();

const APP_ID = process.env.CPX_APP_ID || '';
const SECURE_HASH = process.env.CPX_SECURE_HASH || '';
const TEST_USER_ID = 'test_user_123';

async function testCPX() {
  console.log('=== CPX Research API Test ===');
  console.log('APP_ID:', APP_ID || '❌ MISSING');
  console.log('SECURE_HASH:', SECURE_HASH ? '✅ SET' : '❌ MISSING');
  console.log('');

  if (!APP_ID || !SECURE_HASH) {
    console.error('❌ Missing CPX credentials in .env!');
    console.log('Add these to .env:');
    console.log('CPX_APP_ID="your-app-id"');
    console.log('CPX_SECURE_HASH="your-hash-key"');
    return;
  }

  // Build hash
  const hash = crypto
    .createHash('md5')
    .update(`${TEST_USER_ID}-${SECURE_HASH}`)
    .digest('hex');

  console.log('Test User ID:', TEST_USER_ID);
  console.log('Generated Hash:', hash);
  console.log('');

  // Test 1: Get surveys via API
  console.log('Test 1: Fetching surveys from API...');
  try {
    const response = await axios.get(
      'https://live-api.cpx-research.com/api/get-surveys.php',
      {
        params: {
          app_id: APP_ID,
          ext_user_id: TEST_USER_ID,
          secure_hash: hash,
          output_method: 'api',
          ip_user: '103.21.58.1', // sample Indian IP for testing
        },
        timeout: 15000,
      }
    );

    console.log('Status:', response.status);
    console.log('Response data:', JSON.stringify(response.data, null, 2));

    if (response.data?.surveys) {
      console.log('✅ Surveys found:', response.data.surveys.length);
    } else if (response.data?.error) {
      console.log('❌ API Error:', response.data.error);
      console.log('Error message:', response.data.message || 'Unknown');
    } else {
      console.log('Response:', JSON.stringify(response.data, null, 2));
    }
  } catch (err: any) {
    console.error('❌ Request failed:');
    console.error('Status:', err.response?.status);
    console.error('Message:', err.message);
    console.error('Response:', JSON.stringify(err.response?.data, null, 2));
  }

  console.log('');

  // Test 2: Generate survey wall URL
  console.log('Test 2: Survey Wall URL:');
  const params = new URLSearchParams({
    app_id: APP_ID,
    ext_user_id: TEST_USER_ID,
    secure_hash: hash,
    subid_1: TEST_USER_ID,
  });
  const wallUrl = `https://offers.cpx-research.com/index.php?${params.toString()}`;
  console.log('URL:', wallUrl);
  console.log('');
  console.log('Open this URL in browser to see survey wall!');
}

testCPX().catch(console.error);
