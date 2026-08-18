import assert from 'assert';
import fs from 'fs';
import path from 'path';

const cacheFile = path.resolve('data/.nap_cache.scanner.test.json');
process.env.SMARTOLT_SUBDOMAIN = 'testcompany';
process.env.SMARTOLT_API_KEY = 'test_key';
process.env.TELEGRAM_BOT_TOKEN = '123456:test_token';
process.env.TELEGRAM_CHAT_ID = '-100987654321';
process.env.NAP_CACHE_FILE = cacheFile;
process.env.NAP_LOSS_MIN_ONUS = '2';

let allOffline = false;
const telegramMessages = [];

const onus = () => ['FHTTTEST0001', 'FHTTTEST0002'].map((sn, index) => ({
  sn,
  name: `Cliente ${index + 1}`,
  status: allOffline ? 'Offline' : 'Online',
  odb_name: 'NAP-TEST-1',
  olt_name: 'OLT-TEST',
  olt_id: '1',
  board: '2',
  port: '5',
  gps_lat: '-2.9110',
  gps_lng: '-78.9665',
  offline_reason: 'Loss of Signal'
}));

globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes('/sendMessage')) {
    telegramMessages.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  }

  if (String(url).includes('/onu/get_all_onus_details')) {
    return { ok: true, status: 200, json: async () => ({ status: true, onus: onus() }) };
  }

  throw new Error(`Unexpected request: ${url}`);
};

const { syncCacheWithSmartOlt, getCachedNaps } = await import('./services/cache.js');
const { runScanCycle } = await import('./services/scanner.js');

try {
  await syncCacheWithSmartOlt();

  // First scan establishes the baseline and must not alert for existing data.
  await runScanCycle();
  assert.strictEqual(telegramMessages.length, 0, 'The baseline scan must not send a false alert');

  // Smart OLT alone updates the map but does not notify Telegram. A NAP alert
  // requires the matching fresh LOS events from Zabbix as corroboration.
  allOffline = true;
  await runScanCycle();

  assert.strictEqual(telegramMessages.length, 0, 'Smart OLT-only outages must wait for Zabbix corroboration');
  assert.strictEqual(getCachedNaps()[0].status, 'offline', 'The cached NAP status must be fully offline');

  console.log('Smart OLT NAP outage waits for Zabbix corroboration: PASS');
} catch (error) {
  console.error('Total NAP LOS scanner alert: FAIL', error);
  process.exitCode = 1;
} finally {
  // Status snapshots persist with a debounced write. Let it finish before
  // cleaning the isolated test file so it cannot be recreated after cleanup.
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
}
