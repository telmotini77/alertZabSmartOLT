import assert from 'assert';

process.env.NODE_ENV = 'test';
process.env.SMARTOLT_SUBDOMAIN = 'testcompany';
process.env.SMARTOLT_API_KEY = 'test_key';
process.env.TELEGRAM_BOT_TOKEN = '123456:test_token';
process.env.TELEGRAM_CHAT_ID = '-100987654321';
process.env.TELEGRAM_ADDITIONAL_CHAT_IDS = '';

let smartOltOnus = [];
const telegramMessages = [];

globalThis.fetch = async (url, options = {}) => {
  const requestUrl = String(url);
  if (requestUrl.includes('/onu/get_all_onus_details')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: true, onus: smartOltOnus })
    };
  }
  if (requestUrl.includes('/onu/get_onus_statuses')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        response: smartOltOnus.map((onu) => ({
          ...onu,
          unique_external_id: onu.external_id
        }))
      })
    };
  }
  if (requestUrl.includes('/onu/get_onu_status/')) {
    const externalId = decodeURIComponent(requestUrl.split('/onu/get_onu_status/')[1]);
    const sourceOnu = smartOltOnus.find((onu) => onu.external_id === externalId);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        onu_status: sourceOnu?.status || 'Offline',
        last_down_reason: ['online', 'active'].includes(String(sourceOnu?.status || '').toLowerCase())
          ? ''
          : liveFailureReason
      })
    };
  }
  if (requestUrl.includes('/sendMessage')) {
    telegramMessages.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: telegramMessages.length } })
    };
  }
  throw new Error(`Unexpected request: ${requestUrl}`);
};

const { processPortAlert, selectNearbyNapOnusForAnalysis } = await import('./routes/webhook.js');

const nearbyScope = selectNearbyNapOnusForAnalysis([
  { sn: 'FOCAL-1', odb_name: 'NAP-FOCAL', gps_lat: '-2.9000', gps_lng: '-79.0000' },
  { sn: 'FOCAL-2', odb_name: 'NAP-FOCAL', gps_lat: '-2.9000', gps_lng: '-79.0000' },
  { sn: 'NEAR-1', odb_name: 'NAP-NEAR', gps_lat: '-2.9050', gps_lng: '-79.0000' },
  { sn: 'FAR-1', odb_name: 'NAP-FAR', gps_lat: '-2.9200', gps_lng: '-79.0000' }
], 'NAP-FOCAL');
assert.equal(nearbyScope.focusNapName, 'NAP-FOCAL');
assert.equal(nearbyScope.nearbyNapCount, 1, 'Only NAPs within one kilometre must join the live-cause scope');
assert.deepEqual(nearbyScope.onus.map((onu) => onu.sn), ['FOCAL-1', 'NEAR-1', 'FOCAL-2']);

const payload = {
  event_name: 'GPON port 12/15 is down',
  host_name: 'OLT_GS',
  event_status: 'PROBLEM',
  event_severity: 'Disaster',
  event_time: '2026-08-18 13:32:25'
};

const noClientsResult = await processPortAlert(payload, '12', '15');
assert.equal(noClientsResult.sent, false);
assert.equal(telegramMessages.length, 0, 'A port with no Smart OLT clients must not send the short fallback alert');

smartOltOnus = [
  { external_id: 'onu-1', sn: 'HWTC11111111', name: 'Cliente 1', status: 'Online', olt_name: 'OLT_GS', board: '12', port: '15', odb_name: 'CAJA NOC' },
  { external_id: 'onu-2', sn: 'HWTC22222222', name: 'Cliente 2', status: 'Active', olt_name: 'OLT_GS', board: '12', port: '15', odb_name: 'CAJA NOC' }
];
const onlineResult = await processPortAlert(payload, '12', '15');
assert.equal(onlineResult.sent, false);
assert.equal(telegramMessages.length, 0, 'A port that Smart OLT reports online must not send a non-corroborated alert');

smartOltOnus = smartOltOnus.map((onu) => ({ ...onu, status: 'Power fail' }));
const detailedResult = await processPortAlert(payload, '12', '15');
assert.equal(detailedResult.sent, false);
assert.equal(telegramMessages.length, 0, 'A port-only event must not bypass complete-NAP validation');

smartOltOnus = smartOltOnus.map((onu) => ({ ...onu, status: 'LOS' }));
const signalLossResult = await processPortAlert(payload, '12', '15');
assert.equal(signalLossResult.sent, false);
assert.equal(telegramMessages.length, 0, 'A port-only LOS event must not bypass complete-NAP validation');

smartOltOnus = smartOltOnus.map((onu) => ({ ...onu, status: 'Offline' }));
const unknownCauseResult = await processPortAlert(payload, '12', '15');
assert.equal(unknownCauseResult.sent, false);
assert.equal(telegramMessages.length, 0, 'An unknown Smart OLT cause must not be guessed from a generic Zabbix link-down event');

const recoveryResult = await processPortAlert({ ...payload, event_status: 'OK' }, '12', '15');
assert.equal(recoveryResult.sent, false);
assert.equal(telegramMessages.length, 0, 'A simple port recovery must not send another Telegram message');

console.log('Port-only events are suppressed in favour of complete-NAP alerts: PASS');
