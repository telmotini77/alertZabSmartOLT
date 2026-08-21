import assert from 'assert';
import fs from 'fs';
import path from 'path';

const cacheFile = path.resolve('data/.nap_cache.zabbix-nap-loss.test.json');
process.env.NODE_ENV = 'test';
process.env.SMARTOLT_SUBDOMAIN = 'testcompany';
process.env.SMARTOLT_API_KEY = 'test_key';
process.env.TELEGRAM_BOT_TOKEN = '123456:test_token';
process.env.TELEGRAM_CHAT_ID = '-100987654321';
process.env.TELEGRAM_ADDITIONAL_CHAT_IDS = '';
process.env.NAP_CACHE_FILE = cacheFile;
process.env.NAP_LOSS_MIN_ONUS = '2';
process.env.SMARTOLT_REQUIRE_CORROBORATION = 'true';

const telegramMessages = [];
const onus = ['FHTTZAB00001', 'FHTTZAB00002'].map((sn, index) => ({
  sn,
  name: `Cliente ${index + 1}`,
  status: 'Offline',
  odb_name: 'NAP-ZABBIX-1',
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
  if (String(url).includes('/system/get_odbs')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        response: [{ name: 'NAP-ZABBIX-1', latitude: '-2.9110', longitude: '-78.9665' }]
      })
    };
  }
  if (String(url).includes('/onu/get_all_onus_details')) {
    return { ok: true, status: 200, json: async () => ({ status: true, onus }) };
  }
  if (String(url).includes('/onu/get_onus_statuses')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        response: onus.map((onu, index) => ({
          ...onu,
          unique_external_id: `onu-${index + 1}`
        }))
      })
    };
  }
  if (String(url).includes('/onu/get_onu_status/')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: true, onu_status: 'Offline', last_down_reason: 'Loss of Signal' })
    };
  }
  throw new Error(`Unexpected request: ${url}`);
};

const { syncCacheWithSmartOlt, getCachedNaps } = await import('./services/cache.js');
const { processAndSendAlert, processZabbixAlert } = await import('./routes/webhook.js');

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
  assert.ok(message.includes('Tipo de caída:'), 'The alert must include its required failure type');
  assert.ok(message.includes('Clientes afectados:'), 'The alert must include affected customer names');
  assert.ok(message.includes('Cliente 1') && message.includes('Cliente 2'));
  assert.ok(message.includes('Fecha y hora:'), 'The alert must include its required date and time');
  assert.ok(!message.includes('FHTTZAB00001') && !message.includes('FHTTZAB00002'));
  assert.strictEqual(getCachedNaps()[0].status, 'offline', 'The NAP must be fully offline in cache');

  // Reset the incident, then simulate misleading Zabbix LOS events while
  // Smart OLT definitively reports that every device lost electrical power.
  onus.forEach((onu) => { onu.status = 'Online'; });
  await processZabbixAlert({
    event_name: 'ONU FHTTZAB00001: Loss of Signal',
    host_name: 'OLT-TEST',
    event_status: 'OK',
    event_severity: 'High'
  });
  await processZabbixAlert({
    event_name: 'ONU FHTTZAB00002: Loss of Signal',
    host_name: 'OLT-TEST',
    event_status: 'OK',
    event_severity: 'High'
  });
  onus.forEach((onu) => {
    onu.status = 'Offline';
    onu.offline_reason = 'Dying Gasp';
  });

  const beforeTotalPowerAlert = telegramMessages.length;
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
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.strictEqual(telegramMessages.length, beforeTotalPowerAlert + 1, 'A total electrical outage must send one consolidated Power Fail alert');
  const totalPowerMessage = telegramMessages.at(-1).text;
  assert.ok(totalPowerMessage.includes('CORTE DE ENERGÍA'), 'Total electrical outage must use the Power Fail title');
  assert.ok(totalPowerMessage.includes('Power Fail'), 'Total electrical outage must identify its power classification');
  assert.ok(totalPowerMessage.includes('Caja afectada:'), 'The alert must explicitly identify the affected NAP box');
  assert.ok(totalPowerMessage.includes('Corte de energía en equipos conectados a:'), 'The alert must associate the power failure with its NAP box');
  assert.ok(totalPowerMessage.includes('NAP-ZABBIX-1'), 'The power alert must include the exact NAP code');
  assert.ok(!totalPowerMessage.includes('CAÍDA TOTAL EN CAJA NAP'), 'Total electrical outage must not be called a NAP outage');
  assert.ok(totalPowerMessage.includes('Smart OLT (principal)'), 'The alert must show Smart OLT as the primary source');
  assert.ok(totalPowerMessage.includes('Zabbix (confirmación)'), 'The alert must show Zabbix as the confirmation source');
  assert.ok(totalPowerMessage.includes('Confirmada y clasificada por Smart OLT como Corte de energía'), 'The mismatch must be explicitly reclassified using Smart OLT');
  assert.ok(totalPowerMessage.includes('Tipo de caída:'), 'Power alert must include its required failure type');
  assert.ok(totalPowerMessage.includes('Clientes afectados:'), 'Power alert must include affected customer names');
  assert.ok(totalPowerMessage.includes('Fecha y hora:'), 'Power alert must include its required date and time');
  assert.ok(!totalPowerMessage.includes('FHTTZAB00001') && !totalPowerMessage.includes('FHTTZAB00002'));

  // The same active Power Fail must not flood Telegram with additional
  // Zabbix events. It is re-notified only by the six-hour radar reminder.
  const messagesBeforeDuplicatePower = telegramMessages.length;
  const powerResult = await processAndSendAlert({
    event_name: 'ONU FHTTZAB00001: Power failure detected',
    host_name: 'OLT-TEST',
    event_status: 'PROBLEM',
    event_severity: 'High'
  }, { ...onus[0], status: 'Offline' }, 'Corte de Energía (Dying Gasp)');
  assert.strictEqual(powerResult.sent, false, 'A duplicate Power Fail inside six hours must be suppressed');
  assert.strictEqual(telegramMessages.length, messagesBeforeDuplicatePower);

  const oltPriorityResult = await processAndSendAlert({
    event_name: 'ONU FHTTZAB00001: Loss of Signal',
    host_name: 'OLT-TEST',
    event_status: 'PROBLEM',
    event_severity: 'High'
  }, { ...onus[0], status: 'Offline' }, 'Corte de Energía (Dying Gasp)');
  assert.strictEqual(oltPriorityResult.sent, false, 'A repeated Zabbix label must not bypass the six-hour suppression');
  assert.strictEqual(telegramMessages.length, messagesBeforeDuplicatePower);

  console.log('Zabbix NAP/Power Fail corroboration rules: PASS');
} catch (error) {
  console.error('Zabbix cache-backed total NAP LOS alert: FAIL', error);
  process.exitCode = 1;
} finally {
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
}
