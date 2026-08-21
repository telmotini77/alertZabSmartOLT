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
process.env.NAP_TOTAL_OUTAGE_MIN_ONUS = '1';
process.env.NAP_POWER_FAIL_MIN_PERCENT = '60';

// The third ONU is intentionally permanently Offline. It must neither trigger
// a message nor inflate the impact of a real Power fail / LOS incident.
let statuses = ['Online', 'Online', 'Offline', 'Online'];
const telegramMessages = [];

const onus = () => ['FHTTTEST0001', 'FHTTTEST0002', 'FHTTTEST0003', 'FHTTTEST0004'].map((sn, index) => ({
  sn,
  name: `Cliente ${index + 1}`,
  status: statuses[index],
  // The fourth ONU represents a second OLT. It must be analysed on its own
  // NAP scope and must not prevent or receive an OLT-1 alert.
  odb_name: index === 3 ? 'NAP-TEST-2' : 'NAP-TEST-1',
  olt_name: index === 3 ? 'OLT-TEST-2' : 'OLT-TEST-1',
  olt_id: index === 3 ? '2' : '1',
  board: '2',
  port: '5',
  gps_lat: '-2.9110',
  gps_lng: '-78.9665',
  offline_reason: ''
}));

globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes('/sendMessage')) {
    telegramMessages.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  }

  if (String(url).includes('/system/get_odbs')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        response: [
          { name: 'NAP-TEST-1', latitude: '-2.9110', longitude: '-78.9665' },
          { name: 'NAP-TEST-2', latitude: '-2.9120', longitude: '-78.9675' }
        ]
      })
    };
  }

  if (String(url).includes('/onu/get_all_onus_details')) {
    return { ok: true, status: 200, json: async () => ({ status: true, onus: onus() }) };
  }

  if (String(url).includes('/onu/get_onus_statuses')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        response: onus().map((onu, index) => ({
          unique_external_id: `onu-${index + 1}`,
          sn: onu.sn,
          name: onu.name,
          olt_id: onu.olt_id,
          board: onu.board,
          port: onu.port,
          status: statuses[index]
        }))
      })
    };
  }

  throw new Error(`Unexpected request: ${url}`);
};

const { syncCacheWithSmartOlt, getCachedNaps } = await import('./services/cache.js');
const { getScannerStatus, runScanCycle } = await import('./services/scanner.js');
const { getNapOperationalEligibility } = await import('./routes/webhook.js');

try {
  await syncCacheWithSmartOlt();

  // First scan establishes the baseline and must not alert for existing data.
  await runScanCycle();
  assert.strictEqual(telegramMessages.length, 0, 'The baseline scan must not send a false alert');

  // A full NAP transition with LOS must generate one fallback notification
  // even when Zabbix did not emit the expected events.
  statuses = ['LOS', 'LOS', 'Offline', 'Online'];
  await runScanCycle();

  assert.strictEqual(telegramMessages.length, 1, 'Smart OLT must deliver a full-NAP LOS fallback alert');
  const lossMessage = telegramMessages[0].text;
  assert.ok(lossMessage.includes('Pérdida de señal'));
  assert.ok(lossMessage.includes('Cliente 1') && lossMessage.includes('Cliente 2'));
  assert.ok(!lossMessage.includes('Cliente 3'), 'Bare Offline clients must not appear in LOS reports');
  assert.ok(lossMessage.includes('Fecha y hora:'));
  assert.ok(lossMessage.includes('Sin evento oportuno'));
  assert.ok(!lossMessage.includes('FHTTTEST0001') && !lossMessage.includes('FHTTTEST0002'));
  assert.strictEqual(getCachedNaps()[0].status, 'offline', 'The cached NAP status must be fully offline');

  // Repeated scans while the same NAP remains down must not duplicate alerts.
  await runScanCycle();
  assert.strictEqual(telegramMessages.length, 1, 'The same active NAP outage must not be sent twice');

  // The only permitted reminder is after six uninterrupted hours. Mocking the
  // clock lets the radar prove this policy without waiting in the test.
  const realDateNow = Date.now;
  Date.now = () => realDateNow() + (6 * 60 * 60 * 1_000);
  try {
    await runScanCycle();
  } finally {
    Date.now = realDateNow;
  }
  assert.strictEqual(telegramMessages.length, 2,
    'An active total NAP outage must receive one reminder after six hours');

  // Recovery rearms the incident. A partial Power Fail below 60% and a
  // normal partial LOS must stay silent.
  statuses = ['Online', 'Online', 'Offline', 'Online'];
  await runScanCycle();
  statuses = ['Power fail', 'Online', 'Offline', 'Online'];
  await runScanCycle();

  assert.strictEqual(telegramMessages.length, 2, 'A partial electrical outage must not send Telegram alerts');
  statuses = ['LOS', 'Online', 'Offline', 'Online'];
  await runScanCycle();
  assert.strictEqual(telegramMessages.length, 2, 'A normal partial LOS must not send Telegram alerts');

  // SmartOLT explicitly diagnosing a fibre cut is an exception to the
  // total-LOS rule and must alert even before every router transitions.
  statuses = ['Online', 'Online', 'Offline', 'Online'];
  await runScanCycle();
  statuses = ['Fiber cut', 'Online', 'Offline', 'Online'];
  await runScanCycle();
  assert.strictEqual(telegramMessages.length, 3,
    'An explicit SmartOLT fibre-cut diagnosis must send one LOS alert');
  assert.ok(telegramMessages.at(-1).text.includes('CORTE DE FIBRA CONFIRMADO'),
    'The fibre-cut alert must identify the SmartOLT diagnosis explicitly');

  // Exactly 60% is deliberately not enough: Power Fail must be greater than
  // the configured threshold, not an individual or borderline outage.
  const exactSixtyPercent = getNapOperationalEligibility([
    ...Array.from({ length: 3 }, () => ({ status: 'Power fail', offline_reason: '' })),
    ...Array.from({ length: 2 }, () => ({ status: 'Online', offline_reason: '' }))
  ]);
  assert.strictEqual(exactSixtyPercent.eligible, false,
    'Exactly 60% Power Fail must not send a Telegram alert');

  // Here 2 of 3 actionable routers are electrically down (66.7%), while the
  // third is still online, so the NAP-wide Power Fail alert is allowed.
  statuses = ['Online', 'Online', 'Online', 'Online'];
  await runScanCycle();
  statuses = ['Power fail', 'Power fail', 'Online', 'Online'];
  await runScanCycle();
  assert.strictEqual(telegramMessages.length, 4, 'A 66.7% electrical outage must send one consolidated alert');
  const totalPowerMessage = telegramMessages[3].text;
  assert.ok(totalPowerMessage.includes('Corte de energía'));
  assert.ok(!totalPowerMessage.includes('Pérdida de señal (LOS)'));
  assert.ok(totalPowerMessage.includes('Cliente 1') && totalPowerMessage.includes('Cliente 2'));
  assert.ok(totalPowerMessage.includes('66.7%'), 'The power alert must show its 60%+ impact.');
  const scannerStatus = getScannerStatus();
  assert.ok(scannerStatus.lastSuccessAt, 'Scanner health must expose its latest successful Smart OLT query');
  assert.strictEqual(scannerStatus.totalOnus, 4);
  assert.strictEqual(scannerStatus.oltCount, 2, 'The radar must include each Smart OLT id in its status feed');
  assert.deepStrictEqual(scannerStatus.olts.map((olt) => olt.id), ['1', '2']);
  assert.strictEqual(scannerStatus.offlineOnus, 2);
  assert.strictEqual(scannerStatus.ignoredOfflineOnus, 0);
  assert.strictEqual(scannerStatus.lastError, null);

  console.log('Smart OLT fallback delivery for total NAP LOS/Power Fail across multiple OLTs: PASS');
} catch (error) {
  console.error('Total NAP LOS scanner alert: FAIL', error);
  process.exitCode = 1;
} finally {
  // Status snapshots persist with a debounced write. Let it finish before
  // cleaning the isolated test file so it cannot be recreated after cleanup.
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
}
