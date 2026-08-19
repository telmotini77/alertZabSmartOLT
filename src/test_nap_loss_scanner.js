import assert from 'assert';
import fs from 'fs';
import path from 'path';

const cacheFile = path.resolve('data/.nap_cache.scanner.test.json');
process.env.NODE_ENV = 'test';
process.env.SMARTOLT_SUBDOMAIN = 'testcompany';
process.env.SMARTOLT_API_KEY = 'test_key';
process.env.TELEGRAM_BOT_TOKEN = '123456:test_token';
process.env.TELEGRAM_CHAT_ID = '-100987654321';
process.env.TELEGRAM_ADDITIONAL_CHAT_IDS = '';
process.env.NAP_CACHE_FILE = cacheFile;
process.env.NAP_LOSS_MIN_ONUS = '2';

let statuses = ['Online', 'Online'];
let failureReason = 'Loss of Signal';
const telegramMessages = [];

const onus = () => ['FHTTTEST0001', 'FHTTTEST0002'].map((sn, index) => ({
  sn,
  name: `Cliente ${index + 1}`,
  status: statuses[index],
  odb_name: 'NAP-TEST-1',
  olt_name: 'OLT-TEST',
  olt_id: '1',
  board: '2',
  port: '5',
  gps_lat: '-2.9110',
  gps_lng: '-78.9665',
  offline_reason: statuses[index] === 'Offline' ? failureReason : ''
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

  // A full NAP transition with LOS must generate one fallback notification
  // even when Zabbix did not emit the expected events.
  statuses = ['Offline', 'Offline'];
  await runScanCycle();

  assert.strictEqual(telegramMessages.length, 1, 'Smart OLT must deliver a full-NAP LOS fallback alert');
  const lossMessage = telegramMessages[0].text;
  assert.ok(lossMessage.includes('Pérdida de señal'));
  assert.ok(lossMessage.includes('Cliente 1') && lossMessage.includes('Cliente 2'));
  assert.ok(lossMessage.includes('Fecha y hora:'));
  assert.ok(lossMessage.includes('Sin evento oportuno'));
  assert.ok(!lossMessage.includes('FHTTTEST0001') && !lossMessage.includes('FHTTTEST0002'));
  assert.strictEqual(getCachedNaps()[0].status, 'offline', 'The cached NAP status must be fully offline');

  // Repeated scans while the same NAP remains down must not duplicate alerts.
  await runScanCycle();
  assert.strictEqual(telegramMessages.length, 1, 'The same active NAP outage must not be sent twice');

  // Recovery rearms the incident, then one Dying Gasp on a single router must
  // produce a separate Power Fail notification.
  statuses = ['Online', 'Online'];
  await runScanCycle();
  failureReason = 'Dying Gasp';
  statuses = ['Offline', 'Online'];
  await runScanCycle();

  assert.strictEqual(telegramMessages.length, 2, 'An individual electrical outage must send a Power Fail fallback alert');
  const powerMessage = telegramMessages[1].text;
  assert.ok(powerMessage.includes('Corte de energía'));
  assert.ok(powerMessage.includes('Cliente 1'));
  assert.ok(powerMessage.includes('Fecha y hora:'));
  assert.ok(!powerMessage.includes('FHTTTEST0001'));

  // A sector-wide electrical outage must remain Power Fail and must never be
  // relabelled as a fibre cut merely because the complete NAP is offline.
  statuses = ['Online', 'Online'];
  await runScanCycle();
  statuses = ['Offline', 'Offline'];
  await runScanCycle();
  assert.strictEqual(telegramMessages.length, 3, 'A full-NAP electrical outage must send one consolidated alert');
  const totalPowerMessage = telegramMessages[2].text;
  assert.ok(totalPowerMessage.includes('Corte de energía'));
  assert.ok(!totalPowerMessage.includes('Pérdida de señal (LOS)'));
  assert.ok(totalPowerMessage.includes('Cliente 1') && totalPowerMessage.includes('Cliente 2'));

  console.log('Smart OLT fallback delivery for NAP LOS and individual Power Fail: PASS');
} catch (error) {
  console.error('Total NAP LOS scanner alert: FAIL', error);
  process.exitCode = 1;
} finally {
  // Status snapshots persist with a debounced write. Let it finish before
  // cleaning the isolated test file so it cannot be recreated after cleanup.
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
}
