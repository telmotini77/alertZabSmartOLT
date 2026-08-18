import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchAllOnus, findOnuBySn, findOnusByAddressQuery, findOnusByPort, getOnuStatus } from '../services/smartOlt.js';
import { sendMessage, replyToMessage } from '../services/telegram.js';
import { extractSerialNumber, extractNapBox, parseStatusInfo, extractEventTime, formatDateTime, extractBoardAndPort } from '../utils/parser.js';
import { broadcast } from '../services/websocket.js';
import { updateOnuStatusInCache, getCachedNaps, updateNapCoordinates, updateNapCoordinatesBulk, getStatusHistory, deleteHistoryItem, clearHistory, resolveHistoryItem, updateHistoryEventDetails } from '../services/cache.js';
import { getActiveTriggers } from '../services/zabbix.js';
import { dbGetOpticalHistory, dbSaveOpticalRecord } from '../services/db.js';
import { PUBLIC_URL } from '../config/publicUrl.js';

const router = express.Router();
const DEFAULT_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_BOT_PUBLIC = (process.env.TELEGRAM_BOT_PUBLIC || 'true').trim().toLowerCase() !== 'false';

// Nearby OpenStreetMap places are cached briefly to avoid repeatedly querying
// Overpass while a field technician works with the same NAP.
const nearbyPlacesCache = new Map();
const NEARBY_CACHE_TTL_MS = 5 * 60 * 1000;
const OVERPASS_URL = (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter').trim();

// Optional dedicated group for Loss of Signal alerts (fibra cortada).
// If not set, LOS alerts fall back to DEFAULT_CHAT_ID.
// Power Fail and other alerts always go to DEFAULT_CHAT_ID.
const getLossChatId = () =>
  (process.env.TELEGRAM_LOS_CHAT_ID || '').trim() || DEFAULT_CHAT_ID;

const isTrustedTelegramChat = (chatId) => {
  const normalizedChatId = String(chatId);
  return [DEFAULT_CHAT_ID, getLossChatId()].some((allowedId) =>
    allowedId !== undefined && allowedId !== null && String(allowedId) === normalizedChatId
  );
};
// Keep strict cross-validation by default. Set SMARTOLT_REQUIRE_CORROBORATION=false
// when Smart OLT is unavailable and Zabbix alerts must still be delivered.
const REQUIRE_SMARTOLT_CORROBORATION =
  (process.env.SMARTOLT_REQUIRE_CORROBORATION || 'true').trim().toLowerCase() !== 'false';
const PORT_CORRELATION_ENABLED =
  (process.env.PORT_CORRELATION_ENABLED || 'false').trim().toLowerCase() === 'true';

const getPositiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeNapName = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9]/g, '')
  .toUpperCase();

const findCachedNap = (napName) => {
  const normalizedName = normalizeNapName(napName);
  if (!normalizedName) return null;
  return getCachedNaps().find((nap) => normalizeNapName(nap.name) === normalizedName) || null;
};

const getCoordinates = (source) => {
  const latitude = Number(source?.latitude ?? source?.gps_lat);
  const longitude = Number(source?.longitude ?? source?.gps_lng);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude !== 0 && longitude !== 0
    ? { latitude, longitude }
    : null;
};

const getMinimumNapClients = () => {
  const configured = Number.parseInt(process.env.NAP_LOSS_MIN_ONUS, 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 2;
};

// Avoid repeat notifications while the same NAP remains fully offline. The
// state is cleared as soon as any ONU in that NAP recovers.
const activeNapIncidentNotifications = new Set();

// A total NAP outage must be observed by both monitoring sources.  Zabbix
// contributes one fresh LOS event per ONU and Smart OLT contributes the live
// state of every ONU in the NAP.  Keeping this short-lived evidence prevents
// old/offline cache entries from being mistaken for a new NAP outage.
const zabbixNapLossEvidence = new Map();

const getNapEvidenceTtlMs = () =>
  getPositiveNumber(process.env.NAP_ZABBIX_EVIDENCE_SECS, 300) * 1_000;

const isOnuOnline = (onu) => ['online', 'active'].includes(String(onu?.status || '').toLowerCase());

const getFailureCategoryFromOltReason = (reason) => {
  const text = String(reason || '').toLowerCase();
  if (text.includes('dying') || text.includes('power') || text.includes('gasp') || text.includes('energ')) {
    return 'power_fail';
  }
  if (text.includes('los') || text.includes('signal') || text.includes('señal') || text.includes('fibra')) {
    return 'loss';
  }
  return 'unknown';
};

const getNapNameFromOnu = (onu) => String(
  onu?.odb_name || onu?.odb || extractNapBox(onu?.address) || extractNapBox(onu?.description) || ''
).trim();

function registerNapLossEvidence(nap, sn) {
  const key = normalizeNapName(nap?.name);
  const normalizedSn = String(sn || '').trim().toUpperCase();
  if (!key || !normalizedSn) return;

  const now = Date.now();
  const entry = zabbixNapLossEvidence.get(key) || new Map();
  entry.set(normalizedSn, now);
  zabbixNapLossEvidence.set(key, entry);
}

function clearNapLossEvidence(nap, sn) {
  const key = normalizeNapName(nap?.name);
  const normalizedSn = String(sn || '').trim().toUpperCase();
  const entry = zabbixNapLossEvidence.get(key);
  if (!entry || !normalizedSn) return;
  entry.delete(normalizedSn);
  if (entry.size === 0) zabbixNapLossEvidence.delete(key);
}

function hasCompleteFreshNapLossEvidence(nap) {
  const key = normalizeNapName(nap?.name);
  const entry = zabbixNapLossEvidence.get(key);
  const clients = nap?.clients || [];
  if (!entry || clients.length === 0) return false;

  const cutoff = Date.now() - getNapEvidenceTtlMs();
  for (const [sn, timestamp] of entry) {
    if (timestamp < cutoff) entry.delete(sn);
  }
  if (entry.size === 0) {
    zabbixNapLossEvidence.delete(key);
    return false;
  }

  return clients.every((client) => {
    const sn = String(client.sn || '').trim().toUpperCase();
    return sn && entry.has(sn);
  });
}

async function corroborateTotalNapIncidentWithSmartOlt(nap) {
  const napName = String(nap?.name || '').trim();
  if (!napName) return { confirmed: false, reason: 'NAP not identified' };

  try {
    let returnedOnus = await findOnusByAddressQuery(napName);
    const targetKey = normalizeNapName(napName);
    const minimumClients = getMinimumNapClients();
    let onus = returnedOnus.filter((onu) => normalizeNapName(getNapNameFromOnu(onu)) === targetKey);

    // Some Smart OLT installations store the NAP only in odb_name, which the
    // address query cannot search. Fall back to a complete OLT snapshot and
    // filter it locally so the corroboration remains accurate.
    if (onus.length < minimumClients) {
      returnedOnus = await fetchAllOnus();
      onus = returnedOnus.filter((onu) => normalizeNapName(getNapNameFromOnu(onu)) === targetKey);
    }

    if (onus.length < minimumClients) {
      return { confirmed: false, reason: `Smart OLT returned only ${onus.length} ONU(s) for ${napName}` };
    }
    if (onus.some(isOnuOnline)) {
      return { confirmed: false, reason: 'Smart OLT still reports online ONUs in the NAP' };
    }

    // Being 100% offline describes the impact, not the cause. If Smart OLT
    // reports Dying Gasp/Power Fail, this is an electrical incident affecting
    // the ONUs/routers and must never be announced as a fibre or NAP LOS.
    const causeCategories = onus.map((onu) => getFailureCategoryFromOltReason(
      onu.offline_reason || onu.last_down_reason || onu.status_reason || onu.reason || ''
    ));
    let powerFailureCount = causeCategories.filter((category) => category === 'power_fail').length;
    let lossCount = causeCategories.filter((category) => category === 'loss').length;

    // Some Smart OLT installations omit the last-down reason from the bulk
    // endpoint. Query one live ONU only when the whole snapshot has no cause,
    // keeping API usage low while avoiding an assumed/false LOS diagnosis.
    if (powerFailureCount === 0 && lossCount === 0) {
      const referenceOnu = onus.find((onu) => onu.external_id);
      if (referenceOnu) {
        try {
          const liveStatus = await getOnuStatus(referenceOnu.external_id);
          const liveCategory = getFailureCategoryFromOltReason(
            liveStatus?.last_down_reason || liveStatus?.offline_reason || ''
          );
          powerFailureCount = liveCategory === 'power_fail' ? 1 : 0;
          lossCount = liveCategory === 'loss' ? 1 : 0;
        } catch (error) {
          return { confirmed: false, reason: `Smart OLT cause lookup failed: ${error.message}` };
        }
      }
    }

    if (powerFailureCount > 0 && lossCount > 0) {
      return {
        confirmed: false,
        category: 'mixed',
        reason: `Smart OLT reports mixed causes (${powerFailureCount} power, ${lossCount} LOS)`
      };
    }
    if (powerFailureCount > 0) {
      return { confirmed: true, category: 'power_fail', onus, powerFailureCount };
    }
    if (lossCount > 0) {
      return { confirmed: true, category: 'loss', onus };
    }
    return { confirmed: false, reason: 'Smart OLT did not provide an electrical or optical failure cause' };
  } catch (error) {
    return { confirmed: false, reason: `Smart OLT query failed: ${error.message}` };
  }
}

// GET /webhook/naps - Returns current status of all NAPs
router.get('/naps', (req, res) => {
  res.json(getCachedNaps());
});

// GET /webhook/nearby-places?lat=-2.1&lng=-79.9&radius=1500
// Returns useful OpenStreetMap points around a NAP for on-site work.
router.get('/nearby-places', async (req, res) => {
  const latitude = Number(req.query.lat);
  const longitude = Number(req.query.lng);
  const requestedRadius = Number(req.query.radius);
  const radius = Number.isFinite(requestedRadius)
    ? Math.min(Math.max(Math.round(requestedRadius), 250), 5_000)
    : 1_500;
  const bypassCache = Boolean(req.query.refresh);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(400).json({ error: 'Valid lat and lng query parameters are required.' });
  }

  const cacheKey = `${latitude.toFixed(5)},${longitude.toFixed(5)},${radius}`;
  const cached = nearbyPlacesCache.get(cacheKey);
  if (!bypassCache && cached && Date.now() - cached.createdAt < NEARBY_CACHE_TTL_MS) {
    return res.json({ ...cached.payload, cached: true });
  }

  // Prioritize landmarks useful for locating or servicing equipment, without
  // returning every individual building nearby.
  const query = `[out:json][timeout:20];
(
  nwr["amenity"~"^(hospital|clinic|pharmacy|fuel|police|fire_station|bank|atm|restaurant|cafe|fast_food|bus_station)$"](around:${radius},${latitude},${longitude});
  nwr["shop"](around:${radius},${latitude},${longitude});
  nwr["public_transport"](around:${radius},${latitude},${longitude});
  nwr["highway"="bus_stop"](around:${radius},${latitude},${longitude});
);
out center tags;`;

  try {
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({ data: query }).toString(),
      signal: AbortSignal.timeout(25_000)
    });

    if (!response.ok) throw new Error(`Overpass returned HTTP ${response.status}`);

    const result = await response.json();
    const places = (result.elements || [])
      .map((place) => {
        const placeLat = place.lat ?? place.center?.lat;
        const placeLng = place.lon ?? place.center?.lon;
        if (!Number.isFinite(placeLat) || !Number.isFinite(placeLng)) return null;
        const tags = place.tags || {};
        return {
          id: `${place.type}/${place.id}`,
          name: tags.name || tags.brand || tags.operator || 'Lugar sin nombre',
          category: tags.amenity || tags.shop || tags.public_transport || (tags.highway === 'bus_stop' ? 'bus_stop' : 'place'),
          latitude: placeLat,
          longitude: placeLng,
          distance: Math.round(calculateDistanceMeters(latitude, longitude, placeLat, placeLng)),
          osmUrl: `https://www.openstreetmap.org/${place.type}/${place.id}`
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 50);

    const payload = { places, radius, cached: false };
    nearbyPlacesCache.set(cacheKey, { createdAt: Date.now(), payload });
    return res.json(payload);
  } catch (error) {
    console.error('Error fetching nearby OpenStreetMap places:', error.message);
    return res.status(502).json({
      error: 'No se pudieron consultar los sitios cercanos en este momento.',
      details: error.message
    });
  }
});

function calculateDistanceMeters(lat1, lng1, lat2, lng2) {
  const toRadians = (value) => value * Math.PI / 180;
  const earthRadius = 6_371_000;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLng = toRadians(lng2 - lng1);
  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLng / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// GET /webhook/test-telegram - Send a test message to verify Telegram connectivity
router.get('/test-telegram', async (req, res) => {
  const chatId = req.query.chat_id || DEFAULT_CHAT_ID;
  if (!chatId) {
    return res.status(400).json({ error: 'TELEGRAM_CHAT_ID not configured and no chat_id query param provided.' });
  }
  try {
    const result = await sendMessage(chatId,
      `✅ <b>Prueba de Conectividad Telegram</b>\n\n` +
      `🤖 El bot está activo y puede enviar mensajes correctamente.\n` +
      `📅 Hora: <code>${new Date().toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}</code>\n` +
      `💬 Chat ID: <code>${chatId}</code>\n` +
      `🌐 Servidor: <code>${PUBLIC_URL}</code>`
    );
    return res.json({ status: 'ok', message: 'Test message sent to Telegram successfully', chat_id: chatId, result });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message, chat_id: chatId });
  }
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
              onu.status = liveStatus.onu_status || liveStatus.status_desc || (liveStatus.status === true ? 'online' : 'offline'); // Override stale API cache with real-time hardware status
              const reason = (liveStatus.last_down_reason || liveStatus.offline_reason || '').toLowerCase();
              if (reason.includes('dying') || reason.includes('power') || reason.includes('gasp')) {
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
          
          const publicUrl = PUBLIC_URL;
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

function cancelPendingAlertsForNap(nap) {
  nap.clients?.forEach((client) => {
    const sn = String(client.sn || '').toUpperCase();
    const pending = pendingAlerts.get(sn);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingAlerts.delete(sn);
    }
  });
}

/**
 * Send a single NAP-level LOS report using the local cache. This path is
 * intentionally independent of Smart OLT availability: Zabbix has already
 * reported every router in the NAP down and the cache confirms 100% impact.
 */
async function sendCachedNapLossAlert(payload, nap, eventTime = '') {
  const referenceClient = nap.clients?.find((client) => client.sn);
  if (!referenceClient) return { sent: false, reason: 'NAP has no clients' };

  const totalClients = nap.totalClients || nap.clients.length;
  const representativeOnu = {
    sn: String(referenceClient.sn).toUpperCase(),
    name: referenceClient.name || nap.name,
    status: 'Offline',
    odb_name: nap.name,
    olt_name: nap.olt_name,
    board: nap.board,
    port: nap.port
  };
  const enrichedPayload = {
    ...payload,
    onu_sn: representativeOnu.sn,
    chat_id: getLossChatId(),  // Route LOS alerts to the dedicated LOS group
    event_name: payload.event_name || `NAP ${nap.name}: Loss of Signal`,
    trigger_description: `${payload.trigger_description || ''}\nCaída total confirmada: ${totalClients}/${totalClients} ONUs de la NAP ${nap.name} están sin señal.`.trim(),
    event_time: payload.event_time || eventTime
  };

  const result = await processAndSendAlert(
    enrichedPayload,
    representativeOnu,
    'Pérdida de Señal (LOS)'
  );
  console.log(`[NAP LOS] Sent consolidated cache-backed alert for ${nap.name}: ${totalClients}/${totalClients} ONUs offline.`);
  return result;
}

/**
 * Send one consolidated power-failure report when every ONU/router in a NAP
 * is offline and Smart OLT explicitly reports an electrical cause.
 */
async function sendCachedNapPowerFailAlert(payload, nap, confirmation, eventTime = '') {
  const referenceClient = nap.clients?.find((client) => client.sn);
  if (!referenceClient) return { sent: false, reason: 'NAP has no clients' };

  const totalClients = nap.totalClients || nap.clients.length;
  const representativeOnu = {
    ...(confirmation.onus?.[0] || {}),
    sn: String(referenceClient.sn).toUpperCase(),
    name: referenceClient.name || nap.name,
    status: 'Offline',
    odb_name: nap.name,
    olt_name: nap.olt_name,
    board: nap.board,
    port: nap.port
  };
  const enrichedPayload = {
    ...payload,
    onu_sn: representativeOnu.sn,
    chat_id: payload.chat_id || DEFAULT_CHAT_ID,
    event_name: `NAP ${nap.name}: Power failure detected`,
    trigger_description: `Corte de energía confirmado: ${totalClients}/${totalClients} ONU/router de la NAP ${nap.name} están apagados por falta de alimentación eléctrica.`,
    event_time: payload.event_time || eventTime
  };

  // Correct the optimistic LOS history entries created before Smart OLT
  // supplied the definitive electrical cause.
  nap.clients.forEach((client) => {
    updateHistoryEventDetails(client.sn, 'power_fail', 'Corte de Energía (Dying Gasp)');
  });

  const result = await processAndSendAlert(
    enrichedPayload,
    representativeOnu,
    'Corte de Energía (Dying Gasp)'
  );
  console.log(`[NAP Power Fail] Sent consolidated power alert for ${nap.name}: ${totalClients}/${totalClients} ONU/router offline.`);
  return result;
}

const getSettleMs = () => {
  if (process.env.NODE_ENV === 'test') return 100; // fast in tests
  const secs = parseFloat(process.env.SMARTOLT_SETTLE_SECS);
  return (!isNaN(secs) && secs >= 0) ? secs * 1_000 : 1_200; // default 1.2s (ultra-fast response)
};

// Zabbix often reports one event per ONU even when the underlying incident is a
// PON-port outage. Keep a short, per-port buffer so the final notification can
// report the real impact instead of flooding Telegram with individual alerts.
const pendingPortIncidents = new Map();

const getPortCorrelationMs = () =>
  getPositiveNumber(process.env.PORT_CORRELATION_WINDOW_SECS, 3) * 1_000;

// ─── Area Outage Detection ────────────────────────────────────────────────────
// Groups NAP drops that happen within AREA_OUTAGE_WINDOW_SECS seconds.
// After the window, compares OLT/port and GPS distance to determine if it's a
// localized area outage or unrelated individual failures.
const napOutageBuffer = new Map(); // key: napName, value: { nap, payload, timestamp }
let napOutageFlushTimer = null;

const getAreaOutageWindowMs = () =>
  getPositiveNumber(process.env.AREA_OUTAGE_WINDOW_SECS, 60) * 1_000;
const getAreaOutageRadiusKm = () =>
  getPositiveNumber(process.env.AREA_OUTAGE_RADIUS_KM, 2.0);

/** Haversine formula — returns distance in km between two GPS coords */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Feed a confirmed LOS NAP into the area outage buffer.
 * The window timer is (re)started each time a new NAP drops.
 * When it finally fires, analyzeAndSendAreaReport() is called.
 */
function feedNapOutageBuffer(napName, cachedNap, payload) {
  napOutageBuffer.set(napName.toUpperCase(), {
    nap: cachedNap,
    payload,
    timestamp: Date.now()
  });

  // Reset the flush timer every time a new NAP is added
  if (napOutageFlushTimer) clearTimeout(napOutageFlushTimer);
  napOutageFlushTimer = setTimeout(async () => {
    napOutageFlushTimer = null;
    const entries = [...napOutageBuffer.values()];
    napOutageBuffer.clear();
    try {
      await analyzeAndSendAreaReport(entries);
    } catch (err) {
      console.error('[Area Outage] Failed to send area report:', err.message);
    }
  }, getAreaOutageWindowMs());
}

/**
 * Analyze accumulated NAP drops and send one consolidated Telegram message.
 * Determines if drops are area-related (same port or close GPS) or unrelated.
 */
async function analyzeAndSendAreaReport(entries) {
  // Area outage = LOS affecting multiple NAPs → use the LOS chat group
  const chatId = getLossChatId();
  if (!chatId) return;
  if (entries.length === 0) return;

  // Single NAP: send individual alert (already queued separately, skip)
  if (entries.length === 1) return;

  const radiusKm = getAreaOutageRadiusKm();
  const now = new Date().toLocaleString('es-EC', { timeZone: 'America/Guayaquil' });

  // Group by OLT+Port key
  const portGroups = new Map();
  for (const entry of entries) {
    const { nap } = entry;
    const key = `${(nap.olt_name || 'unknown').toLowerCase()}:${nap.board}:${nap.port}`;
    if (!portGroups.has(key)) portGroups.set(key, []);
    portGroups.get(key).push(entry);
  }

  // Check geographic proximity for entries NOT in the same port
  let isAreaOutage = false;
  let areaType = 'independent'; // 'same_port' | 'geographic' | 'independent'
  let maxDistKm = 0;

  // If ANY group has 2+ NAPs on same port → it's a port-level area outage
  for (const group of portGroups.values()) {
    if (group.length >= 2) {
      isAreaOutage = true;
      areaType = 'same_port';
      break;
    }
  }

  // If not same port, check geographic proximity between all pairs
  if (!isAreaOutage && entries.length >= 2) {
    const withCoords = entries.filter(e => e.nap.latitude && e.nap.longitude);
    let closeCount = 0;
    for (let i = 0; i < withCoords.length; i++) {
      for (let j = i + 1; j < withCoords.length; j++) {
        const dist = haversineKm(
          withCoords[i].nap.latitude, withCoords[i].nap.longitude,
          withCoords[j].nap.latitude, withCoords[j].nap.longitude
        );
        if (dist > maxDistKm) maxDistKm = dist;
        if (dist <= radiusKm) closeCount++;
      }
    }
    if (closeCount > 0 && withCoords.length >= 2) {
      isAreaOutage = true;
      areaType = 'geographic';
    }
  }

  const totalAffected = entries.reduce((sum, e) => sum + (e.nap.totalClients || 0), 0);
  const napListLines = entries
    .sort((a, b) => (a.nap.name || '').localeCompare(b.nap.name || '', undefined, { numeric: true }))
    .map(e => {
      const n = e.nap;
      const offline = n.offlineClients ?? n.totalClients ?? '?';
      const total = n.totalClients ?? '?';
      const portTag = (n.board && n.port) ? ` — Slot ${n.board}/PON ${n.port}` : '';
      const coordsLink = (n.latitude && n.longitude)
        ? ` <a href="https://maps.google.com/?q=${n.latitude.toFixed(6)},${n.longitude.toFixed(6)}">📍</a>`
        : '';
      return `  • <b>${n.name}</b>${portTag} — ${offline}/${total} ONUs offline${coordsLink}`;
    }).join('\n');

  let message = '';
  if (isAreaOutage && areaType === 'same_port') {
    const sampleNap = entries[0].nap;
    message = `
🌐🚨 <b>CAÍDA EN ÁREA DETECTADA (MISMO PUERTO OLT)</b>

📡 <b>OLT:</b> ${sampleNap.olt_name || 'Desconocida'} | <b>Puerto PON:</b> Slot ${sampleNap.board} / Puerto ${sampleNap.port}
⚠️ <b>Diagnóstico:</b> Múltiples cajas NAP del mismo puerto caídas → probable corte de fibra troncal

📦 <b>NAPs afectadas (${entries.length}):</b>
${napListLines}

👥 <b>Clientes afectados estimados:</b> ${totalAffected}
📅 <b>Hora de detección:</b> <code>${now}</code>
`.trim();
  } else if (isAreaOutage && areaType === 'geographic') {
    const sampleNap = entries[0].nap;
    message = `
🌐⚠️ <b>CAÍDA EN ÁREA DETECTADA (PROXIMIDAD GEOGRÁFICA)</b>

📡 <b>OLT:</b> ${sampleNap.olt_name || 'Varias'}
⚠️ <b>Diagnóstico:</b> Caídas en un radio ≤ ${radiusKm} km → posible falla en fibra de distribución o sector eléctrico

📦 <b>NAPs afectadas (${entries.length}):</b>
${napListLines}

👥 <b>Clientes afectados estimados:</b> ${totalAffected}
📅 <b>Hora de detección:</b> <code>${now}</code>
`.trim();
  } else {
    // Not related — send a brief summary noting they're independent
    message = `
⚡ <b>MÚLTIPLES FALLAS INDEPENDIENTES DETECTADAS</b>

Se detectaron ${entries.length} caídas de NAP sin relación geográfica ni de red en los últimos ${Math.round(getAreaOutageWindowMs() / 60000)} min:

${napListLines}

📊 <b>Distancia máxima entre NAPs:</b> ${maxDistKm.toFixed(1)} km (umbral: ${radiusKm} km)
📅 <b>Hora de detección:</b> <code>${now}</code>
<i>Cada caída fue notificada individualmente.</i>
`.trim();
  }

  console.log(`[Area Outage] Sending ${areaType} area report for ${entries.length} NAPs.`);
  await sendMessage(chatId, message);
}

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

  const publicUrl = PUBLIC_URL;
  
  // Search NAP in local cache for geographic coordinates
  let coordsText = '';
  let cachedNap = null;
  let coordinates = null;
  if (napBox) {
    cachedNap = findCachedNap(napBox);
    // Cache coordinates are an average of associated ONUs, so they represent
    // an approximate NAP position. Use the affected ONU as a fallback while
    // the NAP cache is being built.
    coordinates = getCoordinates(cachedNap) || getCoordinates(onu);
    if (coordinates) {
      cachedNap = { ...(cachedNap || {}), ...coordinates };
      const gmapsLink = `https://maps.google.com/?q=${cachedNap.latitude.toFixed(6)},${cachedNap.longitude.toFixed(6)}`;
      coordsText = `\n📍 <b>Ubicación NAP:</b> <code>[${cachedNap.latitude.toFixed(6)}, ${cachedNap.longitude.toFixed(6)}]</code> | 🗺️ <a href="${gmapsLink}">Ver en Google Maps</a>`;
    }
  }

  if (coordinates) {
    const { latitude, longitude } = coordinates;
    const gmapsLink = `https://maps.google.com/?q=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
    coordsText = `\n📍 <b>Ubicación aproximada de la NAP:</b> <code>[${latitude.toFixed(6)}, ${longitude.toFixed(6)}]</code> | 🗺️ <a href="${gmapsLink}">Ver en Google Maps</a>`;
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
  } else if (isPower) {
    techExplanation = `\n💡 <b>Diagnóstico Técnico:</b> Corte de energía eléctrica (Dying Gasp). La ONU se apagó por falta de suministro eléctrico.\n• <b>Causas probables:</b> Corte de luz en el sector/domicilio, desconexión de fuente de poder o daño en el transformador.`;
  } else if (isLoss) {
    techExplanation = `\n💡 <b>Diagnóstico Técnico:</b> Pérdida de potencia óptica (LOS). La ONU no recibe luz de la OLT.\n• <b>Causas probables:</b> Corte de acometida, rotura de fibra en troncal, conector desconectado o daño físico en la caja NAP.`;
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
🏢 <b>OLT:</b> ${onu.olt_name || hostName} | <b>Puerto PON:</b> Slot ${onu.board || 'N/A'} / Puerto ${onu.port || 'N/A'}

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

  // A Power Fail is always reported as an ONU/router power incident.  Even if
  // several clients are down, it must never be relabelled as a fibre/NAP loss.
  const isNapTotalPowerFailure = isPower && totalClients > 0 && totalOffline === totalClients;
  const isNapTotalLoss = !isPower && ((totalClients > 1 && totalOffline === totalClients) || (totalClients > 1 && totalOnline === 0));
  const isNapPartialLoss = !isPower && totalOffline > 1 && totalOnline > 0;
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
    effectiveTechExplanation = '\n💡 <b>Diagnóstico:</b> El enlace óptico y la alimentación eléctrica se encuentran estables. La conexión volvió a registrarse exitosamente en la OLT.';
  } else if (isNapTotalPowerFailure) {
    effectiveEmoji = '🔌';
    effectiveStatusLabel = 'Corte de Energía (Power Fail)';
    effectiveTitle = '🔌⚡ <b>CORTE DE ENERGÍA EN ONU/ROUTERS DE LA NAP</b>';
    effectiveReason = oltStatusReason || 'Corte de Energía (Dying Gasp)';
    effectiveTechExplanation = '\n💡 <b>Diagnóstico Técnico:</b> Smart OLT confirma falta de alimentación eléctrica en las ONU/routers.\n• <b>Clasificación:</b> Power Fail; no es caída de caja NAP ni pérdida de señal óptica (LOS).';
  } else if (isNapTotalLoss) {
    effectiveEmoji = '🔴';
    effectiveStatusLabel = 'Pérdida de Señal (Loss of Signal)';
    effectiveTitle = '🚨🔴 <b>RIESGO ALTO: CAÍDA TOTAL EN CAJA NAP</b>';
    effectiveReason = oltStatusReason || 'Pérdida de Potencia Óptica (LOS)';
    effectiveTechExplanation = '\n💡 <b>Diagnóstico Técnico:</b> Pérdida total de potencia óptica (LOS). La caja NAP completa no recibe luz de la OLT.\n• <b>Causas probables:</b> Rotura de fibra troncal, corte de acometida general o daño físico en la caja NAP.';
  } else if (isNapPartialLoss) {
    effectiveEmoji = '⚠️';
    effectiveStatusLabel = 'Pérdida Parcial de Señal en NAP';
    effectiveTitle = isPower
      ? `🔌⚡ <b>RIESGO MEDIO: CORTE DE ENERGÍA PARCIAL EN NAP</b>`
      : `⚠️ <b>ALERTA: CAÍDA PARCIAL EN CAJA NAP</b>`;
    effectiveReason = oltStatusReason || 'Caída múltiple de conexiones en NAP';
    effectiveTechExplanation = '\n💡 <b>Diagnóstico Técnico:</b> Varias conexiones en la misma caja NAP están sin señal. Posible problema en splitter o acometidas compartidas.';
  } else {
    // Individual undetected ONU on a working NAP with other online clients
    effectiveEmoji = isPower ? '🔌' : '🔴';
    effectiveStatusLabel = isPower ? 'Corte de Energía (Power Fail)' : 'Pérdida de Señal (Loss of Signal)';
    effectiveTitle = isPower
      ? `🔌⚠️ <b>RIESGO BAJO: CORTE DE ENERGÍA INDIVIDUAL</b>`
      : `🚨🔴 <b>RIESGO ALTO: PÉRDIDA DE SEÑAL</b>`;
    effectiveReason = (oltStatusReason && !oltStatusReason.toLowerCase().includes('los') && !oltStatusReason.toLowerCase().includes('signal'))
      ? oltStatusReason
      : (isPower ? 'Corte de Energía (Dying Gasp / No detectada)' : 'Pérdida de Potencia Óptica (LOS)');
    effectiveTechExplanation = isPower
      ? '\n💡 <b>Diagnóstico Técnico:</b> Falla de alimentación eléctrica (Power Fail). La caja NAP mantiene señal óptica normal en las demás conexiones.\n• <b>Causas probables:</b> Corte de luz en el sector, transformador desconectado o equipo apagado.'
      : '\n💡 <b>Diagnóstico Técnico:</b> Pérdida de potencia óptica (LOS) en la acometida individual.\n• <b>Causas probables:</b> Acometida rota, conector suelto o atenuación excesiva.';
  }

  const napWarning = isNapTotalPowerFailure
    ? '🔌 <b>Power Fail en ONU/routers</b> (no clasificado como caída de NAP ni LOS)'
    : isNapTotalLoss
      ? '🛑 <b>¡CAÍDA TOTAL DE LA CAJA NAP!</b> (Todas las conexiones están sin servicio)'
    : isNapPartialLoss
      ? `⚠️ <b>¡CAÍDA PARCIAL EN LA CAJA NAP!</b> (${totalOffline} de ${totalClients} conexiones caídas)`
      : isPower
        ? 'ℹ️ <b>Incidente de energía en ONU/router</b> (no clasificado como caída de NAP)'
        : 'ℹ️ <b>Incidente Individual</b> (1 conexión afectada; las demás conexiones de la NAP operan normal)';

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
🏢 <b>OLT:</b> ${onu.olt_name || hostName} | <b>Puerto PON:</b> Slot ${onu.board || 'N/A'} / Puerto ${onu.port || 'N/A'}

⚡ <b>Detalle del Incidente:</b>
• <b>Estado:</b> ${effectiveEmoji} <b>${effectiveStatusLabel}</b> (${severity})
${eventTime ? `• 📅 <b>Hora del Evento:</b> <code>${eventTime}</code>\n` : ''}${effectiveReason ? `• 🔌 <b>Causa Reportada OLT:</b> <code>${effectiveReason}</code>\n` : ''}${effectiveTechExplanation}

📊 <b>Estado de la Caja NAP (${napBox}):</b>
• Total Conexiones: <b>${totalClients}</b>
• 🟢 Operativas (Online): <b>${totalOnline}</b>
• 🔴 Afectadas (Offline): <b>${totalOffline}</b> (<b>${percentageDown}%</b>)
• <b>Diagnóstico:</b> ${napWarning}${lastActiveNapInfo}

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
  // targetChatId may be overridden below if the event is classified as LOS
  let targetChatId = payload.chat_id || DEFAULT_CHAT_ID;
  
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
            onu.status = liveStatus.onu_status || liveStatus.status_desc || (liveStatus.status === true ? 'online' : 'offline');
            
            const reason = (liveStatus.last_down_reason || liveStatus.offline_reason || '').toLowerCase();
            console.log(`Smart OLT live reason for ${sn}: "${reason}"`);
            
            if (reason.includes('dying') || reason.includes('power') || reason.includes('gasp')) {
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

  // Fallback: Resolve ONU and NAP from local disk cache if Smart OLT API didn't return an ONU
  if (!onu && sn) {
    const cleanSn = sn.toUpperCase();
    const cachedNaps = getCachedNaps();
    for (const nap of cachedNaps) {
      if (nap.clients) {
        const client = nap.clients.find(c => (c.sn || '').toUpperCase() === cleanSn);
        if (client) {
          onu = {
            sn: cleanSn,
            name: client.name || cleanSn,
            status: client.status || 'Offline',
            odb_name: nap.name,
            olt_name: nap.olt_name,
            board: nap.board,
            port: nap.port,
            onu_id: client.onu_id || 'N/A'
          };
          smartOltEnriched = true;
          console.log(`[Cache Fallback] Resolved SN ${cleanSn} to NAP ${nap.name} from local cache.`);
          break;
        }
      }
    }
  }

  // Fallback 2: Check if alert mentions a NAP box directly
  if (!onu) {
    const napFromEvent = extractNapBox(eventName + ' ' + triggerDesc);
    if (napFromEvent) {
      const cachedNap = getCachedNaps().find(n => n.name.toUpperCase() === napFromEvent.toUpperCase());
      if (cachedNap) {
        onu = {
          sn: cachedNap.clients?.[0]?.sn || 'N/A',
          name: napFromEvent,
          status: 'Offline',
          odb_name: cachedNap.name,
          olt_name: cachedNap.olt_name,
          board: cachedNap.board,
          port: cachedNap.port
        };
        smartOltEnriched = true;
        console.log(`[Cache Fallback] Resolved direct NAP name "${napFromEvent}" from local cache.`);
      }
    }
  }

  // Parse alert category & status info
  const statusInfo = parseStatusInfo(eventName + ' ' + triggerDesc);
  
  // The alert type comes from Zabbix. Smart OLT corroborates it; it must not
  // silently turn a Zabbix LOS event into a Power Fail (or the reverse).
  const category = statusInfo.category;
  const oltReasonCategory = getFailureCategoryFromOltReason(oltStatusReason);

  if (sn && eventStatus === 'PROBLEM') {
    updateHistoryEventDetails(sn, category, oltStatusReason || statusInfo.status);
  }

  // Corroboration verification
  if (category === 'power_fail' || category === 'loss') {
    // Route Loss of Signal alerts to the dedicated LOS chat group
    if (category === 'loss') {
      targetChatId = getLossChatId();
    }
    if (!smartOltEnriched || !onu) {
      if (REQUIRE_SMARTOLT_CORROBORATION) {
        console.log(`[Corroboration Blocked] Event category "${category}" for SN "${sn}" was not enriched with Smart OLT. Skipping Telegram notification.`);
        return { sn, enriched: false, sent: false, reason: 'Not enriched' };
      }
      console.warn(`[Smart OLT fallback] Sending ${category} alert for SN "${sn}" using Zabbix data only.`);
    }

    if (oltReasonCategory !== 'unknown' && oltReasonCategory !== category) {
      const reason = `Cause mismatch (Zabbix ${category}, Smart OLT ${oltReasonCategory})`;
      if (REQUIRE_SMARTOLT_CORROBORATION) {
        console.log(`[Corroboration Blocked] ${reason} for SN "${sn}". Skipping Telegram notification.`);
        return { sn, enriched: true, sent: false, reason };
      }
      console.warn(`[Corroboration Mismatch Ignored] ${reason}.`);
    }
    
    // Compare states only when Smart OLT returned an ONU to compare against.
    if (smartOltEnriched && onu) {
      const isZabbixProblem = eventStatus === 'PROBLEM';
      const isOltOnline = (onu.status || '').toLowerCase() === 'online' || (onu.status || '').toLowerCase() === 'active';

      if (isZabbixProblem && isOltOnline) {
        if (REQUIRE_SMARTOLT_CORROBORATION) {
          console.log(`[Corroboration Blocked] State mismatch: Zabbix reports PROBLEM but Smart OLT reports ONU as Online/Active for SN "${sn}". Skipping Telegram notification.`);
          return { sn, enriched: true, sent: false, reason: 'State mismatch (Zabbix PROBLEM, OLT Online)' };
        }
        console.warn(`[Corroboration Mismatch Ignored] Zabbix reports PROBLEM but Smart OLT reports ONU as Online/Active for SN "${sn}". Proceeding because corroboration is not required.`);
      }

      if (!isZabbixProblem && !isOltOnline) {
        if (REQUIRE_SMARTOLT_CORROBORATION) {
          console.log(`[Corroboration Blocked] State mismatch: Zabbix reports OK but Smart OLT reports ONU as Offline/Down for SN "${sn}". Skipping Telegram notification.`);
          return { sn, enriched: true, sent: false, reason: 'State mismatch (Zabbix OK, OLT Offline)' };
        }
        console.warn(`[Corroboration Mismatch Ignored] Zabbix reports OK but Smart OLT reports ONU as Offline/Down for SN "${sn}". Proceeding because corroboration is not required.`);
      }
    }
  }

  // ── Apply Custom Notification Rules based on Risk Levels & Status ──
  if (eventStatus === 'OK') {
    // Suppress Telegram notifications for recovery (stable green NAP)
    console.log(`[Notification Filter] Suppressing Telegram recovery alert for SN "${sn}" as green connections are not notified.`);
    options.suppressSend = true;
  } else if (onu) {
    const napBox = (onu.odb_name ? onu.odb_name.trim() : '') || (onu.odb ? onu.odb.trim() : '') || extractNapBox(onu.address) || extractNapBox(onu.description);
    if (napBox) {
      const cachedNap = findCachedNap(napBox);
      if (cachedNap) {
        const totalClients = cachedNap.clients?.length || cachedNap.totalClients || 1;
        const offlineClients = cachedNap.clients?.filter(c => {
          const s = (c.status || '').toLowerCase();
          return s !== 'online' && s !== 'active';
        }).length || cachedNap.offlineClients || 0;
        
        const isTotalOffline = offlineClients === totalClients;
        const isPartialOffline = offlineClients > 0 && !isTotalOffline;
        
        if (isTotalOffline) {
          console.log(`[Notification Filter] NAP "${cachedNap.name}" is fully offline. Allowing Telegram alert (Riesgo Alto).`);
        } else if (isPartialOffline) {
          if (category === 'power_fail') {
            console.log(`[Notification Filter] Partial drop on NAP "${cachedNap.name}" due to power fail. Allowing Telegram alert (Riesgo Bajo/Medio).`);
          } else {
            console.log(`[Notification Filter] Suppressing Telegram alert for partial drop on NAP "${cachedNap.name}" (not a power failure).`);
            options.suppressSend = true;
          }
        }
      }
    }
  }

  const eventTime = extractEventTime(payload);

  const statusEmoji = eventStatus === 'OK' ? '🟢' : (category === 'power_fail' ? '🔌' : '🔴');
  const statusLabel = eventStatus === 'OK' ? 'OK (Restablecido)' : (category === 'power_fail' ? 'Corte de Energía' : 'Pérdida de Señal');

  // Set visual priority title based on category & status & custom risk levels
  let priorityTitle = '';
  if (eventStatus === 'OK') {
    priorityTitle = `🟢 <b>SERVICIO RESTABLECIDO</b>`;
  } else if (onu) {
    const napBox = (onu.odb_name ? onu.odb_name.trim() : '') || (onu.odb ? onu.odb.trim() : '') || extractNapBox(onu.address) || extractNapBox(onu.description);
    if (napBox) {
      const cachedNap = findCachedNap(napBox);
      if (cachedNap) {
        const totalClients = cachedNap.clients?.length || cachedNap.totalClients || 1;
        const offlineClients = cachedNap.clients?.filter(c => {
          const s = (c.status || '').toLowerCase();
          return s !== 'online' && s !== 'active';
        }).length || cachedNap.offlineClients || 0;
        
        const isTotalOffline = offlineClients === totalClients;
        
        if (isTotalOffline) {
          priorityTitle = `🚨🔴 <b>RIESGO ALTO: CAÍDA TOTAL EN CAJA NAP</b>`;
        } else if (category === 'power_fail') {
          if (offlineClients > 1) {
            priorityTitle = `🔌⚡ <b>RIESGO MEDIO: CORTE DE ENERGÍA PARCIAL EN NAP</b>`;
          } else {
            priorityTitle = `🔌⚠️ <b>RIESGO BAJO: CORTE DE ENERGÍA INDIVIDUAL</b>`;
          }
        }
      }
    }
  }

  if (!priorityTitle) {
    if (eventStatus === 'OK') {
      priorityTitle = `🟢 <b>SERVICIO RESTABLECIDO</b>`;
    } else if (category === 'loss') {
      priorityTitle = `🚨🔴 <b>RIESGO ALTO: PÉRDIDA DE SEÑAL</b>`;
    } else if (category === 'power_fail') {
      priorityTitle = `🔌⚡ <b>RIESGO MEDIO: CORTE DE ENERGÍA</b>`;
    } else {
      priorityTitle = `${statusEmoji} <b>ALERTA DE INFRAESTRUCTURA</b>`;
    }
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
    const sendOptions = {};
    if (onu) {
      const inlineButtons = [];
      const firstRow = [];
      
      const publicUrl = PUBLIC_URL;
      const napBox = (onu.odb_name ? onu.odb_name.trim() : '') || (onu.odb ? onu.odb.trim() : '') || extractNapBox(onu.address) || extractNapBox(onu.description);
      if (publicUrl && napBox) {
        firstRow.push({
          text: '🗺️ Ver en Mapa',
          url: `${publicUrl}/?nap=${encodeURIComponent(napBox)}`
        });
      }
      
      const coordinates = (napBox ? getCoordinates(findCachedNap(napBox)) : null) || getCoordinates(onu);
      if (coordinates) {
        firstRow.push({
          text: '📍 Google Maps',
          url: `https://www.google.com/maps/dir/?api=1&destination=${coordinates.latitude},${coordinates.longitude}`
        });
      }
      
      if (firstRow.length > 0) {
        inlineButtons.push(firstRow);
      }
      
      const botUsername = (process.env.BOT_USERNAME || '').trim().replace(/^@/, '');
      if (sn && botUsername) {
        inlineButtons.push([
          {
            text: '⚡ Diagnóstico Óptico en Vivo',
            url: `https://t.me/${botUsername}?start=diag_${sn.toUpperCase()}`
          }
        ]);
      }
      
      if (inlineButtons.length > 0) {
        sendOptions.reply_markup = {
          inline_keyboard: inlineButtons
        };
      }
    }
    await sendMessage(targetChatId, enrichedText.trim(), sendOptions);
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
export async function processZabbixAlert(payload) {
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
    const napNotificationKey = normalizeNapName(updatedNap?.name);

    if (statusInfo.category === 'loss') {
      if (eventStatus === 'PROBLEM') {
        registerNapLossEvidence(updatedNap, sn);
      } else {
        clearNapLossEvidence(updatedNap, sn);
      }
    }

    if (eventStatus === 'OK' && updatedNap?.status !== 'offline') {
      activeNapIncidentNotifications.delete(napNotificationKey);
    }

    // Zabbix must have reported a fresh event for every ONU and Smart OLT must
    // confirm both the total impact and its real cause. Electrical causes are
    // reclassified as Power Fail instead of being announced as NAP/LOS.
    const isTotalNapIncidentCandidate = eventStatus === 'PROBLEM' &&
      statusInfo.category === 'loss' &&
      updatedNap?.status === 'offline' &&
      updatedNap.totalClients >= getMinimumNapClients();
    if (isTotalNapIncidentCandidate) {
      if (!hasCompleteFreshNapLossEvidence(updatedNap)) {
        console.log(`[NAP Corroboration] ${updatedNap.name}: waiting for fresh Zabbix LOS evidence from every ONU.`);
        return;
      }

      const oltConfirmation = await corroborateTotalNapIncidentWithSmartOlt(updatedNap);
      if (!oltConfirmation.confirmed) {
        console.log(`[NAP Corroboration] ${updatedNap.name}: Smart OLT did not confirm the total incident and its cause (${oltConfirmation.reason}).`);
        return;
      }

      if (!activeNapIncidentNotifications.has(napNotificationKey)) {
        // Reserve the notification before awaiting Telegram so simultaneous
        // duplicate Zabbix events cannot produce duplicate NAP reports.
        activeNapIncidentNotifications.add(napNotificationKey);
        cancelPendingAlertsForNap(updatedNap);
        try {
          if (oltConfirmation.category === 'power_fail') {
            // All devices are offline, but the confirmed cause is electrical.
            // Report Power Fail in the normal alert group, never NAP/LOS.
            await sendCachedNapPowerFailAlert(payload, updatedNap, oltConfirmation, eventTime);
          } else {
            await sendCachedNapLossAlert(payload, updatedNap, eventTime);
          }
        } catch (error) {
          activeNapIncidentNotifications.delete(napNotificationKey);
          throw error;
        }
      }
      return;
    }
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
          freshOnu.status = liveStatus.onu_status || liveStatus.status_desc || (liveStatus.status === true ? 'online' : 'offline');

          const reason = (liveStatus.last_down_reason || liveStatus.offline_reason || '').toLowerCase();
          console.log(`[Settle] SN ${cleanSn}: Smart OLT live reason = "${reason}"`);

          if (reason.includes('dying') || reason.includes('power') || reason.includes('gasp')) {
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
      // ── LOS Validation: For a Loss of Signal alert, ALL ONUs on this NAP
      //    must be offline (100%) before we classify it as a full NAP outage.
      //    If some ONUs are still online, it's an individual ONU failure, not LOS.
      let losNapName = null;
      let losCachedNap = null;
      if (eventStatus !== 'OK') {
        // Determine NAP from freshOnu or cache fallback
        const resolvedNap = freshOnu?.odb_name || freshOnu?.odb || null;
        if (resolvedNap) {
          losCachedNap = getCachedNaps().find(n => n.name.toUpperCase() === resolvedNap.toUpperCase());
        } else if (!freshOnu) {
          // Try resolving from cache by SN
          for (const nap of getCachedNaps()) {
            if (nap.clients?.some(c => (c.sn || '').toUpperCase() === cleanSn)) {
              losCachedNap = nap;
              break;
            }
          }
        }

        if (losCachedNap && losCachedNap.clients && losCachedNap.clients.length > 0) {
          const totalClients = losCachedNap.clients.length;
          const offlineClients = losCachedNap.clients.filter(c => {
            const s = (c.status || '').toLowerCase();
            return s !== 'online' && s !== 'active';
          }).length;
          const allOffline = offlineClients === totalClients;
          console.log(`[LOS Validation] NAP "${losCachedNap.name}": ${offlineClients}/${totalClients} ONUs offline. All offline: ${allOffline}`);

          if (!allOffline && totalClients > 1) {
            // Not a full LOS — only some ONUs dropped. Send as individual alert without LOS classification.
            console.log(`[LOS Validation] Partial drop on NAP "${losCachedNap.name}" (${offlineClients}/${totalClients} offline). Not a full LOS. Sending as individual power-fail alert.`);
            // Override the reason so it doesn't get classified as LOS
            if (freshOltStatusReason && freshOltStatusReason.includes('Señal')) {
              freshOltStatusReason = 'Falla Individual (otras ONUs de la NAP operativas)';
            }
          } else if (allOffline) {
            losNapName = losCachedNap.name;
          }
        }
      }

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
        // Feed area outage buffer only when a full LOS on a named NAP is confirmed
        if (losNapName && losCachedNap && eventStatus !== 'OK') {
          feedNapOutageBuffer(losNapName, losCachedNap, payload);
          console.log(`[Area Outage] NAP "${losNapName}" added to area outage buffer.`);
        }
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
 * Auxiliary function to run live optical diagnostics for an ONU and send the result.
 */
export async function runLiveDiagnostics(chatId, messageId, snParam) {
  if (!snParam) {
    await replyToMessage(chatId, messageId, 'ℹ️ Por favor ingresa el número de serie de la ONU a diagnosticar.\nEjemplo: <code>/diagnostico FHTT8C3A91BF</code>');
    return;
  }
  
  const cleanSn = snParam.trim().toUpperCase();
  await replyToMessage(chatId, messageId, `⚡ Consultando potencia óptica en tiempo real para <code>${cleanSn}</code>...`);
  
  try {
    const onu = await findOnuBySn(cleanSn);
    if (!onu) {
      await replyToMessage(chatId, messageId, `❌ ONU con número de serie <code>${cleanSn}</code> no encontrada.`);
      return;
    }
    
    const liveStatus = await getOnuStatus(onu.external_id);
    if (!liveStatus) {
      await replyToMessage(chatId, messageId, `❌ No se pudo obtener la potencia óptica en vivo para <code>${onu.sn}</code>.`);
      return;
    }
    
    const rx = parseFloat(liveStatus.signal || liveStatus.rx_power);
    const tx = parseFloat(liveStatus.tx_power);
    const temp = liveStatus.temperature ? `${parseFloat(liveStatus.temperature).toFixed(1)} °C` : 'N/A';
    const bias = liveStatus.bias_current ? `${parseFloat(liveStatus.bias_current).toFixed(1)} mA` : 'N/A';
    const dist = liveStatus.distance ? `${liveStatus.distance} m` : 'N/A';
    
    // Save to DB in background
    dbSaveOpticalRecord(onu.sn, rx, tx, parseFloat(liveStatus.temperature), parseFloat(liveStatus.voltage), parseFloat(liveStatus.bias_current)).catch(() => {});
    
    const rxStr = isNaN(rx) || rx === 0 ? 'N/A' : `${rx.toFixed(2)} dBm`;
    const txStr = isNaN(tx) || tx === 0 ? 'N/A' : `${tx.toFixed(2)} dBm`;
    const statusDot = liveStatus.onu_status?.toLowerCase() === 'online' || liveStatus.status_desc?.toLowerCase() === 'online' || liveStatus.status_desc?.toLowerCase() === 'active' || liveStatus.onu_status?.toLowerCase() === 'active' ? '🟢' : '🔴';
    
    const reply = `⚡ <b>Diagnóstico en Vivo ONU: ${onu.name}</b>
\n🔢 <b>SN:</b> <code>${onu.sn}</code>
📊 <b>Estado OLT:</b> ${statusDot} <b>${(liveStatus.onu_status || liveStatus.status_desc || onu.status || 'Offline').toUpperCase()}</b>
📶 <b>Potencia Rx (Señal):</b> <b>${rxStr}</b>
📤 <b>Potencia Tx:</b> <code>${txStr}</code>
🌡️ <b>Temperatura:</b> <code>${temp}</code>
🔌 <b>Corriente Bias:</b> <code>${bias}</code>
📏 <b>Distancia OLT:</b> <code>${dist}</code>
📦 <b>Caja NAP:</b> <code>${onu.odb_name || onu.odb || 'N/A'}</code>`;
    
    const sendOptions = {};
    if (onu) {
      const inlineButtons = [];
      const firstRow = [];
      
      const publicUrl = PUBLIC_URL;
      const napBox = (onu.odb_name ? onu.odb_name.trim() : '') || (onu.odb ? onu.odb.trim() : '') || extractNapBox(onu.address) || extractNapBox(onu.description);
      if (publicUrl && napBox) {
        firstRow.push({
          text: '🗺️ Ver en Mapa',
          url: `${publicUrl}/?nap=${encodeURIComponent(napBox)}`
        });
      }
      
      const coordinates = (napBox ? getCoordinates(findCachedNap(napBox)) : null) || getCoordinates(onu);
      if (coordinates) {
        firstRow.push({
          text: '📍 Google Maps',
          url: `https://www.google.com/maps/dir/?api=1&destination=${coordinates.latitude},${coordinates.longitude}`
        });
      }
      
      if (firstRow.length > 0) {
        inlineButtons.push(firstRow);
      }
      
      if (inlineButtons.length > 0) {
        sendOptions.reply_markup = {
          inline_keyboard: inlineButtons
        };
      }
    }
    await replyToMessage(chatId, messageId, reply, sendOptions);
  } catch (err) {
    console.error('Error in runLiveDiagnostics:', err.message);
    await replyToMessage(chatId, messageId, `❌ Error de diagnóstico: ${err.message}`);
  }
}

function escapeTelegramHtml(value) {
  return String(value ?? '').replace(/[&<>]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;'
  })[character]);
}

async function sendPublicAlertHistory(chatId, messageId, requestedPage = 1, onlyPending = false) {
  const pageSize = 8;
  const history = getStatusHistory(5_000, onlyPending ? 'pending' : 'all');
  const totalPages = Math.max(1, Math.ceil(history.length / pageSize));
  const page = Math.min(Math.max(Number.parseInt(requestedPage, 10) || 1, 1), totalPages);
  const pageItems = history.slice((page - 1) * pageSize, page * pageSize);

  if (pageItems.length === 0) {
    const emptyLabel = onlyPending ? 'No hay fallas activas en este momento.' : 'Todavía no existen alertas registradas.';
    await replyToMessage(chatId, messageId, `✅ <b>${emptyLabel}</b>`);
    return;
  }

  const rows = pageItems.map((item, index) => {
    const position = (page - 1) * pageSize + index + 1;
    const state = item.resolved ? '✅ Solucionada' : '🔔 Activa';
    const icon = item.failureType === 'power_fail'
      ? '🔌'
      : item.failureType === 'loss'
        ? '🔴'
        : item.failureType === 'recovery'
          ? '🟢'
          : '⚠️';
    return `${position}. ${icon} <b>${escapeTelegramHtml(item.failureLabel || 'Alerta de red')}</b>\n` +
      `   📦 ${escapeTelegramHtml(item.napName || 'NAP desconocida')} | 👤 ${escapeTelegramHtml(item.onuName || 'Cliente')}\n` +
      `   🔢 <code>${escapeTelegramHtml(item.sn || 'N/A')}</code> | 🕒 ${escapeTelegramHtml(item.eventTime || item.formattedTime || item.timestamp)}\n` +
      `   ${state}`;
  });

  const title = onlyPending ? '⚠️ <b>FALLAS ACTIVAS DE LA RED</b>' : '📋 <b>HISTORIAL PÚBLICO DE ALERTAS</b>';
  const navigation = totalPages > 1
    ? `\n\n📄 Página <b>${page}/${totalPages}</b>. Usa <code>/${onlyPending ? 'fallas' : 'alertas'} ${page < totalPages ? page + 1 : 1}</code> para continuar.`
    : '';
  const mapLink = PUBLIC_URL ? `\n🌐 <a href="${PUBLIC_URL}">Abrir monitor público</a>` : '';

  await replyToMessage(
    chatId,
    messageId,
    `${title}\n\n${rows.join('\n\n')}${navigation}${mapLink}`
  );
}

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

  if (!TELEGRAM_BOT_PUBLIC && !isTrustedTelegramChat(chatId)) {
    await replyToMessage(chatId, messageId, '🔒 Este bot está configurado para uso privado.');
    return;
  }

  const upperText = text.toUpperCase();
  const command = upperText.trim().split(/\s+/)[0].split('@')[0];

  if (upperText.startsWith('/START')) {
    const parts = text.split(/\s+/);
    if (parts[1] && parts[1].toLowerCase().startsWith('diag_')) {
      const snParam = parts[1].substring(5).trim();
      await runLiveDiagnostics(chatId, messageId, snParam);
      return;
    }
  }

  if (upperText.startsWith('/START') || upperText.startsWith('/AYUDA') || upperText.startsWith('/HELP')) {
    try {
      const helpMsg = `🤖 <b>Asistente de Monitoreo Zabbix & Smart OLT</b>

Comandos disponibles:
• 🔍 <code>/buscar &lt;nombre / NAP / SN&gt;</code> - Busca clientes o cajas NAP por nombre o serie.
• 📦 <code>/nap &lt;nombre NAP&gt;</code> - Consulta estado detallado de una caja NAP (ej: <code>/nap SM-7030-1</code>).
• 📋 <code>/alertas [página]</code> - Muestra todas las alertas existentes.
• ⚠️ <code>/fallas [página]</code> - Muestra solamente las fallas activas.
• 🗺️ <code>/mapa</code> - Enlace directo al mapa de cajas NAP en tiempo real.
• 🆔 <code>/id</code> - Muestra el ID de este chat de Telegram.

<i>💡 El bot está disponible públicamente. Las operaciones administrativas permanecen protegidas.</i>`;
      await replyToMessage(chatId, messageId, helpMsg);
    } catch (err) {
      console.error('Error handling /ayuda command:', err.message);
    }
    return;
  }

  if (upperText.startsWith('/MAPA')) {
    try {
      const publicUrl = PUBLIC_URL;
      const mapMsg = publicUrl 
        ? `🗺️ <b>Monitor de Cajas NAP en Tiempo Real</b>\n\nAccede al mapa interactivo aquí:\n🔗 <a href="${publicUrl}">${publicUrl}</a>`
        : `🗺️ <b>Monitor de Cajas NAP:</b> <code>PUBLIC_URL</code> no configurado en el servidor.`;
      await replyToMessage(chatId, messageId, mapMsg);
    } catch (err) {
      console.error('Error handling /mapa command:', err.message);
    }
    return;
  }

  if (command === '/ALERTAS' || command === '/HISTORIAL') {
    const requestedPage = text.match(/\s+(\d+)/)?.[1] || 1;
    await sendPublicAlertHistory(chatId, messageId, requestedPage, false);
    return;
  }

  if (command === '/FALLAS' || command === '/STATUS_FALLAS') {
    const requestedPage = text.match(/\s+(\d+)/)?.[1] || 1;
    await sendPublicAlertHistory(chatId, messageId, requestedPage, true);
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

  if (upperText.startsWith('/OLT') || upperText.startsWith('/STATUS_OLT')) {
    try {
      const cachedNaps = getCachedNaps();
      let okCount = 0;
      let partialCount = 0;
      let downCount = 0;
      let totalClients = 0;
      let onlineClients = 0;
      let offlineClients = 0;
      
      cachedNaps.forEach(nap => {
        if (nap.status === 'online') okCount++;
        else if (nap.status === 'partial') partialCount++;
        else if (nap.status === 'offline') downCount++;
        
        totalClients += nap.totalClients || 0;
        onlineClients += nap.onlineClients || 0;
        offlineClients += nap.offlineClients || 0;
      });
      
      const report = `📊 <b>Resumen General de la Red FTTH</b>
\n📦 <b>Cajas NAP:</b>
• 🟢 Estables (Online): <b>${okCount}</b>
• ⚠️ Parciales (Partial): <b>${partialCount}</b>
• 🔴 Caídas (Offline): <b>${downCount}</b>
• Total NAPs: <b>${cachedNaps.length}</b>
\n👤 <b>Abonados/Clientes:</b>
• 🟢 Operativos (Online): <b>${onlineClients}</b>
• 🔴 Caídos (Offline): <b>${offlineClients}</b>
• Total Clientes: <b>${totalClients}</b>`;
      
      await replyToMessage(chatId, messageId, report);
    } catch (err) {
      console.error('Error handling /olt command:', err.message);
    }
    return;
  }

  if (upperText.startsWith('/DIAGNOSTICO') || upperText.startsWith('/DIAG')) {
    const parts = text.split(/\s+/);
    const snParam = parts[1] ? parts[1].trim() : null;
    await runLiveDiagnostics(chatId, messageId, snParam);
    return;
  }

  if (command === '/SYNC') {
    if (!isTrustedTelegramChat(chatId)) {
      await replyToMessage(chatId, messageId, '🔒 La sincronización con Zabbix y Smart OLT está reservada para el chat administrador.');
      return;
    }
    try {
      await replyToMessage(chatId, messageId, '🔄 Iniciando sincronización de fallas activas con Zabbix y Smart OLT. Por favor espere...');
      await syncActiveProblems(chatId);
    } catch (err) {
      console.error('Error handling sync bot command:', err.message);
    }
    return;
  }

  // Public users are read-only. This prevents a crafted plain-text message
  // from being interpreted as a real Zabbix incident and changing the cache.
  if (!isTrustedTelegramChat(chatId)) {
    await replyToMessage(chatId, messageId, 'ℹ️ Usa <code>/alertas</code>, <code>/fallas</code>, <code>/buscar</code> o <code>/ayuda</code>.');
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
            
            if (reason.includes('dying') || reason.includes('power') || reason.includes('gasp')) {
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

        const category = statusInfo.category;
        const oltReasonCategory = getFailureCategoryFromOltReason(oltStatusReason);

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
          if (oltReasonCategory !== 'unknown' && oltReasonCategory !== category) {
            console.log(`[Corroboration Blocked] Bot: cause mismatch (Zabbix ${category}, Smart OLT ${oltReasonCategory}) for SN "${sn}".`);
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

          const sendOptions = {};
          if (onu) {
            const inlineButtons = [];
            const firstRow = [];
            
            const publicUrl = PUBLIC_URL;
            const napBox = (onu.odb_name ? onu.odb_name.trim() : '') || (onu.odb ? onu.odb.trim() : '') || extractNapBox(onu.address) || extractNapBox(onu.description);
            if (publicUrl && napBox) {
              firstRow.push({
                text: '🗺️ Ver en Mapa',
                url: `${publicUrl}/?nap=${encodeURIComponent(napBox)}`
              });
            }
            
            const coordinates = (napBox ? getCoordinates(findCachedNap(napBox)) : null) || getCoordinates(onu);
            if (coordinates) {
              firstRow.push({
                text: '📍 Google Maps',
                url: `https://www.google.com/maps/dir/?api=1&destination=${coordinates.latitude},${coordinates.longitude}`
              });
            }
            
            if (firstRow.length > 0) {
              inlineButtons.push(firstRow);
            }
            
            const botUsername = (process.env.BOT_USERNAME || '').trim().replace(/^@/, '');
            if (sn && botUsername) {
              inlineButtons.push([
                {
                  text: '⚡ Diagnóstico Óptico en Vivo',
                  url: `https://t.me/${botUsername}?start=diag_${sn.toUpperCase()}`
                }
              ]);
            }
            
            if (inlineButtons.length > 0) {
              sendOptions.reply_markup = {
                inline_keyboard: inlineButtons
              };
            }
          }
          await replyToMessage(chatId, messageId, replyText.trim(), sendOptions);
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
    const publicUrl = PUBLIC_URL;
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

// GET /webhook/onu/sn/:sn/status - Fetch real-time ONU status/signal details
router.get('/onu/sn/:sn/status', async (req, res) => {
  const sn = (req.params.sn || '').trim().toUpperCase();
  if (!sn) {
    return res.status(400).json({ error: 'Missing serial number' });
  }

  try {
    const onu = await findOnuBySn(sn);
    if (!onu) {
      return res.status(404).json({ error: `ONU with serial number ${sn} not found in Smart OLT` });
    }

    if (!onu.external_id) {
      return res.status(400).json({ error: `ONU has no external ID registered in Smart OLT` });
    }

    const liveStatus = await getOnuStatus(onu.external_id);
    if (!liveStatus) {
      return res.status(500).json({ error: `Failed to fetch live status for ONU ${sn} (External ID: ${onu.external_id})` });
    }

    const rx = parseFloat(liveStatus.signal || liveStatus.rx_power);
    const tx = parseFloat(liveStatus.tx_power);
    const temp = parseFloat(liveStatus.temperature);
    const volt = parseFloat(liveStatus.voltage);
    const bias = parseFloat(liveStatus.bias_current);
    
    dbSaveOpticalRecord(sn, rx, tx, temp, volt, bias).catch(() => {});

    return res.json({
      status: 'success',
      sn,
      name: onu.name,
      address: onu.address,
      external_id: onu.external_id,
      olt_name: onu.olt_name,
      board: onu.board,
      port: onu.port,
      onu_id: onu.onu_id,
      live: {
        status: liveStatus.onu_status || liveStatus.status_desc || onu.status || 'Offline',
        rx_power: liveStatus.signal || liveStatus.rx_power || null,
        tx_power: liveStatus.tx_power || null,
        olt_rx_power: liveStatus.olt_rx_power || null,
        temperature: liveStatus.temperature || null,
        voltage: liveStatus.voltage || null,
        bias_current: liveStatus.bias_current || null,
        distance: liveStatus.distance || null,
        last_down_time: liveStatus.last_down_time || null,
        last_down_reason: liveStatus.last_down_reason || liveStatus.offline_reason || null,
        last_up_time: liveStatus.last_up_time || null
      }
    });
  } catch (err) {
    console.error(`Error in /onu/sn/${sn}/status:`, err.message);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// GET /webhook/onu/sn/:sn/optical-history - Fetch historical optical power levels
router.get('/onu/sn/:sn/optical-history', async (req, res) => {
  const sn = (req.params.sn || '').trim().toUpperCase();
  if (!sn) {
    return res.status(400).json({ error: 'Missing serial number' });
  }
  try {
    const history = await dbGetOpticalHistory(sn, 20);
    return res.json({
      status: 'success',
      sn,
      history
    });
  } catch (err) {
    console.error(`Error in /onu/sn/${sn}/optical-history:`, err.message);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

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
