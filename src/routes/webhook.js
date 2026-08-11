import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findOnuBySn, findOnusByAddressQuery, findOnusByPort, getOnuStatus } from '../services/smartOlt.js';
import { sendMessage, replyToMessage } from '../services/telegram.js';
import { extractSerialNumber, extractNapBox, parseStatusInfo, extractEventTime, formatDateTime, extractBoardAndPort } from '../utils/parser.js';
import { broadcast } from '../services/websocket.js';
import { updateOnuStatusInCache, getCachedNaps, updateNapCoordinates, updateNapCoordinatesBulk, getStatusHistory, deleteHistoryItem, clearHistory, resolveHistoryItem } from '../services/cache.js';
import { getActiveTriggers } from '../services/zabbix.js';

const router = express.Router();
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// Keep strict cross-validation by default. Set SMARTOLT_REQUIRE_CORROBORATION=false
// when Smart OLT is unavailable and Zabbix alerts must still be delivered.
const REQUIRE_SMARTOLT_CORROBORATION =
  (process.env.SMARTOLT_REQUIRE_CORROBORATION || 'true').trim().toLowerCase() !== 'false';
const PORT_CORRELATION_ENABLED =
  (process.env.PORT_CORRELATION_ENABLED || 'true').trim().toLowerCase() !== 'false';

const getPositiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// GET /webhook/naps - Returns current status of all NAPs
router.get('/naps', (req, res) => {
  res.json(getCachedNaps());
});

// GET /webhook/history - Returns state change history events
router.get('/history', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 500;
  const filter = req.query.filter || 'all';
  res.json({
    status: 'success',
    total: getStatusHistory(5000, filter).length,
    history: getStatusHistory(limit, filter)
  });
});

// GET /webhook/status-history - Alias for history
router.get('/status-history', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 500;
  const filter = req.query.filter || 'all';
  res.json({
    status: 'success',
    total: getStatusHistory(5000, filter).length,
    history: getStatusHistory(limit, filter)
  });
});

// DELETE /webhook/history/:id - Delete a specific notification from history
router.delete('/history/:id', (req, res) => {
  const deleted = deleteHistoryItem(req.params.id);
  if (deleted) {
    res.json({ status: 'success', message: 'Notification deleted', item: deleted });
  } else {
    res.status(404).json({ error: 'Notification not found' });
  }
});

// DELETE /webhook/history - Clear all or resolved notifications
router.delete('/history', (req, res) => {
  const mode = req.query.mode || 'all'; // 'all' or 'resolved'
  const remaining = clearHistory(mode);
  res.json({ status: 'success', message: `History cleared (${mode})`, remainingCount: remaining.length });
});

// PATCH /webhook/history/:id/resolve - Mark notification as solved/resolved
router.patch('/history/:id/resolve', (req, res) => {
  const updated = resolveHistoryItem(req.params.id);
  if (updated) {
    res.json({ status: 'success', message: 'Notification marked as resolved', item: updated });
  } else {
    res.status(404).json({ error: 'Notification not found' });
  }
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
  return (!isNaN(secs) && secs >= 0) ? secs * 1_000 : 2_000; // default 2s (ultra-fast response)
};

// Zabbix often reports one event per ONU even when the underlying incident is a
// PON-port outage. Keep a short, per-port buffer so the final notification can
// report the real impact instead of flooding Telegram with individual alerts.
const pendingPortIncidents = new Map();

const getPortCorrelationMs = () =>
  getPositiveNumber(process.env.PORT_CORRELATION_WINDOW_SECS, 3) * 1_000;

const isOnline = (onu) => ['online', 'active'].includes(String(onu?.status || '').toLowerCase());

function portIncidentKey(onu, payload) {
  const olt = String(onu.olt_id || onu.olt_name || payload.host_name || payload.host || 'unknown').toLowerCase();
  return `${olt}:${onu.board}:${onu.port}`;
}

function cancelPendingPortIncidentForOnu(sn) {
  const normalizedSn = String(sn || '').toUpperCase();
  for (const [key, incident] of pendingPortIncidents) {
    incident.sns.delete(normalizedSn);
    if (incident.sns.size === 0) {
      clearTimeout(incident.timeoutId);
      pendingPortIncidents.delete(key);
    }
  }
}

function queuePortIncident(payload, onu, oltStatusReason = '') {
  if (!PORT_CORRELATION_ENABLED || onu?.board === undefined || onu?.port === undefined) return false;

  const key = portIncidentKey(onu, payload);
  let incident = pendingPortIncidents.get(key);
  if (!incident) {
    incident = {
      payload,
      onu,
      oltStatusReason,
      sns: new Set(),
      timeoutId: null
    };
    pendingPortIncidents.set(key, incident);
  }

  incident.sns.add(String(onu.sn || payload.onu_sn || '').toUpperCase());
  incident.payload = payload;
  incident.onu = onu;
  incident.oltStatusReason = oltStatusReason || incident.oltStatusReason;
  clearTimeout(incident.timeoutId);
  incident.timeoutId = setTimeout(() => {
    pendingPortIncidents.delete(key);
    sendCorrelatedPortReport(incident).catch(err => {
      console.error(`[Port correlation] Failed for ${key}:`, err.message);
    });
  }, getPortCorrelationMs());

  console.log(`[Port correlation] Queued ${incident.sns.size} ONU event(s) for ${key}.`);
  return true;
}

export async function sendCorrelatedPortReport(incident) {
  const { payload, onu, sns, oltStatusReason } = incident;
  const targetChatId = payload.chat_id || DEFAULT_CHAT_ID;
  const hostName = onu.olt_name || payload.host_name || payload.host || 'OLT Desconocida';
  const onusOnPort = await findOnusByPort(onu.olt_id || null, onu.board, onu.port, hostName);
  const offlineOnus = onusOnPort.filter(candidate => !isOnline(candidate));
  const totalClients = onusOnPort.length;
  const offlineCount = offlineOnus.length;
  const percentage = totalClients ? ((offlineCount / totalClients) * 100).toFixed(1) : 'N/A';
  const minOffline = getPositiveNumber(process.env.PORT_OUTAGE_MIN_OFFLINE, 3);
  const minPercentage = getPositiveNumber(process.env.PORT_OUTAGE_MIN_PERCENT, 30);
  const isPortOutage = offlineCount >= minOffline && Number(percentage) >= minPercentage;
  const zabbixSns = [...sns].filter(Boolean);
  const offlineDetail = offlineOnus.slice(0, 20)
    .map(candidate => `• 🔴 ${candidate.name || 'Sin nombre'} (<code>${candidate.sn || 'N/A'}</code>)`)
    .join('\n') || '• Smart OLT aún no reporta ONUs Offline.';
  const title = isPortOutage
    ? '🚨🔴 <b>POSIBLE CAÍDA DE PUERTO OLT CORROBORADA</b>'
    : '⚠️ <b>INCIDENTE PARCIAL EN PUERTO OLT CORROBORADO</b>';

  const report = `${title}\n\n` +
    `<b>OLT:</b> ${hostName}\n` +
    `<b>Puerto afectado:</b> Tarjeta ${onu.board} | PON ${onu.port}\n` +
    `<b>Eventos detectados por Zabbix:</b> ${zabbixSns.length}\n` +
    `<b>ONUs reportadas por Zabbix:</b> ${zabbixSns.map(sn => `<code>${sn}</code>`).join(', ') || 'N/A'}\n` +
    `<b>Validación Smart OLT:</b> ${offlineCount}/${totalClients} ONUs Offline (${percentage}%)\n` +
    (oltStatusReason ? `<b>Última causa OLT:</b> ${oltStatusReason}\n` : '') +
    `📅 <b>Hora del evento:</b> <code>${extractEventTime(payload)}</code>\n\n` +
    `<b>Detalle Smart OLT:</b>\n${offlineDetail}` +
    (offlineCount > 20 ? `\n<i>…y ${offlineCount - 20} ONUs más.</i>` : '') +
    `\n\n<i>Correlación Zabbix + Smart OLT completada en ${getPortCorrelationMs() / 1000}s.</i>`;

  await sendMessage(targetChatId, report);
  console.log(`[Port correlation] Sent report for ${hostName}, board ${onu.board}, port ${onu.port}. Offline: ${offlineCount}/${totalClients}.`);
}

/**
 * Helper to generate a detailed NAP connectivity report.
 * If no NAP box is found in the ONU details, falls back to a clean individual customer report.
 */
/**
 * Helper to generate a detailed NAP connectivity report.
 * If no NAP box is found in the ONU details, falls back to a clean individual customer report.
 */
async function generateNapReport(onu, eventStatus, severity, hostName, eventName, statusEmoji, statusLabel, priorityTitle, oltStatusReason = '', eventTime = '') {
  // Extract NAP Box identifier from all possible fields
  const napBox = (onu.odb_name ? onu.odb_name.trim() : '') || 
                 (onu.odb ? onu.odb.trim() : '') || 
                 extractNapBox(onu.address) || 
                 extractNapBox(onu.description) || 
                 extractNapBox(onu.name) || 
                 extractNapBox(onu.zone);

  const publicUrl = (process.env.PUBLIC_URL || '').trim();
  
  // Search NAP in local cache for geographic coordinates
  let coordsText = '';
  let cachedNap = null;
  if (napBox) {
    cachedNap = getCachedNaps().find(n => n.name.toUpperCase() === napBox.toUpperCase());
    if (cachedNap && cachedNap.latitude && cachedNap.longitude) {
      const gmapsLink = `https://maps.google.com/?q=${cachedNap.latitude.toFixed(6)},${cachedNap.longitude.toFixed(6)}`;
      coordsText = `\n📍 <b>Ubicación NAP:</b> <code>[${cachedNap.latitude.toFixed(6)}, ${cachedNap.longitude.toFixed(6)}]</code> | 🗺️ <a href="${gmapsLink}">Ver en Google Maps</a>`;
    }
  }

  const napDisplay = napBox ? `<code>${napBox}</code>` : '<i>No identificada en el sistema</i>';
  const napLink = (napBox && publicUrl) ? `<a href="${publicUrl}/?nap=${encodeURIComponent(napBox)}"><b>${napBox}</b></a>` : napDisplay;

  // Build technical diagnostic explanation based on failure type
  let techExplanation = '';
  const reasonLower = (oltStatusReason || '').toLowerCase();
  const isLoss = reasonLower.includes('los') || reasonLower.includes('signal') || reasonLower.includes('fibra') || parseStatusInfo(eventName).category === 'loss';
  const isPower = reasonLower.includes('power') || reasonLower.includes('dying') || reasonLower.includes('gasp') || parseStatusInfo(eventName).category === 'power_fail';

  if (eventStatus === 'OK') {
    techExplanation = `\n💡 <b>Diagnóstico:</b> El enlace óptico y la alimentación eléctrica se encuentran estables. La ONU volvió a registrarse exitosamente en la OLT.`;
  } else if (isLoss) {
    techExplanation = `\n💡 <b>Diagnóstico Técnico:</b> Pérdida de potencia óptica (LOS). La ONU no recibe luz de la OLT.\n• <b>Causas probables:</b> Corte de acometida, rotura de fibra en troncal, conector desconectado o daño físico en la caja NAP.`;
  } else if (isPower) {
    techExplanation = `\n💡 <b>Diagnóstico Técnico:</b> Corte de energía eléctrica (Dying Gasp). La ONU se apagó por falta de suministro eléctrico.\n• <b>Causas probables:</b> Corte de luz en el sector/domicilio, desconexión de fuente de poder o daño en el transformador.`;
  } else {
    techExplanation = `\n💡 <b>Diagnóstico Técnico:</b> Interrupción de comunicación detectada entre la OLT y la ONU.`;
  }

  // Query other ONUs on this NAP (prefer local memory cache if available)
  let onusOnNap = [];
  if (napBox) {
    try {
      if (cachedNap && cachedNap.clients && cachedNap.clients.length > 0) {
        onusOnNap = cachedNap.clients;
      } else {
        onusOnNap = await findOnusByAddressQuery(napBox);
      }
    } catch (err) {
      console.error(`[Smart OLT error querying NAP ONUs]:`, err.message);
    }
  }

  if (!napBox || !onusOnNap || onusOnNap.length === 0) {
    let singleEmoji = statusEmoji;
    let singleLabel = statusLabel;
    let singleTitle = priorityTitle;
    let singleReason = oltStatusReason;
    let singleTechExplanation = techExplanation;

    if (eventStatus === 'OK') {
      singleEmoji = '🟢';
      singleLabel = 'OK (Restablecido)';
      singleTitle = '🟢 <b>SERVICIO RESTABLECIDO</b>';
      singleTechExplanation = '\n💡 <b>Diagnóstico:</b> El enlace óptico y la alimentación eléctrica se encuentran estables. La ONU volvió a registrarse exitosamente en la OLT.';
    } else {
      const isExplicitLoss = reasonLower.includes('los') || reasonLower.includes('signal') || reasonLower.includes('fibra');
      if (isExplicitLoss) {
        singleEmoji = '🔴';
        singleLabel = 'Pérdida de Señal (Loss of Signal)';
        singleTitle = '🚨🔴 <b>ALERTA CRÍTICA: PÉRDIDA DE SEÑAL</b>';
        singleTechExplanation = '\n💡 <b>Diagnóstico Técnico:</b> Pérdida de potencia óptica (LOS). La ONU no recibe luz de la OLT.\n• <b>Causas probables:</b> Corte de acometida, rotura de fibra en troncal o conector desconectado.';
      } else {
        // Individual ONU not detected -> Power Fail
        singleEmoji = '🔌';
        singleLabel = 'Corte de Energía (Power Fail)';
        singleTitle = '⚡🔌 <b>ALERTA: CORTE DE ENERGÍA</b>';
        singleReason = (oltStatusReason && !oltStatusReason.toLowerCase().includes('los') && !oltStatusReason.toLowerCase().includes('signal'))
          ? oltStatusReason
          : 'Corte de Energía (Dying Gasp / ONU no detectada)';
        singleTechExplanation = '\n💡 <b>Diagnóstico Técnico:</b> Falla de alimentación eléctrica (Power Fail). La ONU no responde por falta de suministro eléctrico.\n• <b>Causas probables:</b> Corte de luz en el domicilio, transformador desconectado o ONU apagada.';
      }
    }

    const boxLabel = napBox ? napLink + coordsText : '<i>No identificada en el sistema</i>';

    return `
${singleTitle}

📦 <b>Caja NAP:</b> ${boxLabel}
👤 <b>Cliente:</b> <b>${onu.name}</b>
🔢 <b>Nro. de Serie (SN):</b> <code>${onu.sn}</code>
🏠 <b>Dirección:</b> ${onu.address || 'No especificada'}
🏢 <b>OLT:</b> ${onu.olt_name || hostName} | <b>Puerto PON:</b> Slot ${onu.board || 'N/A'} / Puerto ${onu.port || 'N/A'} | <b>ONU ID:</b> ${onu.onu_id || 'N/A'}

⚡ <b>Detalle del Incidente:</b>
• <b>Estado:</b> ${singleEmoji} <b>${singleLabel}</b> (${severity})
${eventTime ? `• 📅 <b>Hora del Evento:</b> <code>${eventTime}</code>\n` : ''}${singleReason ? `• 🔌 <b>Causa Reportada OLT:</b> <code>${singleReason}</code>\n` : ''}${singleTechExplanation}

ℹ️ <i>Evento Zabbix: ${eventName}</i>
`.trim();
  }

  // Calculate NAP statistics
  const totalClients = onusOnNap.length;
  const offlineOnus = onusOnNap.filter(o => {
    const s = (o.status || '').toLowerCase();
    return s !== 'online' && s !== 'active';
  });

  const totalOffline = offlineOnus.length;
  const totalOnline = totalClients - totalOffline;
  const percentageDown = ((totalOffline / totalClients) * 100).toFixed(1);

  // Business Rules:
  // - If the NAP loses signal (all clients down or totalOnline === 0 in multi-client NAP) -> Loss of Signal
  // - If only an individual ONU in the NAP is not detected (totalOnline > 0) -> Power Fail
  const isNapTotalLoss = (totalClients > 1 && totalOffline === totalClients) || (totalClients > 1 && totalOnline === 0);
  const isNapPartialLoss = totalOffline > 1 && totalOnline > 0;
  const isIndividualIncident = totalOffline <= 1 || totalOnline > 0;

  let effectiveEmoji = statusEmoji;
  let effectiveStatusLabel = statusLabel;
  let effectiveTitle = priorityTitle;
  let effectiveTechExplanation = '';
  let effectiveReason = oltStatusReason;

  if (eventStatus === 'OK') {
    effectiveEmoji = '🟢';
    effectiveStatusLabel = 'OK (Restablecido)';
    effectiveTitle = '🟢 <b>SERVICIO RESTABLECIDO</b>';
    effectiveTechExplanation = '\n💡 <b>Diagnóstico:</b> El enlace óptico y la alimentación eléctrica se encuentran estables. La ONU volvió a registrarse exitosamente en la OLT.';
  } else if (isNapTotalLoss) {
    effectiveEmoji = '🔴';
    effectiveStatusLabel = 'Pérdida de Señal (Loss of Signal)';
    effectiveTitle = '🚨🔴 <b>ALERTA CRÍTICA: PÉRDIDA DE SEÑAL EN NAP</b>';
    effectiveReason = oltStatusReason || 'Pérdida de Potencia Óptica (LOS)';
    effectiveTechExplanation = '\n💡 <b>Diagnóstico Técnico:</b> Pérdida total de potencia óptica (LOS). La caja NAP completa no recibe luz de la OLT.\n• <b>Causas probables:</b> Rotura de fibra troncal, corte de acometida general o daño físico en la caja NAP.';
  } else if (isNapPartialLoss) {
    effectiveEmoji = '⚠️';
    effectiveStatusLabel = 'Pérdida Parcial de Señal en NAP';
    effectiveTitle = '⚠️ <b>ALERTA: CAÍDA PARCIAL EN CAJA NAP</b>';
    effectiveReason = oltStatusReason || 'Caída múltiple de clientes en NAP';
    effectiveTechExplanation = '\n💡 <b>Diagnóstico Técnico:</b> Varios clientes en la misma caja NAP están sin señal. Posible problema en splitter o acometidas compartidas.';
  } else {
    // Individual undetected ONU on a working NAP with other online clients -> Power Fail
    effectiveEmoji = '🔌';
    effectiveStatusLabel = 'Corte de Energía (Power Fail)';
    effectiveTitle = '⚡🔌 <b>ALERTA: CORTE DE ENERGÍA</b>';
    effectiveReason = (oltStatusReason && !oltStatusReason.toLowerCase().includes('los') && !oltStatusReason.toLowerCase().includes('signal'))
      ? oltStatusReason
      : 'Corte de Energía (Dying Gasp / ONU no detectada)';
    effectiveTechExplanation = '\n💡 <b>Diagnóstico Técnico:</b> Falla de alimentación eléctrica (Power Fail). La caja NAP mantiene señal óptica normal en los demás clientes.\n• <b>Causas probables:</b> Corte de luz en el domicilio/sector, transformador desconectado o ONU apagada.';
  }

  // Filter only affected / failing ONUs
  let affectedOnus = onusOnNap.filter(o => {
    const isThisOne = (o.sn || '').toUpperCase() === (onu.sn || '').toUpperCase();
    const isOnlineClient = (o.status || '').toLowerCase() === 'online' || (o.status || '').toLowerCase() === 'active';
    if (eventStatus !== 'OK' && isThisOne) return true;
    return !isOnlineClient;
  });

  if (eventStatus !== 'OK' && affectedOnus.length === 0) {
    affectedOnus = [onu];
  }

  // Build client list with failing / affected ONUs only
  const clientLines = affectedOnus.map(o => {
    const isThisOne = (o.sn || '').toUpperCase() === (onu.sn || '').toUpperCase();
    const isOnlineClient = (o.status || '').toLowerCase() === 'online' || (o.status || '').toLowerCase() === 'active';
    const statusDot = (eventStatus === 'OK' && isThisOne) ? '🟢' : (isOnlineClient ? '🟢' : '🔴');
    const nameLabel = o.name;
    return `  ${statusDot} ${nameLabel}`;
  });

  const clientSectionTitle = affectedOnus.length > 1
    ? `👥 <b>Detalle de Clientes Afectados en esta NAP (${affectedOnus.length}):</b>`
    : '👥 <b>Detalle de Clientes en esta NAP:</b>';

  const clientSectionBody = clientLines.length > 0
    ? clientLines.join('\n')
    : '  ✨ <i>Todos los clientes en esta NAP se encuentran con servicio normal.</i>';

  const napWarning = totalOffline === totalClients 
    ? '🛑 <b>¡CAÍDA TOTAL DE LA CAJA NAP!</b> (Todos los clientes están sin servicio)'
    : totalOffline > 1 
      ? `⚠️ <b>¡CAÍDA PARCIAL EN LA CAJA NAP!</b> (${totalOffline} de ${totalClients} clientes caídos)`
      : 'ℹ️ <b>Incidente Individual</b> (Solo 1 cliente afectado; los demás clientes de la NAP tienen señal normal)';

  let lastActiveNapInfo = '';
  if (eventStatus !== 'OK' && isNapTotalLoss) {
    try {
      const onusOnPort = await findOnusByPort(onu.olt_id, onu.board, onu.port, onu.olt_name || hostName);
      if (onusOnPort && onusOnPort.length > 0) {
        const napGroups = {};
        onusOnPort.forEach(o => {
          const n = (o.odb_name ? o.odb_name.trim() : '') || extractNapBox(o.address) || extractNapBox(o.description);
          if (n) {
            if (!napGroups[n]) napGroups[n] = { name: n, online: 0, total: 0 };
            napGroups[n].total++;
            const isO = (o.status || '').toLowerCase() === 'online' || (o.status || '').toLowerCase() === 'active';
            if (isO) napGroups[n].online++;
          }
        });

        const sortedNaps = Object.keys(napGroups).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
        let lastActiveIdx = -1;
        for (let i = sortedNaps.length - 1; i >= 0; i--) {
          if (napGroups[sortedNaps[i]].online > 0) {
            lastActiveIdx = i;
            break;
          }
        }

        if (lastActiveIdx !== -1) {
          const lastActiveNap = sortedNaps[lastActiveIdx];
          const nextInactiveNap = sortedNaps[lastActiveIdx + 1];
          const cutEstimation = nextInactiveNap 
            ? `\n📍 <b>Punto de corte estimado en troncal:</b> Entre <b>${lastActiveNap}</b> y <b>${nextInactiveNap}</b>`
            : `\n📍 <b>Punto de corte estimado:</b> Posterior a <b>${lastActiveNap}</b> (Falla de acometida individual)`;
          lastActiveNapInfo = `\n\n📶 <b>Última NAP con señal en el puerto:</b> <b>${lastActiveNap}</b>${cutEstimation}`;
        }
      }
    } catch (err) {
      console.error('Error calculating last active NAP:', err.message);
    }
  }

  return `
${effectiveTitle}

📦 <b>Caja NAP:</b> ${napLink}${coordsText}
👤 <b>Cliente:</b> <b>${onu.name}</b>
🔢 <b>Nro. de Serie (SN):</b> <code>${onu.sn}</code>
🏠 <b>Dirección:</b> ${onu.address || 'No especificada'}
🏢 <b>OLT:</b> ${onu.olt_name || hostName} | <b>Puerto PON:</b> Slot ${onu.board || 'N/A'} / Puerto ${onu.port || 'N/A'} | <b>ONU ID:</b> ${onu.onu_id || 'N/A'}

⚡ <b>Detalle del Incidente:</b>
• <b>Estado:</b> ${effectiveEmoji} <b>${effectiveStatusLabel}</b> (${severity})
${eventTime ? `• 📅 <b>Hora del Evento:</b> <code>${eventTime}</code>\n` : ''}${effectiveReason ? `• 🔌 <b>Causa Reportada OLT:</b> <code>${effectiveReason}</code>\n` : ''}${effectiveTechExplanation}

📊 <b>Estado de la Caja NAP (${napBox}):</b>
• Total Clientes en esta NAP: <b>${totalClients}</b>
• 🟢 Activos (Online): <b>${totalOnline}</b>
• 🔴 Afectados (Offline): <b>${totalOffline}</b> (<b>${percentageDown}%</b>)
• <b>Diagnóstico:</b> ${napWarning}${lastActiveNapInfo}

${clientSectionTitle}
${clientSectionBody}

ℹ️ <i>Evento Zabbix: ${eventName}</i>
`.trim();
}

/**
 * Helper to process and send a Zabbix alert to Telegram (reusable for immediate & delayed alerts).
 */
export async function processAndSendAlert(payload, prefetchedOnu = null, prefetchedOltStatusReason = '', options = {}) {
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
      if (REQUIRE_SMARTOLT_CORROBORATION) {
        console.log(`[Corroboration Blocked] Event category "${category}" for SN "${sn}" was not enriched with Smart OLT. Skipping Telegram notification.`);
        return { sn, enriched: false, sent: false, reason: 'Not enriched' };
      }
      console.warn(`[Smart OLT fallback] Sending ${category} alert for SN "${sn}" using Zabbix data only.`);
    }
    
    // Compare states only when Smart OLT returned an ONU to compare against.
    if (smartOltEnriched && onu) {
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

  if (!options.suppressSend) {
    await sendMessage(targetChatId, enrichedText.trim());
  }
  return { sn, enriched: smartOltEnriched, sent: !options.suppressSend };
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
    const statusInfo = parseStatusInfo(eventName + ' ' + triggerDesc);
    const eventTime = extractEventTime(payload);
    const updatedNap = updateOnuStatusInCache(sn, optimisticStatus, {
      reason: eventName || triggerDesc || (eventStatus === 'PROBLEM' ? 'Falla detectada' : 'Restablecido'),
      category: statusInfo.category,
      eventTime
    });
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
        cancelPendingPortIncidentForOnu(cleanSn);
        console.log(`[Recovery] SN ${cleanSn}: recovered before Smart OLT settle window — alert cancelled.`);
        return;
      }
      // A recovery inside the port-correlation window removes this ONU from
      // the pending consolidated report.
      cancelPendingPortIncidentForOnu(cleanSn);
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

    // ── Compare and either queue a port report or send an individual fallback ─
    try {
      const canCorrelatePort = PORT_CORRELATION_ENABLED && freshOnu && !isOnline(freshOnu) &&
        freshOnu.board !== undefined && freshOnu.port !== undefined;
      const result = await processAndSendAlert(
        payload,
        freshOnu,
        freshOltStatusReason,
        { suppressSend: canCorrelatePort }
      );
      if (result.sent === false) {
        if (canCorrelatePort && result.enriched) {
          queuePortIncident(payload, freshOnu, freshOltStatusReason);
        } else {
          console.log(`[Settle] Alert suppressed for SN ${cleanSn}: ${result.reason || 'No corroborated output'}`);
        }
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

  if (upperText.startsWith('/START') || upperText.startsWith('/AYUDA') || upperText.startsWith('/HELP')) {
    try {
      const helpMsg = `🤖 <b>Asistente de Monitoreo Zabbix & Smart OLT</b>

Comandos disponibles:
• 🔍 <code>/buscar &lt;nombre / NAP / SN&gt;</code> - Busca clientes o cajas NAP por nombre o serie.
• 📦 <code>/nap &lt;nombre NAP&gt;</code> - Consulta estado detallado de una caja NAP (ej: <code>/nap SM-7030-1</code>).
• ⚠️ <code>/fallas</code> o <code>/sync</code> - Muestra las alertas y cortes activos en la red.
• 🗺️ <code>/mapa</code> - Enlace directo al mapa de cajas NAP en tiempo real.
• 🆔 <code>/id</code> - Muestra el ID de este chat de Telegram.

<i>💡 También puedes escribir directamente el número de serie de una ONU (ej: <code>HWTC12345678</code>) o el nombre de una caja NAP para consultar su información al instante.</i>`;
      await replyToMessage(chatId, messageId, helpMsg);
    } catch (err) {
      console.error('Error handling /ayuda command:', err.message);
    }
    return;
  }

  if (upperText.startsWith('/MAPA')) {
    try {
      const publicUrl = (process.env.PUBLIC_URL || '').trim();
      const mapMsg = publicUrl 
        ? `🗺️ <b>Monitor de Cajas NAP en Tiempo Real</b>\n\nAccede al mapa interactivo aquí:\n🔗 <a href="${publicUrl}">${publicUrl}</a>`
        : `🗺️ <b>Monitor de Cajas NAP:</b> <code>PUBLIC_URL</code> no configurado en el servidor.`;
      await replyToMessage(chatId, messageId, mapMsg);
    } catch (err) {
      console.error('Error handling /mapa command:', err.message);
    }
    return;
  }

  if (upperText.startsWith('/BUSCAR') || upperText.startsWith('/NAP') || upperText.startsWith('/INFO')) {
    try {
      const query = text.replace(/^\/(buscar|nap|info)\s*/i, '').trim();
      if (!query) {
        await replyToMessage(chatId, messageId, 'ℹ️ Por favor ingresa el texto a buscar.\nEjemplos:\n• <code>/buscar SM-7030-1</code>\n• <code>/buscar Juan Perez</code>\n• <code>/buscar HWTC12345678</code>');
        return;
      }
      await handleSearchQuery(chatId, messageId, query);
    } catch (err) {
      console.error('Error handling /buscar command:', err.message);
      await replyToMessage(chatId, messageId, `❌ Error al buscar: ${err.message}`);
    }
    return;
  }

  if (upperText.startsWith('/ID')) {
    try {
      await replyToMessage(
        chatId,
        messageId,
        `🆔 <b>ID de este chat:</b> <code>${chatId}</code>\n<b>Tipo:</b> ${message.chat.type || 'desconocido'}`
      );
    } catch (err) {
      console.error('Error handling /id command:', err.message);
    }
    return;
  }

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
      // Strict mode suppresses loss/power alerts unless Smart OLT corroborates them.
      const statusInfoForFallback = parseStatusInfo(text);
      if (REQUIRE_SMARTOLT_CORROBORATION && (statusInfoForFallback.category === 'power_fail' || statusInfoForFallback.category === 'loss')) {
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
      reportText += `🏢 <b>OLT:</b> ${hostName}\n`;
      reportText += `🔌 <b>Puerto PON Afectado:</b> Slot ${board} | Puerto PON ${port}\n`;
      reportText += `📅 <b>Hora del Evento:</b> <code>${eventTime}</code>\n\n`;
      reportText += `📊 <b>Resumen de Afectación:</b>\n`;
      reportText += `• Total Clientes en el Puerto: <b>${totalClients}</b>\n`;
      reportText += `• 🔴 Clientes Caídos (Offline): <b>${offlineCount}</b> (<b>${percentage}%</b> de afectación)\n`;
      reportText += `• 🟢 Clientes Operativos (Online): <b>${totalClients - offlineCount}</b>\n`;
    }
    
    reportText += `\n👥 <b>Afectación Desglosada por Caja NAP:</b>\n`;
    
    // Group this chunk by NAP
    const chunkNaps = {};
    chunkOnus.forEach(o => {
      const nap = (o.odb_name ? o.odb_name.trim() : '') || (o.odb ? o.odb.trim() : '') || extractNapBox(o.address) || extractNapBox(o.description) || extractNapBox(o.name) || 'NAP Desconocida';
      if (!chunkNaps[nap]) chunkNaps[nap] = [];
      chunkNaps[nap].push(o);
    });
    
    for (const [nap, clients] of Object.entries(chunkNaps)) {
      const cachedNap = getCachedNaps().find(n => n.name.toUpperCase() === nap.toUpperCase());
      const mapLink = (cachedNap && cachedNap.latitude && cachedNap.longitude) 
        ? ` (<a href="https://maps.google.com/?q=${cachedNap.latitude},${cachedNap.longitude}">GPS</a>)` 
        : '';
      reportText += `\n📦 <b>Caja NAP: ${nap}</b>${mapLink} - <b>${clients.length} cliente(s) caído(s):</b>\n`;
      clients.forEach(c => {
        reportText += `  🔴 ${c.name} (<code>${c.sn}</code>)\n`;
      });
    }
    
    await sendMessage(targetChatId, reportText.trim());
  }
  
  console.log(`[Port Alert] Successfully sent port summary for Board ${board} Port ${port} in ${totalChunks} messages. Affected: ${offlineCount}`);
}

/**
 * Helper to handle interactive search queries from Telegram users (/buscar, /nap, /info).
 */
async function handleSearchQuery(chatId, messageId, query) {
  const cleanQuery = query.trim();
  const upperQuery = cleanQuery.toUpperCase();
  const cachedNaps = getCachedNaps();

  // 1. Check if query matches a NAP Box name (exact or partial)
  const matchedNap = cachedNaps.find(n => n.name.toUpperCase() === upperQuery) ||
                     cachedNaps.find(n => n.name.toUpperCase().includes(upperQuery));

  if (matchedNap) {
    const publicUrl = (process.env.PUBLIC_URL || '').trim();
    const napLink = publicUrl ? `<a href="${publicUrl}/?nap=${encodeURIComponent(matchedNap.name)}"><b>${matchedNap.name}</b></a>` : `<b>${matchedNap.name}</b>`;
    
    let coordsText = '<i>Sin coordenadas GPS registradas</i>';
    if (matchedNap.latitude && matchedNap.longitude) {
      const gmaps = `https://maps.google.com/?q=${matchedNap.latitude.toFixed(6)},${matchedNap.longitude.toFixed(6)}`;
      coordsText = `<code>[${matchedNap.latitude.toFixed(6)}, ${matchedNap.longitude.toFixed(6)}]</code> | 🗺️ <a href="${gmaps}">Ver en Google Maps</a>`;
    }

    const statusEmoji = matchedNap.status === 'online' ? '🟢' : (matchedNap.status === 'partial' ? '⚠️' : '🔴');
    const statusLabel = matchedNap.status === 'online' ? 'Estable / Online' : (matchedNap.status === 'partial' ? 'Parcialmente Afectada' : 'Caída Total');

    const clientLines = (matchedNap.clients || []).map(c => {
      const isOnline = (c.status || '').toLowerCase() === 'online' || (c.status || '').toLowerCase() === 'active';
      const dot = isOnline ? '🟢' : '🔴';
      return `  ${dot} ${c.name} (<code>${c.sn}</code>) - <i>${c.status || 'Offline'}</i>`;
    });

    const reply = `
📦 <b>Información de Caja NAP: ${matchedNap.name}</b>

🏢 <b>OLT:</b> ${matchedNap.olt_name || 'ROUTER-FTTH'}
🔌 <b>Puerto PON:</b> Slot ${matchedNap.board || '0'} / Puerto ${matchedNap.port || '0'}
📍 <b>Ubicación:</b> ${coordsText}
📊 <b>Estado de la NAP:</b> ${statusEmoji} <b>${statusLabel}</b>

👥 <b>Abonados Conectados (${matchedNap.totalClients} total):</b>
• 🟢 Activos (Online): <b>${matchedNap.onlineClients}</b>
• 🔴 Caídos (Offline): <b>${matchedNap.offlineClients}</b>

📋 <b>Detalle de Clientes en esta NAP:</b>
${clientLines.length > 0 ? clientLines.join('\n') : '<i>No hay clientes registrados en esta NAP.</i>'}
`.trim();

    await replyToMessage(chatId, messageId, reply);
    return;
  }

  // 2. Check if query matches a Client SN or Name in cache
  let matchedClient = null;
  let clientNap = null;
  for (const nap of cachedNaps) {
    if (nap.clients) {
      const c = nap.clients.find(cl => (cl.sn || '').toUpperCase() === upperQuery || (cl.name || '').toUpperCase().includes(upperQuery));
      if (c) {
        matchedClient = c;
        clientNap = nap;
        break;
      }
    }
  }

  if (matchedClient && clientNap) {
    const isOnline = (matchedClient.status || '').toLowerCase() === 'online' || (matchedClient.status || '').toLowerCase() === 'active';
    const statusDot = isOnline ? '🟢' : '🔴';

    let coordsText = '';
    if (clientNap.latitude && clientNap.longitude) {
      const gmaps = `https://maps.google.com/?q=${clientNap.latitude.toFixed(6)},${clientNap.longitude.toFixed(6)}`;
      coordsText = `\n📍 <b>Coordenadas NAP:</b> <code>[${clientNap.latitude.toFixed(6)}, ${clientNap.longitude.toFixed(6)}]</code> | 🗺️ <a href="${gmaps}">Ver en Google Maps</a>`;
    }

    const reply = `
👤 <b>Información de Cliente: ${matchedClient.name}</b>

🔢 <b>Nro. de Serie (SN):</b> <code>${matchedClient.sn}</code>
📊 <b>Estado Actual:</b> ${statusDot} <b>${matchedClient.status || (isOnline ? 'Online' : 'Offline')}</b>
📦 <b>Caja NAP:</b> <code>${clientNap.name}</code>${coordsText}
🏢 <b>OLT:</b> ${clientNap.olt_name} | <b>Puerto:</b> Slot ${clientNap.board} / PON ${clientNap.port}
`.trim();

    await replyToMessage(chatId, messageId, reply);
    return;
  }

  // 3. Fallback: try querying Smart OLT directly
  try {
    const snMatch = extractSerialNumber(cleanQuery);
    if (snMatch) {
      const onu = await findOnuBySn(snMatch);
      if (onu) {
        const napBox = (onu.odb_name ? onu.odb_name.trim() : '') || extractNapBox(onu.address) || extractNapBox(onu.description) || 'No identificada';
        const isOnline = (onu.status || '').toLowerCase() === 'online' || (onu.status || '').toLowerCase() === 'active';
        const reply = `
👤 <b>Cliente Encontrado en Smart OLT: ${onu.name}</b>

🔢 <b>Nro. de Serie (SN):</b> <code>${onu.sn}</code>
📊 <b>Estado:</b> ${isOnline ? '🟢 Online' : '🔴 Offline'}
📦 <b>Caja NAP:</b> <code>${napBox}</code>
🏠 <b>Dirección:</b> ${onu.address || 'No especificada'}
🏢 <b>OLT:</b> ${onu.olt_name || 'OLT Principal'} | <b>Puerto PON:</b> Slot ${onu.board || '0'} / Puerto ${onu.port || '0'} | <b>ONU ID:</b> ${onu.onu_id || '0'}
`.trim();
        await replyToMessage(chatId, messageId, reply);
        return;
      }
    }
  } catch (err) {
    console.error('Error during fallback search query:', err.message);
  }

  await replyToMessage(chatId, messageId, `⚠️ No se encontraron cajas NAP ni clientes que coincidan con "<b>${cleanQuery}</b>".\n\n<i>Prueba buscando por nombre de cliente, serie (ej: <code>HWTC12345678</code>) o nombre de NAP (ej: <code>SM-7030-1</code>).</i>`);
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
