import express from 'express';
import fs from 'fs';

// We will mock globalThis.fetch to intercept Smart OLT and Telegram requests
const originalFetch = globalThis.fetch;

let fetchLog = [];

globalThis.fetch = async (url, options) => {
  // Zabbix JSON-RPC API mock response
  if (url.includes('/api_jsonrpc.php')) {
    const body = options?.body ? JSON.parse(options.body) : {};
    if (body.method === 'trigger.get') {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          jsonrpc: '2.0',
          result: [
            {
              triggerid: '10001',
              description: 'ONU FHTT8c3a91bf: Loss of Signal',
              priority: '4',
              lastchange: '1772123456',
              hosts: [
                {
                  hostid: '10101',
                  host: 'OLT-CENTRAL',
                  name: 'OLT-CENTRAL'
                }
              ]
            },
            {
              triggerid: '10002',
              description: 'Alerta de infraestructura general',
              priority: '2',
              lastchange: '1772123456',
              hosts: [
                {
                  hostid: '10102',
                  host: 'Router-Borders',
                  name: 'Router-Borders'
                }
              ]
            }
          ],
          id: body.id
        })
      };
    }
  }

  const urlObj = new URL(url);
  fetchLog.push({ 
    url, 
    method: options?.method || 'GET', 
    body: options?.body ? JSON.parse(options.body) : null 
  });
  
  // Smart OLT get_all_onus_details mock response
  if (url.includes('/onu/get_all_onus_details')) {
    const sn = urlObj.searchParams.get('sn');
    const address = urlObj.searchParams.get('address');
    const board = urlObj.searchParams.get('board');
    const port = urlObj.searchParams.get('port');
    
    // Simulate Smart OLT API connection error / timeout
    if (sn === 'FAILONU00000') {
      throw new Error('Connection to Smart OLT API timed out');
    }
    
    // Mock response when querying by port
    if (board && port) {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          status: true,
          onus: [
            {
              onu_id: '1/1/3:12',
              external_id: 'ext_fhtt_123',
              sn: 'FHTT8C3A91BF',
              name: 'Juan Pérez',
              status: 'Offline',
              olt_name: 'OLT-CENTRAL',
              board: '1',
              port: '3',
              address: 'Calle Falsa 123, NAP-04-A, Sector Centro',
              description: 'Caja NAP-04-A splitter principal'
            },
            {
              onu_id: '1/1/3:13',
              external_id: 'ext_hwtc_123',
              sn: 'HWTC12345678',
              name: 'María López',
              status: 'Online',
              olt_name: 'OLT-CENTRAL',
              board: '1',
              port: '3',
              address: 'Av. Siempre Viva 742, NAP-04-B',
              description: 'Caja NAP-04-B'
            },
            {
              onu_id: '1/1/3:14',
              external_id: 'ext_zteg_123',
              sn: 'ZTEG00998877',
              name: 'Carlos Rodríguez',
              status: 'Offline',
              olt_name: 'OLT-CENTRAL',
              board: '1',
              port: '3',
              address: 'Pasaje del Pino 4, NAP-04-C',
              description: 'Caja NAP-04-C'
            }
          ]
        })
      };
    }
    
    if (sn === 'FHTT8C3A91BF' || sn === 'HWTC12345678') {
      const isFhtt = sn === 'FHTT8C3A91BF';
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          status: true,
          onus: [
            {
              onu_id: isFhtt ? '1/1/3:12' : '1/1/3:13',
              external_id: isFhtt ? 'ext_fhtt_123' : 'ext_hwtc_123',
              sn: sn,
              name: isFhtt ? 'Juan Pérez' : 'María López',
              status: isFhtt ? 'Offline' : 'Online',
              olt_name: 'OLT-CENTRAL',
              board: '1',
              port: '3',
              address: isFhtt ? 'Calle Falsa 123, NAP-04-A, Sector Centro' : 'Av. Siempre Viva 742, NAP-04-A',
              description: isFhtt ? 'Caja NAP-04-A splitter principal' : 'Caja NAP-04-A splitter principal'
            }
          ]
        })
      };
    } else if (address === 'NAP-04-A') {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          status: true,
          onus: [
            {
              onu_id: '1/1/3:12',
              external_id: 'ext_fhtt_123',
              sn: 'FHTT8C3A91BF',
              name: 'Juan Pérez',
              status: 'Offline',
              olt_name: 'OLT-CENTRAL',
              board: '1',
              port: '3',
              address: 'Calle Falsa 123, NAP-04-A, Sector Centro',
              description: 'Caja NAP-04-A splitter principal'
            },
            {
              onu_id: '1/1/3:13',
              external_id: 'ext_hwtc_123',
              sn: 'HWTC12345678',
              name: 'María López',
              status: 'Online',
              olt_name: 'OLT-CENTRAL',
              board: '1',
              port: '3',
              address: 'Av. Siempre Viva 742, NAP-04-A',
              description: 'Caja NAP-04-A splitter principal'
            },
            {
              onu_id: '1/1/3:14',
              external_id: 'ext_zteg_123',
              sn: 'ZTEG00998877',
              name: 'Carlos Rodríguez',
              status: 'Offline',
              olt_name: 'OLT-CENTRAL',
              board: '1',
              port: '3',
              address: 'Pasaje del Pino 4, NAP-04-A',
              description: 'Caja NAP-04-A splitter principal'
            }
          ]
        })
      };
    } else {
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({
          status: true,
          onus: []
        })
      };
    }
  }

  // Smart OLT get_onu_status mock response
  if (url.includes('/onu/get_onu_status/')) {
    const isFhtt = url.includes('ext_fhtt_123');
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        status: true,
        onu_status: isFhtt ? 'offline' : 'online',
        signal: isFhtt ? 0 : -18.5,
        tx_power: isFhtt ? 0 : 2.1,
        temperature: isFhtt ? 0 : 42.5,
        voltage: isFhtt ? 0 : 3.3,
        bias_current: isFhtt ? 0 : 15.2,
        distance: isFhtt ? 0 : 120,
        last_down_reason: 'Dying gasp'
      })
    };
  }
  
  // Telegram sendMessage mock response
  if (url.includes('/sendMessage')) {
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        ok: true,
        result: { message_id: 12345 }
      })
    };
  }

  // Telegram setWebhook mock response
  if (url.includes('/setWebhook')) {
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        ok: true,
        description: 'Webhook set'
      })
    };
  }

  // Telegram getWebhookInfo mock response
  if (url.includes('/getWebhookInfo')) {
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({
        ok: true,
        result: {
          url: 'https://test-api.onrender.com/webhook/telegram',
          has_custom_certificate: false,
          pending_update_count: 0,
          max_connections: 100
        }
      })
    };
  }

  // Telegram deleteWebhook mock response
  if (url.includes('/deleteWebhook')) {
    return {
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ ok: true, result: true })
    };
  }

  // Default response for any other Telegram or unknown API call
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ ok: true })
  };
};

// Inject mock env vars before importing index.js
process.env.NODE_ENV = 'test'; // Enforce test environment for faster de-bounce timers
process.env.SMARTOLT_SUBDOMAIN = 'testcompany';
process.env.SMARTOLT_API_KEY = 'test_key';
process.env.SMARTOLT_REQUIRE_CORROBORATION = 'true';
process.env.PORT_CORRELATION_ENABLED = 'false';
process.env.NAP_CACHE_FILE = 'data/.nap_cache.routes.test.json';
process.env.TELEGRAM_BOT_TOKEN = '123456:test_token';
process.env.TELEGRAM_CHAT_ID = '-100987654321';
process.env.TELEGRAM_ADDITIONAL_CHAT_IDS = '';
process.env.TELEGRAM_MODE = 'webhook'; // Webhook mode is easier to test as it disables the long poll loop
process.env.PUBLIC_URL = 'https://test-api.onrender.com';
process.env.PORT = '3001';
process.env.ZABBIX_API_URL = 'http://test-zabbix.com/api_jsonrpc.php';
process.env.ZABBIX_API_TOKEN = 'test_zabbix_token';

console.log('--- STARTING SERVER INTEGRATION TEST ---');

// Dynamically import index.js to run with our environment configurations
await import('./index.js');

// Give Express server 1 second to bind and initialize
await new Promise(resolve => setTimeout(resolve, 1000));

try {
  console.log('\n[1] Testing Direct Zabbix Webhook (Push workflow - Loss Event)...');
  fetchLog = [];
  
  let zabbixResponse = await originalFetch('http://localhost:3001/webhook/zabbix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_name: 'ONU FHTT8c3a91bf: Loss of Signal',
      host_name: 'OLT-CENTRAL',
      event_severity: 'High',
      event_status: 'PROBLEM'
    })
  });
  
  let zabbixData = await zabbixResponse.json();
  console.log('Response Status:', zabbixResponse.status);
  console.log('Response Body:', zabbixData);
  
  // The route now responds immediately with { status: 'received' } and processes async
  if (zabbixResponse.status === 200 && zabbixData.status === 'received') {
    console.log('✅ Webhook route /webhook/zabbix (Loss): PASS');
  } else {
    console.error('❌ Webhook route /webhook/zabbix (Loss): FAIL');
    process.exit(1);
  }

  // Wait for the settle window to expire (100ms in test mode) then Smart OLT re-query + Telegram
  await new Promise(resolve => setTimeout(resolve, 200));

  // Verify that Telegram exposes the Smart OLT-first comparison and the final
  // reclassification instead of silently copying the Zabbix trigger type.
  let tgMessage = fetchLog.find(log => log.url.includes('/sendMessage'))?.body?.text || '';
  if ((tgMessage.includes('ALERTA') || tgMessage.includes('RIESGO')) &&
      tgMessage.includes('Hora del Evento:') &&
      tgMessage.includes('Smart OLT (principal)') &&
      tgMessage.includes('Zabbix (confirmación)') &&
      tgMessage.includes('Confirmada y clasificada por Smart OLT como Corte de energía')) {
    console.log('✅ Smart OLT-first comparison, classification, and event time: PASS');
  } else {
    console.error('❌ Smart OLT-first comparison is missing from the Telegram alert:', tgMessage);
    process.exit(1);
  }

  console.log('\n[2] Testing Direct Zabbix Webhook (Push workflow - Power Fail Event - Settle Window & Send)...');
  fetchLog = [];

  zabbixResponse = await originalFetch('http://localhost:3001/webhook/zabbix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_name: 'ONU FHTT8c3a91bf: Power failure detected',
      host_name: 'OLT-CENTRAL',
      event_severity: 'Average',
      event_status: 'PROBLEM'
    })
  });

  zabbixData = await zabbixResponse.json();
  console.log('Response Status (Immediate):', zabbixResponse.status);
  console.log('Response Body (Immediate):', zabbixData);

  // Route responds immediately; settle window starts in background
  if (zabbixResponse.status === 200 && zabbixData.status === 'received') {
    console.log('✅ Webhook route /webhook/zabbix (Power Fail - Settle Window): PASS');
  } else {
    console.error('❌ Webhook route /webhook/zabbix (Power Fail - Settle Window): FAIL');
    process.exit(1);
  }

  // Verify that no message is sent immediately (settle window is active)
  const immediateTgMessages = fetchLog.filter(log => log.url.includes('/sendMessage'));
  if (immediateTgMessages.length === 0) {
    console.log('✅ Settle window active - no immediate send: PASS');
  } else {
    console.error('❌ Settle window active - immediate send detected: FAIL');
    process.exit(1);
  }

  // Wait for settle window to expire (100ms in test mode) + Smart OLT re-query
  await new Promise(resolve => setTimeout(resolve, 250));

  // Verify that the alert was sent after settle window with correct header
  tgMessage = fetchLog.find(log => log.url.includes('/sendMessage'))?.body?.text || '';
  if (tgMessage.includes('ALERTA') || tgMessage.includes('RIESGO')) {
    console.log('✅ Alert sent after settle window with Smart OLT corroboration: PASS');
  } else {
    console.error('❌ Alert sent after settle window with Smart OLT corroboration: FAIL');
    process.exit(1);
  }

  console.log('\n[2b] Testing Direct Zabbix Webhook (Push workflow - Cancel on Recovery within Settle Window)...');
  fetchLog = [];

  // Send PROBLEM alert to start the settle window
  zabbixResponse = await originalFetch('http://localhost:3001/webhook/zabbix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_name: 'ONU FHTT8c3a91bf: Power failure detected',
      host_name: 'OLT-CENTRAL',
      event_severity: 'Average',
      event_status: 'PROBLEM'
    })
  });

  // Wait a bit but not the full settle window
  await new Promise(resolve => setTimeout(resolve, 50));
  zabbixData = await zabbixResponse.json();
  if (zabbixResponse.status !== 200 || zabbixData.status !== 'received') {
    console.error('❌ Cancel on Recovery Setup (PROBLEM): FAIL');
    process.exit(1);
  }

  // Send OK alert (Recovery) before the settle window expires
  zabbixResponse = await originalFetch('http://localhost:3001/webhook/zabbix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_name: 'ONU FHTT8c3a91bf: Power failure detected',
      host_name: 'OLT-CENTRAL',
      event_severity: 'Average',
      event_status: 'OK'
    })
  });

  // Wait for OK background processing
  await new Promise(resolve => setTimeout(resolve, 300));

  zabbixData = await zabbixResponse.json();
  console.log('Recovery Response Status:', zabbixResponse.status);
  console.log('Recovery Response Body:', zabbixData);

  // Both PROBLEM and OK respond immediately with 'received'; cancellation happens in background
  if (zabbixResponse.status === 200 && zabbixData.status === 'received') {
    console.log('✅ Webhook route /webhook/zabbix (Recovery within Settle Window): PASS');
  } else {
    console.error('❌ Webhook route /webhook/zabbix (Recovery within Settle Window): FAIL');
    process.exit(1);
  }

  // Wait beyond the settle window to ensure no Telegram message is ever sent
  await new Promise(resolve => setTimeout(resolve, 200));

  const cancelledTgMessages = fetchLog.filter(log => log.url.includes('/sendMessage'));
  if (cancelledTgMessages.length === 0) {
    console.log('✅ Settle window cancellation verified (no Telegram message sent): PASS');
  } else {
    console.error('❌ Settle window cancellation verified (Telegram message was sent): FAIL');
    process.exit(1);
  }

  console.log('\n[3] Testing Direct Zabbix Webhook (Corroboration Blocked - Smart OLT Down)...');
  fetchLog = [];
  
  // We send an alert with the special serial number FAILONU00000 which will throw an error inside fetch mock
  zabbixResponse = await originalFetch('http://localhost:3001/webhook/zabbix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_name: 'ONU FAILONU00000: Loss of Signal',
      host_name: 'OLT-CENTRAL',
      event_severity: 'High',
      event_status: 'PROBLEM'
    })
  });
  
  // Wait for background async processing to complete before checking fetchLog
  await new Promise(resolve => setTimeout(resolve, 500));

  zabbixData = await zabbixResponse.json();
  console.log('Response Status:', zabbixResponse.status);
  console.log('Response Body:', zabbixData);

  // Route always returns 'received' immediately; the block happens silently in background
  if (zabbixResponse.status === 200 && (zabbixData.status === 'received' || zabbixData.status === 'ignored')) {
    console.log('✅ Webhook route /webhook/zabbix (Corroboration Blocked): PASS');
  } else {
    console.error('❌ Webhook route /webhook/zabbix (Corroboration Blocked): FAIL');
    process.exit(1);
  }
  
  tgMessage = fetchLog.find(log => log.url.includes('/sendMessage'))?.body?.text || '';
  if (!tgMessage) {
    console.log('✅ No Telegram message sent (Blocked as expected): PASS');
  } else {
    console.error('❌ Telegram message was sent when it should have been blocked: FAIL');
    process.exit(1);
  }

  console.log('\n[3b] Testing Direct Zabbix Webhook (Corroboration Blocked - Status Mismatch)...');
  fetchLog = [];
  
  // HWTC12345678 status is Online, so a PROBLEM event should be blocked
  zabbixResponse = await originalFetch('http://localhost:3001/webhook/zabbix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_name: 'ONU HWTC12345678: Loss of Signal',
      host_name: 'OLT-CENTRAL',
      event_severity: 'High',
      event_status: 'PROBLEM'
    })
  });
  
  // Wait for background processing
  await new Promise(resolve => setTimeout(resolve, 500));

  zabbixData = await zabbixResponse.json();
  console.log('Response Status:', zabbixResponse.status);
  console.log('Response Body:', zabbixData);

  if (zabbixResponse.status === 200 && (zabbixData.status === 'received' || zabbixData.status === 'ignored')) {
    console.log('✅ State Mismatch Blocked: PASS');
  } else {
    console.error('❌ State Mismatch Blocked: FAIL');
    process.exit(1);
  }
  
  tgMessage = fetchLog.find(log => log.url.includes('/sendMessage'))?.body?.text || '';
  if (!tgMessage) {
    console.log('✅ No Telegram message sent for mismatch (Blocked as expected): PASS');
  } else {
    console.error('❌ Telegram message was sent during mismatch: FAIL');
    process.exit(1);
  }

  console.log('\n[4] Testing Telegram Bot Listener (Pull/Enrich workflow)...');
  fetchLog = [];
  
  const telegramResponse = await originalFetch('http://localhost:3001/webhook/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      update_id: 8888,
      message: {
        message_id: 777,
        chat: { id: -100987654321, type: 'group' },
        from: { id: 1111, is_bot: false, first_name: 'Engineer' },
        text: 'Alerta: FHTT8c3a91bf Loss of Signal en OLT-CENTRAL'
      }
    })
  });

  const telegramData = await telegramResponse.json();
  console.log('Response Status:', telegramResponse.status);
  console.log('Response Body:', telegramData);
  
  if (telegramResponse.status === 200 && telegramData.ok === true) {
    console.log('✅ Webhook route /webhook/telegram: PASS');
  } else {
    console.error('❌ Webhook route /webhook/telegram: FAIL');
    process.exit(1);
  }
  
  // Wait a short duration for the async message handler to query Smart OLT and send the reply
  await new Promise(resolve => setTimeout(resolve, 500));

  console.log('Requests made during Telegram bot listener update:');
  fetchLog.forEach(log => {
    // Never print credentials embedded in Telegram Bot API URLs.
    const safeUrl = log.url.replace(/(https:\/\/api\.telegram\.org\/bot)[^/]+/i, '$1[REDACTED]');
    console.log(`- ${log.method} ${safeUrl}`);
    if (log.body) console.log(`  Body:`, JSON.stringify(log.body));
  });

  const hasSmartOltCallTg = fetchLog.some(log => log.url.includes('/onu/get_all_onus_details'));
  const smartOltReply = fetchLog.find(log => log.url.includes('/sendMessage') && log.body?.reply_to_message_id === 777);
  const hasTelegramReply = Boolean(smartOltReply);

  if (hasSmartOltCallTg &&
      hasTelegramReply &&
      smartOltReply.body.text.includes('CORTE DE ENERGÍA') &&
      !JSON.stringify(smartOltReply.body).includes('FHTT8C3A91BF')) {
    console.log('✅ Bot listener prioritizes the Smart OLT cause over the Zabbix label: PASS');
  } else {
    console.error('❌ Bot listener did not use the Smart OLT cause: FAIL');
    process.exit(1);
  }

  console.log('\n[5] Testing Direct Zabbix Webhook (Push workflow - 16-char Hex SN)...');
  fetchLog = [];
  
  const hexZabbixResponse = await originalFetch('http://localhost:3001/webhook/zabbix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_name: 'ONU 464854548C3A91BF: Loss of Signal',
      host_name: 'OLT-CENTRAL',
      event_severity: 'High',
      event_status: 'PROBLEM'
    })
  });
  
  const hexZabbixData = await hexZabbixResponse.json();
  console.log('Response Status:', hexZabbixResponse.status);
  console.log('Response Body:', hexZabbixData);
  
  // Route now responds immediately with 'received'; wait for background processing
  if (hexZabbixResponse.status === 200 && (hexZabbixData.status === 'received' || hexZabbixData.status === 'success')) {
    console.log('✅ Webhook route /webhook/zabbix (16-char Hex SN): PASS');
  } else {
    console.error('❌ Webhook route /webhook/zabbix (16-char Hex SN): FAIL');
    process.exit(1);
  }

  // Wait for background Smart OLT + Telegram processing
  await new Promise(resolve => setTimeout(resolve, 500));

  // A single event is notified with Smart OLT's cause, but must not be
  // escalated to a total NAP outage without fresh evidence from every ONU.
  const hexTgMsg = fetchLog.find(log => log.url.includes('/sendMessage'))?.body?.text || '';
  if (hexTgMsg.includes('CORTE DE ENERGÍA') && !hexTgMsg.includes('CAÍDA TOTAL EN CAJA NAP')) {
    console.log('✅ Isolated hex event uses the Smart OLT cause without false NAP escalation: PASS');
  } else {
    console.error('❌ Isolated hex event did not preserve the Smart OLT cause: FAIL');
    process.exit(1);
  }

  console.log('\n[6] Testing Zabbix & Smart OLT Active Failures Sync...');
  fetchLog = [];
  
  const syncResponse = await originalFetch('http://localhost:3001/webhook/zabbix/sync');
  const syncData = await syncResponse.json();
  console.log('Sync Response Status:', syncResponse.status);
  console.log('Sync Response Body:', syncData);
  
  if (syncResponse.status === 200 && syncData.status === 'success' && syncData.total === 2 && syncData.synchronized === 1) {
    console.log('✅ Zabbix active failures sync: PASS');
  } else {
    console.error('❌ Zabbix active failures sync: FAIL');
    process.exit(1);
  }
  
  const syncTgMessage = fetchLog.find(log => log.url.includes('/sendMessage') && log.body?.text?.includes('REPORTE DE INCIDENTES SINCRONIZADO'))?.body?.text || '';
  if (syncTgMessage.includes('Clientes afectados:</b> Juan Pérez') &&
      syncTgMessage.includes('Tipo de caída:</b> Corte de energía') &&
      syncTgMessage.includes('Fecha y hora:') &&
      !syncTgMessage.includes('FHTT8C3A91BF') &&
      !syncTgMessage.includes('Alerta Zabbix Genérica')) {
    console.log('✅ Synchronized Telegram Summary Report Content: PASS');
  } else {
    console.error('❌ Synchronized Telegram Summary Report Content: FAIL');
    process.exit(1);
  }

  console.log('\n[7] Testing Deep-Linked /start diag_<sn> command...');
  fetchLog = [];
  
  const startDiagResponse = await originalFetch('http://localhost:3001/webhook/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      update_id: 9999,
      message: {
        message_id: 999,
        chat: { id: 8953554158, type: 'private' },
        from: { id: 1111, is_bot: false, first_name: 'Engineer' },
        text: '/start diag_FHTT8C3A91BF'
      }
    })
  });

  const startDiagData = await startDiagResponse.json();
  console.log('Response Status:', startDiagResponse.status);
  console.log('Response Body:', startDiagData);
  
  if (startDiagResponse.status === 200 && startDiagData.ok === true) {
    console.log('✅ Webhook route /webhook/telegram (deep link /start): PASS');
  } else {
    console.error('❌ Webhook route /webhook/telegram (deep link /start): FAIL');
    process.exit(1);
  }

  // Wait a short duration for the async message handler to query Smart OLT and send the reply
  await new Promise(resolve => setTimeout(resolve, 500));

  const startDiagReplies = fetchLog.filter(log => log.url.includes('/sendMessage'));
  console.log(`Telegram messages sent: ${startDiagReplies.length}`);
  console.log('startDiagReplies content:', JSON.stringify(startDiagReplies, null, 2));
  const hasDiagTitle = startDiagReplies.some(log => log.body?.text?.includes('Diagnóstico en Vivo'));
  
  if (hasDiagTitle) {
    console.log('✅ Deep-linked /start diagnostics executed and replied: PASS');
  } else {
    console.error('❌ Deep-linked /start diagnostics executed and replied: FAIL');
    process.exit(1);
  }

  console.log('\n[8] Testing Inline Keyboard buttons on alert payload...');
  // Verify that the diagnostics reply in [7] had reply_markup with buttons
  const diagMsgWithKeyboard = startDiagReplies.find(log => log.body?.text?.includes('Diagnóstico en Vivo'));
  const replyMarkup = diagMsgWithKeyboard?.body?.reply_markup;
  
  if (replyMarkup && replyMarkup.inline_keyboard) {
    console.log('✅ Inline Keyboard found on live diagnostics: PASS');
    const buttons = replyMarkup.inline_keyboard.flat();
    const hasMapBtn = buttons.some(b => b.text.includes('Ver en Mapa') && b.url.includes('?nap='));
    const hasGmapsBtn = buttons.some(b => b.text.includes('Google Maps') && b.url.includes('google.com/maps'));
    
    if (hasMapBtn && hasGmapsBtn) {
      console.log('✅ Inline Keyboard map and navigation buttons: PASS');
    } else {
      console.error('❌ Inline Keyboard map/nav buttons missing:', JSON.stringify(buttons));
      process.exit(1);
    }
  } else {
    console.error('❌ No Inline Keyboard found on live diagnostics reply');
    process.exit(1);
  }

  console.log('\n[8b] Testing public alert history command...');
  fetchLog = [];
  await originalFetch('http://localhost:3001/webhook/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      update_id: 10001,
      message: {
        message_id: 1001,
        chat: { id: 777000111, type: 'private' },
        from: { id: 777000111, is_bot: false, first_name: 'Public User' },
        text: '/alertas 1'
      }
    })
  });
  await new Promise(resolve => setTimeout(resolve, 200));
  const publicHistoryReply = fetchLog.find(log =>
    log.url.includes('/sendMessage') && log.body?.reply_to_message_id === 1001
  );
  if (publicHistoryReply?.body?.text?.includes('HISTORIAL PÚBLICO DE ALERTAS') &&
      !/FHTT8C3A91BF|HWTC12345678|ZTEG00998877/.test(publicHistoryReply.body.text)) {
    console.log('✅ Public users can view existing alert history: PASS');
  } else {
    console.error('❌ Public alert history command did not return the existing alerts');
    process.exit(1);
  }

  console.log('\n[9] Testing Phase 4 Notification Filtering and Risk Levels...');
  
  // 1. Recovery alert (should be suppressed)
  fetchLog = [];
  await originalFetch('http://localhost:3001/webhook/zabbix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_name: 'ONU FHTT8c3a91bf: Loss of Signal',
      host_name: 'OLT-CENTRAL',
      event_severity: 'High',
      event_status: 'OK'
    })
  });
  
  await new Promise(resolve => setTimeout(resolve, 200));
  let recoveryMsgs = fetchLog.filter(log => log.url.includes('/sendMessage'));
  if (recoveryMsgs.length === 0) {
    console.log('✅ Recovery alert (green status) suppressed from Telegram: PASS');
  } else {
    console.error('❌ Recovery alert (green status) was NOT suppressed from Telegram: FAIL');
    process.exit(1);
  }

  // 2. Partial drop non-power failure (should be suppressed)
  // Ensure other clients are online in cache first
  const { updateOnuStatusInCache } = await import('./services/cache.js');
  updateOnuStatusInCache('FHTT8C3A91BF', 'Online');
  updateOnuStatusInCache('HWTC12345678', 'Online');
  updateOnuStatusInCache('ZTEG00998877', 'Online');

  fetchLog = [];
  await originalFetch('http://localhost:3001/webhook/zabbix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_name: 'ONU HWTC12345678: Loss of Signal',
      host_name: 'OLT-CENTRAL',
      event_severity: 'High',
      event_status: 'PROBLEM'
    })
  });
  
  await new Promise(resolve => setTimeout(resolve, 200));
  let lossMsgs = fetchLog.filter(log => log.url.includes('/sendMessage'));
  if (lossMsgs.length === 0) {
    console.log('✅ Partial drop (non-power failure) suppressed from Telegram: PASS');
  } else {
    console.error('❌ Partial drop (non-power failure) was NOT suppressed: FAIL');
    process.exit(1);
  }

  // 3. Partial power fail drop (should NOT be suppressed, must have RIESGO BAJO or RIESGO MEDIO)
  // Currently FHTT8C3A91BF is Online, HWTC12345678 is Offline, ZTEG00998877 is Online
  fetchLog = [];
  await originalFetch('http://localhost:3001/webhook/zabbix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_name: 'ONU FHTT8c3a91bf: Power failure detected',
      host_name: 'OLT-CENTRAL',
      event_severity: 'Average',
      event_status: 'PROBLEM'
    })
  });
  
  // Wait for settle window
  await new Promise(resolve => setTimeout(resolve, 250));
  let powerMsgs = fetchLog.filter(log => log.url.includes('/sendMessage'));
  if (powerMsgs.length > 0) {
    const text = powerMsgs[0].body.text;
    if (text.includes('RIESGO BAJO') || text.includes('RIESGO MEDIO')) {
      console.log('✅ Partial power failure alert sent with correct risk title: PASS');
    } else {
      console.error('❌ Partial power failure did not contain RIESGO BAJO/MEDIO: FAIL', text);
      process.exit(1);
    }
  } else {
    console.error('❌ Partial power failure was suppressed: FAIL');
    process.exit(1);
  }

  // 4. Cache-only total NAP state without fresh events for every ONU must be
  // suppressed. The dedicated NAP test covers the fully corroborated path.
  updateOnuStatusInCache('FHTT8C3A91BF', 'Offline');
  updateOnuStatusInCache('HWTC12345678', 'Offline');
  updateOnuStatusInCache('ZTEG00998877', 'Online'); // 1 remains online

  fetchLog = [];
  // Send PROBLEM for the last client to trigger total loss
  await originalFetch('http://localhost:3001/webhook/zabbix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_name: 'ONU ZTEG00998877: Loss of Signal',
      host_name: 'OLT-CENTRAL',
      event_severity: 'High',
      event_status: 'PROBLEM'
    })
  });
  
  await new Promise(resolve => setTimeout(resolve, 200));
  let totalMsgs = fetchLog.filter(log => log.url.includes('/sendMessage'));
  if (totalMsgs.length === 0) {
    console.log('✅ Cache-only NAP outage suppressed until full corroboration: PASS');
  } else {
    console.error('❌ Cache-only NAP outage was incorrectly sent: FAIL');
    process.exit(1);
  }

  console.log('\n🎉 ALL INTEGRATION TESTS PASSED SUCCESSFULLY! 🎉');
  if (fs.existsSync(process.env.NAP_CACHE_FILE)) {
    fs.unlinkSync(process.env.NAP_CACHE_FILE);
  }
  process.exit(0);
} catch (error) {
  console.error('❌ Test failed with error:', error);
  process.exit(1);
}
