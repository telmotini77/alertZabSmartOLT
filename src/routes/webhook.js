import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findOnuBySn, findOnusByAddressQuery, findOnusByPort, getOnuStatus } from '../services/smartOlt.js';
import { sendMessage, replyToMessage } from '../services/telegram.js';
import { extractSerialNumber, extractNapBox, parseStatusInfo, extractEventTime, formatDateTime, extractBoardAndPort } from '../utils/parser.js';
import { broadcast } from '../services/websocket.js';
import { updateOnuStatusInCache, getCachedNaps, updateNapCoordinates, updateNapCoordinatesBulk } from '../services/cache.js';
import { getActiveTriggers } from '../services/zabbix.js';

const router = express.Router();
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// GET /webhook/naps - Returns current status of all NAPs
router.get('/naps', (req, res) => {
  res.json(getCachedNaps());
});

// POST /webhook/naps/coordinates/bulk - Updates coordinates of multiple NAP boxes in bulk
router.post('/naps/coordinates/bulk', (req, res) => {
  const { updates } = req.body;

  if (!Array.isArray(updates)) {
    return res.status(400).json({ error: 'Updates must be an array of objects' });
  }

  try {
    const updatedNaps = updateNapCoordinatesBulk(updates);
    
    // Broadcast all updated NAPs to WebSocket clients
    updatedNaps.forEach((nap) => {
      broadcast('nap_status_update', nap);
    });

    return res.json({ status: 'success', updated_count: updatedNaps.length });
  } catch (err) {
    console.error('Error updating bulk coordinates:', err.message);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// POST /webhook/naps/coordinates - Updates coordinates of a specific NAP box manually
router.post('/naps/coordinates', (req, res) => {
  const { name, latitude, longitude } = req.body;
  
  if (!name || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: 'Missing name, latitude, or longitude' });
  }

  try {
    const updatedNap = updateNapCoordinates(name, latitude, longitude);
    
    if (updatedNap) {
      // Broadcast update to all WebSocket clients
      broadcast('nap_status_update', updatedNap);
      return res.json({ status: 'success', nap: updatedNap });
    } else {
      return res.status(404).json({ error: `NAP box "${name}" not found in cache` });
    }
  } catch (err) {
    console.error('Error updating coordinates:', err.message);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// POST /webhook/smartolt - Native Smart OLT webhook reception
router.post('/smartolt', async (req, res) => {
  const payload = req.body;
  console.log('Received Smart OLT webhook payload:', JSON.stringify(payload));
  
  if (!payload) {
    return res.status(400).json({ status: 'error', message: 'Empty payload' });
  }

  // 1. Extract SN (Flexible parsing)
  let sn = payload.sn || payload.serial_number || payload.onu_sn;
  if (!sn && payload.onu && payload.onu.sn) sn = payload.onu.sn;
  if (!sn) sn = extractSerialNumber(JSON.stringify(payload));
  
  if (!sn) {
    console.error('Smart OLT Webhook failed: No SN found in payload');
    return res.status(400).json({ status: 'error', message: 'No Serial Number found' });
  }
  
  // 2. Extract Event/Status
  const eventName = payload.event || payload.event_name || payload.status || 'unknown';
  const reason = payload.reason || payload.offline_reason || payload.last_down_reason || (payload.onu ? payload.onu.offline_reason : '') || '';
  
  // Determine if it's a PROBLEM (Offline) or OK (Online)
  const isOffline = eventName.toLowerCase().includes('offline') || eventName.toLowerCase().includes('los') || eventName.toLowerCase().includes('down') || eventName.toLowerCase().includes('dying');
  const isOnline = eventName.toLowerCase().includes('online') || eventName.toLowerCase().includes('up') || eventName.toLowerCase().includes('restored') || eventName.toLowerCase().includes('active');
  
  let eventStatus = 'PROBLEM';
  if (isOnline) {
    eventStatus = 'OK';
  } else if (!isOffline) {
    console.log(`Smart OLT Webhook ambiguous event status: "${eventName}". Assuming PROBLEM.`);
  }

  // Map to the format processAndSendAlert expects
  const zabbixLikePayload = {
    event_name: `Smart OLT Event: ${eventName}`,
    trigger_description: reason,
    host_name: payload.olt_name || (payload.olt ? payload.olt.name : 'Smart OLT'),
    event_severity: 'High',
    event_status: eventStatus,
    chat_id: req.query.chat_id || DEFAULT_CHAT_ID,
    onu_sn: sn.toUpperCase()
  };

  try {
    let overrideReason = reason;
    if (!overrideReason) {
      if (eventName.toLowerCase().includes('power') || eventName.toLowerCase().includes('dying')) {
        overrideReason = 'Corte de Energía (Dying Gasp)';
      } else if (eventName.toLowerCase().includes('los') || eventName.toLowerCase().includes('signal')) {
        overrideReason = 'Pérdida de Señal (LOS)';
      }
    }
    
    const result = await processAndSendAlert(zabbixLikePayload, null, overrideReason);
    
    // Update local map
    const optimisticStatus = eventStatus === 'PROBLEM' ? 'Offline' : 'Online';
    const updatedNap = updateOnuStatusInCache(sn.toUpperCase(), optimisticStatus);
    if (updatedNap) broadcast('nap_status_update', updatedNap);

    return res.json({ status: 'success', processed: sn, result });
  } catch (err) {
    console.error('Error processing Smart OLT webhook:', err.message);
    return res.status(500).json({ status: 'error', error: err.message });
  }
});

// GET /webhook/zabbix/sync - Trigger manual synchronization of all active problems
router.get('/zabbix/sync', async (req, res) => {
  const targetChatId = req.query.chat_id || DEFAULT_CHAT_ID;
  try {
    const result = await syncActiveProblems(targetChatId);
    return res.json({ status: 'success', ...result });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * Synchronize all active problem triggers from Zabbix, query Smart OLT status, and report.
 */
export async function syncActiveProblems(targetChatId = DEFAULT_CHAT_ID) {
  console.log('🔄 Starting manual Zabbix & Smart OLT synchronization...');
  
  try {
    const activeTriggers = await getActiveTriggers();
    if (!activeTriggers || activeTriggers.length === 0) {
      const emptyMsg = `✅ <b>Sincronización de Fallas Activas</b>\n\nNo se encontraron alertas activas registradas en Zabbix. Todos los sistemas parecen estar en orden.`;
      await sendMessage(targetChatId, emptyMsg);
      return { total: 0, synchronized: 0, sent: true };
    }
    
    const reports = [];
    let synchronizedCount = 0;
    
    for (const trigger of activeTriggers) {
      const hostText = trigger.hosts ? trigger.hosts.map(h => `${h.name} ${h.host}`).join(' ') : '';
      const fullText = `${trigger.description} ${hostText}`;
      const sn = extractSerialNumber(fullText);
      
      const zabbixTime = formatDateTime(new Date(Number(trigger.lastchange) * 1000));
      
      if (!sn) {
        reports.push(`⚠️ <b>Alerta Zabbix Genérica (Sin SN):</b>\n• <b>Evento:</b> ${trigger.description}\n• <b>Hora Zabbix:</b> <code>${zabbixTime}</code>\n• <b>Host:</b> ${trigger.hosts ? trigger.hosts.map(h => h.name).join(', ') : 'N/A'}`);
        continue;
      }
      
      try {
        console.log(`Syncing SN ${sn} found in active problem trigger: "${trigger.description}"`);
        const onu = await findOnuBySn(sn);
        
        if (onu) {
          let oltReason = 'Desconocida / No disponible';
          let liveStatus = null;
          try {
            liveStatus = await getOnuStatus(onu.external_id);
            if (liveStatus && liveStatus.status) {
              onu.status = liveStatus.status; // Override stale API cache with real-time hardware status
              const reason = (liveStatus.last_down_reason || liveStatus.offline_reason || '').toLowerCase();
              if (reason.includes('dying') || reason.includes('power') || reason.includes('gasp') || reason.includes('off')) {
                oltReason = 'Corte de Energía (Dying Gasp)';
              } else if (reason.includes('los') || reason.includes('signal') || reason.includes('fibra') || reason.includes('link') || reason.includes('down')) {
                oltReason = 'Pérdida de Señal (LOS)';
              } else if (reason) {
                oltReason = liveStatus.last_down_reason || liveStatus.offline_reason;
              }
            }
          } catch (statusErr) {
            console.error(`Failed to fetch status for ${sn} during sync:`, statusErr.message);
          }
          
          const isOltOnline = (onu.status || '').toLowerCase() === 'online' || (onu.status || '').toLowerCase() === 'active';
          const statusDot = isOltOnline ? '🟢' : '🔴';
          const oltDownTime = onu.last_down_time || (liveStatus && liveStatus.last_down_time) || 'N/A';
          
          const publicUrl = (process.env.PUBLIC_URL || '').trim();
          const sNapBox = extractNapBox(onu.address) || extractNapBox(onu.description) || 'N/A';
          const sNapLink = (sNapBox !== 'N/A' && publicUrl) ? `<a href="${publicUrl}/?nap=${encodeURIComponent(sNapBox)}">${sNapBox}</a>` : sNapBox;
          
          reports.push(`🔌 <b>ONU ${onu.name} (${sn})</b>\n• <b>Dirección/NAP:</b> ${onu.address || 'N/A'}\n• <b>Caja NAP:</b> <b>${sNapLink}</b>\n• <b>Estado Smart OLT:</b> ${statusDot} <b>${onu.status || 'Offline'}</b>\n• <b>Causa OLT:</b> <code>${oltReason}</code>\n• <b>Hora Zabbix:</b> <code>${zabbixTime}</code>\n• <b>Hora Corte Smart OLT:</b> <code>${oltDownTime}</code>`);
          
          const cacheStatus = isOltOnline ? 'Online' : 'Offline';
          const updatedNap = updateOnuStatusInCache(sn, cacheStatus);
          if (updatedNap) {
            broadcast('nap_status_update', updatedNap);
          }
          
          synchronizedCount++;
        } else {
          reports.push(`⚠️ <b>ONU No Encontrada en OLT (${sn}):</b>\n• <b>Evento Zabbix:</b> ${trigger.description}\n• <b>Hora Zabbix:</b> <code>${zabbixTime}</code>`);
        }
      } catch (err) {
        console.error(`Failed to synchronize SN ${sn}:`, err.message);
        reports.push(`⚠️ <b>Error de Sincronización (${sn}):</b>\n• <b>Evento Zabbix:</b> ${trigger.description}\n• <b>Error:</b> ${err.message}`);
      }
    }
    
    const summaryText = `🔄 <b>REPORTE DE INCIDENTES SINCRONIZADO</b> 🔄\n\n${reports.join('\n\n')}\n\n📊 <b>Resumen:</b>\n• Total alertas activas Zabbix: <b>${activeTriggers.length}</b>\n• Corroboradas con Smart OLT: <b>${synchronizedCount}</b>`;
    
    await sendMessage(targetChatId, summaryText.trim());
    return { total: activeTriggers.length, synchronized: synchronizedCount, sent: true };
  } catch (error) {
    console.error('Error during synchronization:', error.message);
    const errorMsg = `❌ <b>Error de Sincronización</b>\n\nOcurrió un error al intentar sincronizar Zabbix y Smart OLT: <code>${error.message}</code>`;
    await sendMessage(targetChatId, errorMsg);
    throw error;
  }
}

// ─── Smart OLT settle-wait logic ─────────────────────────────────────────────
// When Zabbix fires, Smart OLT may not have registered the event yet.
// We wait SMARTOLT_SETTLE_SECS before re-querying OLT with fresh live data,
// then compare both sources and send only if they agree.
const pendingAlerts = new Map(); // key: SN (uppercase), value: { timeoutId, payload }

const getSettleMs = () => {
  if (process.env.NODE_ENV === 'test') return 100; // fast in tests
  const secs = parseFloat(process.env.SMARTOLT_SETTLE_SECS);
  return (!isNaN(secs) && secs >= 0) ? secs * 1_000 : 30_000; // default 30s
};

/**
 * Helper to generate a detailed NAP connectivity report.
 * If no NAP box is found in the ONU details, falls back to a clean individual customer report.
 */
async function generateNapReport(onu, eventStatus, severity, hostName, eventName, statusEmoji, statusLabel, priorityTitle, oltStatusReason = '', eventTime = '') {
  // Extract NAP Box identifier
  const napBox = extractNapBox(onu.address) || extractNapBox(onu.description);
  const publicUrl = (process.env.PUBLIC_URL || '').trim();
  const napLink = (napBox && publicUrl) ? `<a href="${publicUrl}/?nap=${encodeURIComponent(napBox)}">${napBox}</a>` : (napBox || '');
  
  if (!napBox) {
    // If no NAP box was extracted, return standard individual client message
    return `
${priorityTitle}

<b>Estado:</b> ${statusLabel}
<b>Severidad:</b> ${severity}
${eventTime ? `📅 <b>Hora del Evento:</b> <code>${eventTime}</code>\n` : ''}<b>OLT:</b> ${onu.olt_name || hostName}
<b>Tarjeta/Slot:</b> ${onu.board || 'N/A'}  |  <b>Puerto PON:</b> ${onu.port || 'N/A'}  |  <b>ONU ID:</b> ${onu.onu_id || 'N/A'}

👤 <b>Detalles del Cliente (Smart OLT):</b>
• <b>Nombre/Cliente:</b> ${onu.name}
• <b>Nro. Serie:</b> <code>${onu.sn}</code>
• <b>Dirección:</b> ${onu.address || 'No especificada'}
• <b>Caja NAP:</b> No identificada en el sistema

ℹ️ <i>Evento Zabbix: ${eventName}</i>
`;
  }
  
  console.log(`NAP Box detected: ${napBox}. Querying all ONUs on this NAP...`);
  // Query other ONUs sharing the same NAP
  let onusOnNap = [];
  try {
    onusOnNap = await findOnusByAddressQuery(napBox);
  } catch (err) {
    console.error(`[Smart OLT error querying NAP ONUs]:`, err.message);
  }
  
  if (onusOnNap.length === 0) {
    // Fallback if query fails or returns empty
    return `
${priorityTitle}

<b>Estado:</b> ${statusLabel}
<b>Severidad:</b> ${severity}
<b>OLT:</b> ${onu.olt_name || hostName}
<b>Tarjeta/Slot:</b> ${onu.board || 'N/A'}  |  <b>Puerto PON:</b> ${onu.port || 'N/A'}  |  <b>ONU ID:</b> ${onu.onu_id || 'N/A'}

👤 <b>Detalles del Cliente (Smart OLT):</b>
• <b>Nombre/Cliente:</b> ${onu.name}
• <b>Nro. Serie:</b> <code>${onu.sn}</code>
• <b>Caja NAP:</b> <b>${napLink}</b> (No se pudieron cargar otros clientes de esta caja)

ℹ️ <i>Evento Zabbix: ${eventName}</i>
`;
  }
  
  // Calculate stats
  const totalClients = onusOnNap.length;
  const offlineOnus = onusOnNap.filter(o => {
    const s = (o.status || '').toLowerCase();
    return s !== 'online' && s !== 'active';
  });
  
  const totalOffline = offlineOnus.length;
  const totalOnline = totalClients - totalOffline;
  const percentageDown = ((totalOffline / totalClients) * 100).toFixed(1);
  
  // Build the list of clients and their status
  const clientLines = onusOnNap.map(o => {
    const isThisOne = o.sn.toUpperCase() === onu.sn.toUpperCase();
    const isOnline = (o.status || '').toLowerCase() === 'online' || (o.status || '').toLowerCase() === 'active';
    const statusDot = isOnline ? '🟢' : '🔴';
    
    const nameLabel = isThisOne ? `<b>${o.name} [ESTE REPORTE]</b>` : o.name;
    const snLabel = `<code>${o.sn}</code>`;
    const statusLabelText = o.status || 'Offline';
    
    return `${statusDot} ${nameLabel} (${snLabel}) - <i>${statusLabelText}</i>`;
  });
  
  const napWarning = totalOffline === totalClients 
    ? '⚠️ 🛑 <b>¡CAÍDA TOTAL DE LA CAJA NAP!</b> (Todos los clientes caídos)'
    : totalOffline > 1 
      ? '⚠️ <b>¡CAÍDA PARCIAL EN LA CAJA NAP!</b> (Múltiples clientes caídos)'
      : 'ℹ️ <b>Incidente Individual</b> (Solo 1 cliente caído en esta NAP)';

  let lastActiveNapInfo = '';
  if (eventStatus !== 'OK') {
    const isLoss = parseStatusInfo(eventName).category === 'loss';
    if (isLoss) {
      try {
        console.log(`Calculating last active NAP for OLT: ${onu.olt_name || hostName}, Board: ${onu.board}, Port: ${onu.port}`);
        const onusOnPort = await findOnusByPort(onu.olt_id, onu.board, onu.port, onu.olt_name || hostName);
        if (onusOnPort && onusOnPort.length > 0) {
          const napGroups = {};
          onusOnPort.forEach(o => {
            const n = extractNapBox(o.address) || extractNapBox(o.description);
            if (n) {
              if (!napGroups[n]) {
                napGroups[n] = { name: n, online: 0 };
              }
              const isOnline = (o.status || '').toLowerCase() === 'online' || (o.status || '').toLowerCase() === 'active';
              if (isOnline) {
                napGroups[n].online++;
              }
            }
          });
          
          const uniqueNaps = Object.keys(napGroups);
          // Sort NAPs naturally (e.g. NAP-2 before NAP-10) to reflect sequential layout
          const sortedNaps = uniqueNaps.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
          
          // Find the last NAP in sequential order that still has online clients
          let lastActiveIdx = -1;
          for (let i = sortedNaps.length - 1; i >= 0; i--) {
            if (napGroups[sortedNaps[i]].online > 0) {
              lastActiveIdx = i;
              break;
            }
          }
          
          const activeNaps = sortedNaps.filter(n => napGroups[n].online > 0);
          const inactiveNaps = sortedNaps.filter(n => napGroups[n].online === 0);
          
          if (lastActiveIdx !== -1) {
            const lastActiveNap = sortedNaps[lastActiveIdx];
            const nextInactiveNap = sortedNaps[lastActiveIdx + 1];
            
            let cutEstimation = '';
            if (nextInactiveNap) {
              cutEstimation = `\n📍 <b>Punto de corte estimado:</b> Entre <b>${lastActiveNap}</b> y <b>${nextInactiveNap}</b>`;
            } else {
              cutEstimation = `\n📍 <b>Punto de corte estimado:</b> Falla individual o posterior a <b>${lastActiveNap}</b>`;
            }
            
            lastActiveNapInfo = `\n\n📶 <b>Última NAP con señal en el puerto:</b> <b>${lastActiveNap}</b>${cutEstimation}\n• NAPs activas: ${activeNaps.join(', ') || 'Ninguna'}\n${inactiveNaps.length > 0 ? `• NAPs sin señal: ${inactiveNaps.join(', ')}` : ''}`;
          } else {
            lastActiveNapInfo = `\n\n📶 <b>Última NAP con señal en el puerto:</b> <i>Ninguna (Caída total del puerto PON)</i>\n📍 <b>Punto de corte estimado:</b> Inicio del tendido (troncal) o puerto PON caído en la OLT.`;
          }
        }
      } catch (err) {
        console.error('Error calculating last active NAP:', err.message);
      }
    }
  }

  return `
${priorityTitle}
📦 <b>Caja NAP Afectada: ${napLink}</b>

<b>Alerta:</b> ${statusEmoji} ${statusLabel} (${severity})
${eventTime ? `📅 <b>Hora del Evento:</b> <code>${eventTime}</code>\n` : ''}${oltStatusReason ? `🔌 <b>Causa OLT:</b> <code>${oltStatusReason}</code>\n` : ''}<b>OLT:</b> ${onu.olt_name || hostName}
<b>Puerto Físico:</b> Slot ${onu.board || 'N/A'} | Puerto PON ${onu.port || 'N/A'}

📊 <b>Resumen de Conectividad en la NAP:</b>
• Total Clientes en esta NAP: <b>${totalClients}</b>
• 🟢 Activos (Online): <b>${totalOnline}</b>
• 🛑 Caídos (Offline): <b>${totalOffline}</b> (<b>${percentageDown}%</b> de afectación)

🔍 <b>Análisis de Impacto:</b>
${napWarning}${lastActiveNapInfo}

👥 <b>Detalle de Clientes en esta NAP:</b>
${clientLines.join('\n')}

ℹ️ <i>Evento Zabbix: ${eventName}</i>
`;
}

/**
 * Helper to process and send a Zabbix alert to Telegram (reusable for immediate & delayed alerts).
 */
export async function processAndSendAlert(payload, prefetchedOnu = null, prefetchedOltStatusReason = '') {
  const eventName = payload.event_name || payload.trigger_name || '';
  const triggerDesc = payload.trigger_description || '';
  const hostName = payload.host_name || payload.host || 'OLT Desconocida';
  const severity = payload.event_severity || payload.severity || 'Warning';
  const eventStatus = payload.event_status || payload.status || 'PROBLEM';
  const targetChatId = payload.chat_id || DEFAULT_CHAT_ID;
  
  if (!targetChatId) {
    throw new Error('Missing TELEGRAM_CHAT_ID');
  }

  // Find Serial Number in fields or text
  let sn = payload.onu_sn || payload.sn || extractSerialNumber(eventName) || extractSerialNumber(triggerDesc);
  
  let onu = prefetchedOnu;
  let oltStatusReason = prefetchedOltStatusReason;
  let smartOltEnriched = false;

  if (sn) {
    try {
      if (!onu) {
        console.log(`Extracted SN: ${sn}. Querying Smart OLT...`);
        onu = await findOnuBySn(sn);
      }
      
      if (onu) {
        // Query live status if reason is not yet resolved
        if (!oltStatusReason) {
          console.log(`Querying live status for ONU ${onu.external_id} (${sn}) on Smart OLT...`);
          const liveStatus = await getOnuStatus(onu.external_id);
          if (liveStatus && liveStatus.status) {
            // Override stale API cache status with real-time hardware status
            onu.status = liveStatus.status;
            
            const reason = (liveStatus.last_down_reason || liveStatus.offline_reason || '').toLowerCase();
            console.log(`Smart OLT live reason for ${sn}: "${reason}"`);
            
            if (reason.includes('dying') || reason.includes('power') || reason.includes('gasp') || reason.includes('off')) {
              oltStatusReason = 'Corte de Energía (Dying Gasp)';
            } else if (reason.includes('los') || reason.includes('signal') || reason.includes('fibra') || reason.includes('link') || reason.includes('down')) {
              oltStatusReason = 'Pérdida de Señal (LOS)';
            } else if (reason) {
              oltStatusReason = liveStatus.last_down_reason || liveStatus.offline_reason;
            }
          }
        }
        smartOltEnriched = true;
      }
    } catch (smartOltError) {
      console.error(`[Smart OLT error ignored to maintain independence]:`, smartOltError.message);
    }
  }

  // Parse alert category & status info
  const statusInfo = parseStatusInfo(eventName + ' ' + triggerDesc);
  
  let category = statusInfo.category;
  if (oltStatusReason === 'Corte de Energía (Dying Gasp)') {
    category = 'power_fail';
  } else if (oltStatusReason === 'Pérdida de Señal (LOS)') {
    category = 'loss';
  }

  // Corroboration verification
  if (category === 'power_fail' || category === 'loss') {
    if (!smartOltEnriched || !onu) {
      console.log(`[Corroboration Blocked] Event category "${category}" for SN "${sn}" was not enriched with Smart OLT. Skipping Telegram notification.`);
      return { sn, enriched: false, sent: false, reason: 'Not enriched' };
    }
    
    // Corroborate status mismatch
    const isZabbixProblem = eventStatus === 'PROBLEM';
    const isOltOnline = (onu.status || '').toLowerCase() === 'online' || (onu.status || '').toLowerCase() === 'active';
    
    if (isZabbixProblem && isOltOnline) {
      console.log(`[Corroboration Blocked] State mismatch: Zabbix reports PROBLEM but Smart OLT reports ONU as Online/Active for SN "${sn}". Skipping Telegram notification.`);
      return { sn, enriched: true, sent: false, reason: 'State mismatch (Zabbix PROBLEM, OLT Online)' };
    }
    
    if (!isZabbixProblem && !isOltOnline) {
      console.log(`[Corroboration Blocked] State mismatch: Zabbix reports OK but Smart OLT reports ONU as Offline/Down for SN "${sn}". Skipping Telegram notification.`);
      return { sn, enriched: true, sent: false, reason: 'State mismatch (Zabbix OK, OLT Offline)' };
    }
  }

  const eventTime = extractEventTime(payload);

  const statusEmoji = eventStatus === 'OK' ? '🟢' : (category === 'power_fail' ? '🔌' : '🔴');
  const statusLabel = eventStatus === 'OK' ? 'OK (Restablecido)' : (category === 'power_fail' ? 'Corte de Energía' : 'Pérdida de Señal');

  // Set visual priority title based on category & status
  let priorityTitle = '';
  if (eventStatus === 'OK') {
    priorityTitle = `🟢 <b>SERVICIO RESTABLECIDO</b>`;
  } else if (category === 'loss') {
    priorityTitle = `🚨🔴 <b>ALERTA CRÍTICA: PÉRDIDA DE SEÑAL</b>`;
  } else if (category === 'power_fail') {
    priorityTitle = `⚡🔌 <b>ALERTA: CORTE DE ENERGÍA</b>`;
  } else {
    priorityTitle = `${statusEmoji} <b>ALERTA DE INFRAESTRUCTURA</b>`;
  }

  let enrichedText = '';

  if (onu) {
    // Generate the detailed NAP-level report
    enrichedText = await generateNapReport(
      onu,
      eventStatus,
      severity,
      hostName,
      eventName,
      statusEmoji,
      statusLabel,
      priorityTitle,
      oltStatusReason,
      eventTime
    );
  }

  if (!smartOltEnriched) {
    // Standalone Zabbix Alert (Fallback / Decoupled mode)
    const snPart = sn ? `\n• <b>Nro. Serie Detectado:</b> <code>${sn}</code>` : '';
    const reasonPart = oltStatusReason ? `\n• <b>Causa OLT:</b> <code>${oltStatusReason}</code>` : '';
    enrichedText = `
${priorityTitle}

<b>Estado:</b> ${statusLabel}
<b>Severidad:</b> ${severity}
📅 <b>Hora del Evento:</b> <code>${eventTime}</code>
<b>Host/Equipo:</b> ${hostName}${snPart}${reasonPart}

📝 <b>Detalle del Evento (Zabbix):</b>
${eventName}
${triggerDesc ? `\n<i>Descripción: ${triggerDesc}</i>` : ''}

⚠️ <i>Nota: Alerta enviada sin enriquecimiento de Smart OLT (Modo Independiente).</i>
`;
  }

  await sendMessage(targetChatId, enrichedText.trim());
  return { sn, enriched: smartOltEnriched, sent: true };
}

/**
 * Handle incoming alerts from Zabbix (Webhook Push workflow).
 * IMPORTANT: Respond 202 immediately so Zabbix doesn't timeout and retry.
 * All corroboration and Telegram delivery happens async in the background.
 */
router.post('/zabbix', (req, res) => {
  const payload = req.body;
  console.log('Received Zabbix webhook payload:', JSON.stringify(payload));

  // Acknowledge immediately — Zabbix will not retry
  res.json({ status: 'received' });

  // Process in the background (fire-and-forget)
  processZabbixAlert(payload).catch(err => {
    console.error('❌ Unhandled error in processZabbixAlert:', err.message);
  });
});

/**
 * Core async logic for a Zabbix alert (runs after the HTTP 200 is already sent).
 *
 * Flow for PROBLEM events with a known SN:
 *   1. Update cache & broadcast map update immediately.
 *   2. Start a settle timer (SMARTOLT_SETTLE_SECS). During this window, if an
 *      OK/recovery arrives for the same SN, the alert is cancelled silently.
 *   3. When the timer fires, re-query Smart OLT with FRESH live data.
 *   4. Compare: if Zabbix says PROBLEM and OLT confirms Offline → send alert.
 *      If they disagree → suppress.
 *
 * Flow for OK events:
 *   - If a pending timer exists for this SN → cancel it (power restored in time).
 *   - If no pending timer (alert already sent) → process the recovery immediately.
 *
 * Flow for events without SN → process immediately (no corroboration possible).
 */
async function processZabbixAlert(payload) {
  const eventName   = payload.event_name   || payload.trigger_name || '';
  const triggerDesc = payload.trigger_description || '';
  const eventStatus = payload.event_status || payload.status || 'PROBLEM';

  const sn = payload.onu_sn || payload.sn ||
             extractSerialNumber(eventName) ||
             extractSerialNumber(triggerDesc);

  // ── Immediate cache update & WebSocket broadcast ──────────────────────────
  // Update the map right away so the frontend reflects the Zabbix event
  // even before Smart OLT confirms.
  if (sn) {
    const optimisticStatus = eventStatus === 'PROBLEM' ? 'Offline' : 'Online';
    const updatedNap = updateOnuStatusInCache(sn, optimisticStatus);
    if (updatedNap) broadcast('nap_status_update', updatedNap);
  }

  // ── OK / Recovery ─────────────────────────────────────────────────────────
  if (eventStatus === 'OK') {
    if (sn) {
      const cleanSn = sn.toUpperCase();
      if (pendingAlerts.has(cleanSn)) {
        // Recovery arrived before the settle window expired → cancel the pending alert
        clearTimeout(pendingAlerts.get(cleanSn).timeoutId);
        pendingAlerts.delete(cleanSn);
        console.log(`[Recovery] SN ${cleanSn}: recovered before Smart OLT settle window — alert cancelled.`);
        return;
      }
    }
    // No pending alert → settle window already passed, alert was already sent.
    // Process recovery immediately so the engineer knows service is restored.
    try {
      const result = await processAndSendAlert(payload, null, '');
      if (result.sent === false) {
        console.log(`[Recovery not sent] SN: ${result.sn || 'N/A'}, reason: ${result.reason}`);
      }
    } catch (err) {
      console.error('Failed to send Telegram recovery message:', err.message);
    }
    return;
  }

  // ── PROBLEM without SN → send immediately (no corroboration possible) ────
  if (!sn) {
    // Check if it's a Board/Port level alert
    const portInfo = extractBoardAndPort(eventName + ' ' + triggerDesc);
    if (portInfo) {
      try {
        await processPortAlert(payload, portInfo.board, portInfo.port);
      } catch (err) {
        console.error('Failed to process port alert:', err.message);
      }
      return;
    }

    // Fallback to independent mode
    try {
      const result = await processAndSendAlert(payload, null, '');
      if (result.sent === false) {
        console.log(`[Alert not sent] No SN, reason: ${result.reason}`);
      }
    } catch (err) {
      console.error('Failed to send Telegram alert (no SN):', err.message);
    }
    return;
  }

  // ── PROBLEM with SN → enter Smart OLT settle window ──────────────────────
  const cleanSn  = sn.toUpperCase();
  const settleMs = getSettleMs();

  // If another PROBLEM came in for the same SN, restart the settle timer
  if (pendingAlerts.has(cleanSn)) {
    clearTimeout(pendingAlerts.get(cleanSn).timeoutId);
    console.log(`[Settle] SN ${cleanSn}: duplicate PROBLEM received, resetting settle timer.`);
  }

  console.log(`[Settle] SN ${cleanSn}: waiting ${settleMs / 1000}s for Smart OLT to register the event...`);

  const timeoutId = setTimeout(async () => {
    pendingAlerts.delete(cleanSn);
    console.log(`[Settle] SN ${cleanSn}: settle window elapsed. Re-querying Smart OLT with live data...`);

    // ── Re-query Smart OLT with FRESH data after the settle window ───────────
    let freshOnu            = null;
    let freshOltStatusReason = '';

    try {
      freshOnu = await findOnuBySn(cleanSn);

      if (freshOnu) {
        const liveStatus = await getOnuStatus(freshOnu.external_id);
        if (liveStatus && liveStatus.status) {
          // Override stale API cache status with real-time hardware status
          freshOnu.status = liveStatus.status;

          const reason = (liveStatus.last_down_reason || liveStatus.offline_reason || '').toLowerCase();
          console.log(`[Settle] SN ${cleanSn}: Smart OLT live reason = "${reason}"`);

          if (reason.includes('dying') || reason.includes('power') || reason.includes('gasp') || reason.includes('off')) {
            freshOltStatusReason = 'Corte de Energía (Dying Gasp)';
          } else if (reason.includes('los') || reason.includes('signal') || reason.includes('fibra') || reason.includes('link') || reason.includes('down')) {
            freshOltStatusReason = 'Pérdida de Señal (LOS)';
          } else if (reason) {
            freshOltStatusReason = liveStatus.last_down_reason || liveStatus.offline_reason;
          }
        }
      }
    } catch (err) {
      console.error(`[Settle] SN ${cleanSn}: Smart OLT query failed after settle — ${err.message}`);
    }

    // ── Compare & send ───────────────────────────────────────────────────────
    try {
      const result = await processAndSendAlert(payload, freshOnu, freshOltStatusReason);
      if (result.sent === false) {
        console.log(`[Settle] Alert suppressed for SN ${cleanSn}: ${result.reason}`);
      } else {
        console.log(`[Settle] Alert sent for SN ${cleanSn} after Smart OLT corroboration.`);
      }
    } catch (err) {
      console.error(`[Settle] Failed to send Telegram alert for ${cleanSn}:`, err.message);
    }
  }, settleMs);

  pendingAlerts.set(cleanSn, { timeoutId, payload });
}

/**
 * Handle incoming updates from Telegram (Bot listener workflow).
 * IMPORTANT: Respond 200 immediately — Telegram will retry if we take > 60s.
 * All processing happens asynchronously in the background.
 */
router.post('/telegram', (req, res) => {
  // Acknowledge receipt to Telegram instantly — prevents retries and duplicates
  res.json({ ok: true });

  const update = req.body;
  if (update && update.message) {
    handleTelegramMessage(update.message).catch(err => {
      console.error('❌ Error in handleTelegramMessage:', err.message);
    });
  }
});

/**
 * Common logic to handle an incoming Telegram message (used by Webhook and Polling)
 */
export async function handleTelegramMessage(message) {
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const text = message.text;
  
  // Ignore messages from bots (including ourselves) to avoid loops
  if (message.from && message.from.is_bot) {
    return;
  }
  
  if (!text) return;

  const upperText = text.toUpperCase();
  if (upperText.startsWith('/SYNC') || upperText.startsWith('/FALLAS') || upperText.startsWith('/STATUS_FALLAS')) {
    try {
      await replyToMessage(chatId, messageId, '🔄 Iniciando sincronización de fallas activas con Zabbix y Smart OLT. Por favor espere...');
      await syncActiveProblems(chatId);
    } catch (err) {
      console.error('Error handling sync bot command:', err.message);
    }
    return;
  }
  
  // Look for a Serial Number
  const sn = extractSerialNumber(text);
  
  if (sn) {
    console.log(`Detected Serial Number ${sn} in Telegram message from chat ${chatId}. Querying Smart OLT...`);
    
    const isProblem = text.toUpperCase().includes('PROBLEM') || 
                      text.toUpperCase().includes('ALERTA') || 
                      text.toUpperCase().includes('CORTE') || 
                      text.toUpperCase().includes('LOSS') || 
                      text.toUpperCase().includes('FAIL');
    
    // Update local cache and broadcast WebSocket update immediately
    const cacheStatus = isProblem ? 'Offline' : 'Online';
    const updatedNap = updateOnuStatusInCache(sn, cacheStatus);
    if (updatedNap) {
      broadcast('nap_status_update', updatedNap);
    }

    const statusInfo = parseStatusInfo(text);
    const statusEmoji = isProblem ? '🔴' : '🟢';
    const statusLabel = isProblem ? statusInfo.status : 'Servicio Operativo / Online';
    
    // Set priority title
    let priorityTitle = '';
    if (!isProblem) {
      priorityTitle = `🟢 <b>SERVICIO RESTABLECIDO</b>`;
    } else if (statusInfo.category === 'loss') {
      priorityTitle = `🚨🔴 <b>ALERTA CRÍTICA: PÉRDIDA DE SEÑAL</b>`;
    } else if (statusInfo.category === 'power_fail') {
      priorityTitle = `⚡🔌 <b>ALERTA: CORTE DE ENERGÍA</b>`;
    } else {
      priorityTitle = `${statusEmoji} <b>ALERTA DETECTADA</b>`;
    }
    
    let smartOltEnriched = false;
    let onu = null;

    try {
      onu = await findOnuBySn(sn);
      
      if (onu) {
        let oltStatusReason = '';
        try {
          console.log(`Querying live status for ONU ${onu.external_id} (${sn}) on Smart OLT...`);
          const liveStatus = await getOnuStatus(onu.external_id);
          if (liveStatus && liveStatus.status) {
            const reason = (liveStatus.last_down_reason || liveStatus.offline_reason || '').toLowerCase();
            console.log(`Smart OLT live reason for ${sn}: "${reason}"`);
            
            if (reason.includes('dying') || reason.includes('power') || reason.includes('gasp') || reason.includes('off')) {
              oltStatusReason = 'Corte de Energía (Dying Gasp)';
            } else if (reason.includes('los') || reason.includes('signal') || reason.includes('fibra') || reason.includes('link') || reason.includes('down')) {
              oltStatusReason = 'Pérdida de Señal (LOS)';
            } else if (reason) {
              oltStatusReason = liveStatus.last_down_reason || liveStatus.offline_reason;
            }
          }
        } catch (err) {
          console.error(`[Telegram bot Smart OLT live status query failed]:`, err.message);
        }

        let category = statusInfo.category;
        if (oltStatusReason === 'Corte de Energía (Dying Gasp)') {
          category = 'power_fail';
        } else if (oltStatusReason === 'Pérdida de Señal (LOS)') {
          category = 'loss';
        }

        // Corroboration verification for bot
        let canSend = true;
        if (category === 'power_fail' || category === 'loss') {
          const isOltOnline = (onu.status || '').toLowerCase() === 'online' || (onu.status || '').toLowerCase() === 'active';
          
          if (isProblem && isOltOnline) {
            console.log(`[Corroboration Blocked] Bot: Zabbix reports PROBLEM but Smart OLT reports ONU as Online/Active for SN "${sn}". Skipping reply.`);
            canSend = false;
          } else if (!isProblem && !isOltOnline) {
            console.log(`[Corroboration Blocked] Bot: Zabbix reports OK but Smart OLT reports ONU as Offline/Down for SN "${sn}". Skipping reply.`);
            canSend = false;
          }
        }

        if (canSend) {
          const eventTime = extractEventTime(text);
          const replyText = await generateNapReport(
            onu,
            isProblem ? 'PROBLEM' : 'OK',
            'Info',
            onu.olt_name || 'OLT Principal',
            text,
            statusEmoji,
            statusLabel,
            priorityTitle,
            oltStatusReason,
            eventTime
          );
          
          await replyToMessage(chatId, messageId, replyText.trim());
          smartOltEnriched = true;
          console.log(`Successfully replied with details for ${sn}`);
        } else {
          // If blocked, we shouldn't trigger fallback either. We set smartOltEnriched = true to bypass fallback block.
          smartOltEnriched = true;
        }
      }
    } catch (smartOltError) {
      console.error(`[Telegram bot Smart OLT query failed]:`, smartOltError.message);
    }

    if (!smartOltEnriched) {
      // For power_fail or loss signal, do NOT reply if it's not corroborated (e.g. Smart OLT down or ONU not found)
      const statusInfoForFallback = parseStatusInfo(text);
      if (statusInfoForFallback.category === 'power_fail' || statusInfoForFallback.category === 'loss') {
        console.log(`[Corroboration Blocked] Bot: Power fail or Loss signal not enriched. Skipping fallback reply.`);
        return;
      }

      // Fallback response for Telegram listener bot (Zabbix standalone)
      const isZabbixAlert = text.toUpperCase().includes('ZABBIX') || 
                            text.toUpperCase().includes('ALERTA') || 
                            text.toUpperCase().includes('PROBLEM') ||
                            text.toUpperCase().includes('RESOLVED');
                            
      if (isZabbixAlert) {
        const fallbackText = `
${priorityTitle}
• <b>Nro. Serie Detectado:</b> <code>${sn}</code>

⚠️ <i>Nota: No se pudieron cargar los datos de Smart OLT (Modo Independiente).</i>
📝 <i>Alerta original: ${text}</i>
`.trim();
        await replyToMessage(chatId, messageId, fallbackText);
      }
    }
  } else {
    // Intercept non-SN alerts that match a port signature
    const portInfo = extractBoardAndPort(text);
    if (portInfo) {
      try {
        const payload = { ...message, event_name: text, host_name: 'Desconocido', event_status: upperText.includes('PROBLEM') ? 'PROBLEM' : 'OK', chat_id: chatId };
        await processPortAlert(payload, portInfo.board, portInfo.port);
      } catch (err) {
        const errorMsg = `❌ Error procesando el webhook de Telegram: ${err.message}`;
        await replyToMessage(chatId, messageId, errorMsg);
      }
    }
  }
}

/**
 * Process a Zabbix alert for an entire GPON/EPON port.
 * Queries Smart OLT for all ONUs on the port, filters offline clients,
 * and sends a consolidated Telegram message.
 */
async function processPortAlert(payload, board, port) {
  const eventName = payload.event_name || payload.trigger_name || '';
  const hostName = payload.host_name || payload.host || '';
  const eventStatus = payload.event_status || payload.status || 'PROBLEM';
  const targetChatId = payload.chat_id || DEFAULT_CHAT_ID;

  if (eventStatus !== 'PROBLEM') {
    const recMsg = `🟢 <b>SERVICIO RESTABLECIDO EN PUERTO OLT</b>\n\n• <b>Puerto:</b> Tarjeta ${board} / Puerto ${port}\n• <b>OLT:</b> ${hostName}\n\n<i>Las ONUs de este puerto deberían volver a estar Online en breve.</i>`;
    await sendMessage(targetChatId, recMsg);
    return;
  }

  console.log(`[Port Alert] Detected GPON Port failure: Board ${board}, Port ${port} on OLT ${hostName}`);
  
  // 1. Fetch ONUs for this port
  const onusOnPort = await findOnusByPort(null, board, port, hostName);
  
  if (!onusOnPort || onusOnPort.length === 0) {
    console.log(`[Port Alert] No ONUs found on Smart OLT for Board ${board} Port ${port}. Sending fallback.`);
    const fallbackMsg = `🚨🔴 <b>CAÍDA DE PUERTO GPON</b>\n\n• <b>Puerto:</b> Tarjeta ${board} / Puerto ${port}\n• <b>OLT:</b> ${hostName}\n\n⚠️ <i>No se encontraron clientes registrados en este puerto en Smart OLT.</i>`;
    await sendMessage(targetChatId, fallbackMsg);
    return;
  }
  
  // 2. Filter ONUs that are offline
  const offlineOnus = onusOnPort.filter(o => {
    const s = (o.status || '').toLowerCase();
    return s !== 'online' && s !== 'active';
  });
  
  // Group by NAP for better readability
  const naps = {};
  offlineOnus.forEach(o => {
    const nap = extractNapBox(o.address) || extractNapBox(o.description) || 'NAP Desconocida';
    if (!naps[nap]) naps[nap] = [];
    naps[nap].push(o);
  });
  
  const totalClients = onusOnPort.length;
  const offlineCount = offlineOnus.length;
  const percentage = ((offlineCount / totalClients) * 100).toFixed(1);
  const eventTime = extractEventTime(payload);
  
  if (offlineCount === 0) {
    let reportText = `🚨🔴 <b>CAÍDA MASIVA DE PUERTO GPON</b>\n\n`;
    reportText += `<b>Puerto Afectado:</b> Tarjeta ${board} | Puerto PON ${port}\n`;
    reportText += `<b>OLT:</b> ${hostName}\n`;
    reportText += `📅 <b>Hora del Evento:</b> <code>${eventTime}</code>\n\n`;
    reportText += `📊 <b>Resumen de Afectación:</b>\n`;
    reportText += `• Total Clientes en el Puerto: <b>${totalClients}</b>\n`;
    reportText += `• Clientes Caídos (Offline): <b>0</b>\n\n`;
    reportText += `⚠️ <i>Smart OLT aún reporta los clientes como Online. Esto puede deberse al delay de sincronización de la OLT.</i>\n`;
    await sendMessage(targetChatId, reportText.trim());
    return;
  }

  const BATCH_SIZE = 32;
  const totalChunks = Math.ceil(offlineCount / BATCH_SIZE);

  for (let i = 0; i < totalChunks; i++) {
    const chunkOnus = offlineOnus.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    
    let reportText = `🚨🔴 <b>CAÍDA MASIVA DE PUERTO GPON (Parte ${i + 1}/${totalChunks})</b>\n\n`;
    
    if (i === 0) {
      reportText += `<b>Puerto Afectado:</b> Tarjeta ${board} | Puerto PON ${port}\n`;
      reportText += `<b>OLT:</b> ${hostName}\n`;
      reportText += `📅 <b>Hora del Evento:</b> <code>${eventTime}</code>\n\n`;
      reportText += `📊 <b>Resumen de Afectación:</b>\n`;
      reportText += `• Total Clientes en el Puerto: <b>${totalClients}</b>\n`;
      reportText += `• Clientes Caídos (Offline): <b>${offlineCount}</b> (<b>${percentage}%</b>)\n`;
    }
    
    reportText += `\n👥 <b>Detalle de Clientes (Mostrando ${chunkOnus.length} clientes):</b>\n`;
    
    // Group this chunk by NAP
    const chunkNaps = {};
    chunkOnus.forEach(o => {
      const nap = extractNapBox(o.address) || extractNapBox(o.description) || 'NAP Desconocida';
      if (!chunkNaps[nap]) chunkNaps[nap] = [];
      chunkNaps[nap].push(o);
    });
    
    for (const [nap, clients] of Object.entries(chunkNaps)) {
      reportText += `\n📦 <b>${nap}</b> (${clients.length} clientes):\n`;
      clients.forEach(c => {
        reportText += `  🔴 ${c.name} (<code>${c.sn}</code>)\n`;
      });
    }
    
    await sendMessage(targetChatId, reportText.trim());
  }
  
  console.log(`[Port Alert] Successfully sent port summary for Board ${board} Port ${port} in ${totalChunks} messages. Affected: ${offlineCount}`);
}

// GET /webhook/debug - Debug environment paths
router.get('/debug', (req, res) => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const cacheDir = path.resolve(__dirname, '../../data');
  const cacheFile = path.join(cacheDir, 'nap_cache.json');
  const csvPath = path.resolve(__dirname, '../public/coordenadas_mymaps.csv');

  res.json({
    cwd: process.cwd(),
    __dirname,
    cacheDir,
    cacheFile,
    cacheFileExists: fs.existsSync(cacheFile),
    csvPath,
    csvPathExists: fs.existsSync(csvPath),
    cachedNapsCount: getCachedNaps().length
  });
});

export default router;
