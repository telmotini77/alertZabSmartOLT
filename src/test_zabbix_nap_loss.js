import assert from 'assert';
import fs from 'fs';
import path from 'path';

const cacheFile = path.resolve('data/.nap_cache.zabbix-nap-loss.test.json');
process.env.NODE_ENV = 'test';
process.env.SMARTOLT_SUBDOMAIN = 'testcompany';
process.env.SMARTOLT_API_KEY = 'test_key';
process.env.TELEGRAM_BOT_TOKEN = '123456:test_token';
process.env.TELEGRAM_CHAT_ID = '-100987654321';
process.env.NAP_CACHE_FILE = cacheFile;
process.env.NAP_LOSS_MIN_ONUS = '2';
process.env.SMARTOLT_REQUIRE_CORROBORATION = 'false';

const telegramMessages = [];
const onus = ['FHTTZAB00001', 'FHTTZAB00002'].map((sn, index) => ({
  sn,
  name: `Cliente ${index + 1}`,
  status: 'Online',
  odb_name: 'NAP-ZABBIX-1',
  olt_name: 'OLT-TEST',
  olt_id: '1',
  board: '2',
  port: '5',
  gps_lat: '-2.9110',
  gps_lng: '-78.9665'
}));

globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes('/sendMessage')) {
    telegramMessages.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  }
  if (String(url).includes('/onu/get_all_onus_details')) {
    return { ok: true, status: 200, json: async () => ({ status: true, onus }) };
  }
  throw new Error(`Unexpected request: ${url}`);
};

const { syncCacheWithSmartOlt, getCachedNaps } = await import('./services/cache.js');
const { processZabbixAlert } = await import('./routes/webhook.js');

try {
  await syncCacheWithSmartOlt();

  await processZabbixAlert({
    event_name: 'ONU FHTTZAB00001: Loss of Signal',
    host_name: 'OLT-TEST',
    event_status: 'PROBLEM',
    event_severity: 'High'
  });
  await processZabbixAlert({
    event_name: 'ONU FHTTZAB00002: Loss of Signal',
    host_name: 'OLT-TEST',
    event_status: 'PROBLEM',
    event_severity: 'High'
  });
  await processZabbixAlert({
    event_name: 'ONU FHTTZAB00002: Loss of Signal',
    host_name: 'OLT-TEST',
    event_status: 'PROBLEM',
    event_severity: 'High'
  });
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.strictEqual(telegramMessages.length, 1, 'Two LOS events for one NAP must send one consolidated alert');
  const message = telegramMessages[0].text;
  assert.ok(message.includes('NAP-ZABBIX-1'), 'The cache-backed alert must identify the NAP');
  assert.ok(message.includes('maps.google.com'), 'The cache-backed alert must include its approximate location');
  assert.strictEqual(getCachedNaps()[0].status, 'offline', 'The NAP must be fully offline in cache');

  console.log('Zabbix cache-backed total NAP LOS alert: PASS');
} catch (error) {
  console.error('Zabbix cache-backed total NAP LOS alert: FAIL', error);
  process.exitCode = 1;
} finally {
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
}
