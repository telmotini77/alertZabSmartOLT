import assert from 'assert';

process.env.NODE_ENV = 'test';
process.env.SMARTOLT_SUBDOMAIN = 'testcompany';
process.env.SMARTOLT_API_KEY = 'test_key';
process.env.TELEGRAM_BOT_TOKEN = '123456:test_token';
process.env.TELEGRAM_CHAT_ID = '-100987654321';

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

const { processPortAlert } = await import('./routes/webhook.js');
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
  { sn: 'HWTC11111111', name: 'Cliente 1', status: 'Online', olt_name: 'OLT_GS', board: '12', port: '15', odb_name: 'CAJA NOC' },
  { sn: 'HWTC22222222', name: 'Cliente 2', status: 'Active', olt_name: 'OLT_GS', board: '12', port: '15', odb_name: 'CAJA NOC' }
];
const onlineResult = await processPortAlert(payload, '12', '15');
assert.equal(onlineResult.sent, false);
assert.equal(telegramMessages.length, 0, 'A port that Smart OLT reports online must not send a non-corroborated alert');

smartOltOnus = smartOltOnus.map((onu) => ({ ...onu, status: 'Offline' }));
const detailedResult = await processPortAlert(payload, '12', '15');
assert.equal(detailedResult.sent, true);
assert.equal(telegramMessages.length, 1, 'A Smart OLT-confirmed outage must send one detailed report');
assert.ok(telegramMessages[0].text.includes('CAÍDA MASIVA DE PUERTO GPON'));
assert.ok(telegramMessages[0].text.includes('Resumen de Afectación'));
assert.ok(telegramMessages[0].text.includes('Afectación Desglosada por Caja NAP'));
assert.ok(telegramMessages[0].text.includes('NAP CAJA NOC'));
assert.ok(!telegramMessages[0].text.includes('No se encontraron clientes registrados'));

const recoveryResult = await processPortAlert({ ...payload, event_status: 'OK' }, '12', '15');
assert.equal(recoveryResult.sent, false);
assert.equal(telegramMessages.length, 1, 'A simple port recovery must not send another Telegram message');

console.log('Detailed-only GPON port notification filter: PASS');
