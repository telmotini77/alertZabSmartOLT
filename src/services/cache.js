import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchAllOnus, fetchAllOnuStatuses, getSmartOltAccounts } from './smartOlt.js';
import { extractNapBox } from '../utils/parser.js';
import { broadcast } from './websocket.js';
import {
  initDb,
  dbGetAllNaps,
  dbSaveNap,
  dbGetStatusHistory,
  dbSaveHistoryItem,
  dbDeleteHistoryItem,
  dbClearHistory,
  dbResolveHistoryItem,
  dbSaveOpticalRecord
} from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Memory cache for fast reads
let cachedNaps = [];
let statusHistory = [];
const MAX_HISTORY_ITEMS = 5000;
const METADATA_SYNC_MINUTES = Math.max(
  Number.parseInt(process.env.SMARTOLT_METADATA_SYNC_MINUTES, 10) || 60,
  60
);

const isOnlineStatus = (status) => ['online', 'active'].includes(String(status || '').trim().toLowerCase());

const getNapStatusFromClients = (clients = []) => {
  const total = clients.length;
  const offline = clients.filter((client) => !isOnlineStatus(client.status)).length;
  if (total > 0 && offline === total) return 'offline';
  if (offline > 0) return 'partial';
  return 'online';
};

const formatNapStatus = (status) => ({
  online: 'NAP estable',
  partial: 'NAP parcial',
  offline: 'NAP caída total'
}[status] || 'NAP sin estado');

const getSmartOltAccountKey = (value = {}) => String(
  value?.smartolt_account_id || value?.smartOltAccountId || 'default'
).trim().toUpperCase() || 'DEFAULT';

const getNapHistoryKey = (nap) => {
  const account = getSmartOltAccountKey(nap);
  const olt = String(nap?.olt_id || nap?.olt_name || 'OLT').trim().toUpperCase();
  const name = String(nap?.name || 'NAP').trim().toUpperCase();
  return `NAP:${account}:${olt}:${name}`;
};

const getNapSourceKey = (value = {}, napName = '') => {
  const account = getSmartOltAccountKey(value);
  const olt = String(value?.olt_id || value?.oltId || value?.olt_name || value?.oltName || 'OLT')
    .trim()
    .toUpperCase();
  const name = String(napName || value?.name || '').trim().toUpperCase();
  return `${account}:${olt}:${name}`;
};

/**
 * SQLite used to contain manually entered and CSV-imported locations. Keep
 * its inventory only as a temporary metadata cache; a NAP position must be
 * obtained again from Smart OLT before it can be displayed or alerted.
 */
const withoutStoredCoordinates = (nap = {}) => ({
  ...nap,
  latitude: null,
  longitude: null,
  clients: (nap.clients || []).map((client) => ({
    ...client,
    latitude: null,
    longitude: null
  }))
});

function getSmartOltFailureDetails(changes = []) {
  const offlineChanges = changes.filter((change) => !isOnlineStatus(change.newStatus));
  const source = offlineChanges.length > 0 ? offlineChanges : changes;
  const text = source.map((change) => `${change.reason || ''} ${change.newStatus || ''}`)
    .join(' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (/(dying|gasp|power|energia|electric|pwrfail)/.test(text)) {
    return {
      category: 'power_fail',
      reason: 'Corte de energía confirmado por Smart OLT (Power Fail).'
    };
  }
  if (/(\blos\b|loss of signal|signal|senal|fibra|fiber|optic)/.test(text)) {
    return {
      category: 'loss',
      reason: 'Pérdida de señal confirmada por Smart OLT (LOS).'
    };
  }
  if (offlineChanges.length > 0) {
    return {
      category: 'unknown',
      reason: 'Smart OLT reportó una ONU Offline sin causa específica; se registra solo en el historial, no se envía a Telegram.'
    };
  }
  return {
    category: 'recovery',
    reason: 'Servicio restablecido y confirmado por Smart OLT.'
  };
}

function recordNapSnapshotTransition(nap, previousNapStatus, changes = []) {
  if (previousNapStatus === nap.status || changes.length === 0) return;

  // The map history documents status changes even when they are intentionally
  // silent in Telegram.  This makes partial drops traceable without creating
  // a Telegram notification per router.
  const deteriorated = previousNapStatus === 'online' || nap.status === 'offline';
  const fullyRecovered = nap.status === 'online';
  if (!deteriorated && !fullyRecovered) return;

  const details = getSmartOltFailureDetails(changes);
  const affectedNames = [...new Set(changes.map((change) => change.name).filter(Boolean))];
  const eventTime = changes.map((change) => change.eventTime).find(Boolean) || null;

  recordStatusChangeEvent({
    sn: getNapHistoryKey(nap),
    onuName: affectedNames.length > 0
      ? `Clientes afectados: ${affectedNames.join(', ')}`
      : 'Cambio de estado de la caja NAP',
    napName: nap.name,
    previousStatus: formatNapStatus(previousNapStatus),
    newStatus: formatNapStatus(nap.status),
    napStatus: nap.status,
    reason: details.reason,
    category: details.category,
    oltName: nap.olt_name,
    board: nap.board,
    port: nap.port,
    latitude: nap.latitude,
    longitude: nap.longitude,
    eventTime
  });
}

/**
 * Merge the compact Smart OLT monitoring feed with locally persisted NAP,
 * customer and GPS metadata. This prevents alert processing from repeatedly
 * exporting the complete Smart OLT ONU database just to identify a client.
 */
export function mergeStatusSnapshotWithCache(statusOnus = []) {
  const cachedBySn = new Map();
  const cachedByUnscopedSn = new Map();
  cachedNaps.forEach((nap) => {
    (nap.clients || []).forEach((client) => {
      const sn = String(client?.sn || '').trim().toUpperCase();
      if (!sn) return;
      const cached = {
        ...client,
        sn,
        odb_name: nap.name,
        smartolt_account_id: client.smartolt_account_id || nap.smartolt_account_id || '',
        olt_id: nap.olt_id,
        olt_name: nap.olt_name,
        board: nap.board,
        port: nap.port,
        latitude: client.latitude ?? nap.latitude,
        longitude: client.longitude ?? nap.longitude
      };
      const accountKey = getSmartOltAccountKey(cached);
      cachedBySn.set(`${accountKey}:${sn}`, cached);
      // Compatibility for old rows created before account metadata existed.
      if (!cachedByUnscopedSn.has(sn)) cachedByUnscopedSn.set(sn, cached);
    });
  });

  return statusOnus.map((statusOnu) => {
    const sn = String(statusOnu?.sn || '').trim().toUpperCase();
    const accountKey = getSmartOltAccountKey(statusOnu);
    const cached = cachedBySn.get(`${accountKey}:${sn}`) || cachedByUnscopedSn.get(sn) || {};
    return {
      ...cached,
      ...statusOnu,
      sn: sn || cached.sn || '',
      external_id: statusOnu?.external_id || statusOnu?.unique_external_id || cached.external_id || '',
      name: statusOnu?.name || cached.name || '',
      status: statusOnu?.status || cached.status || 'Offline',
      odb_name: statusOnu?.odb_name || statusOnu?.odb || cached.odb_name || '',
      smartolt_account_id: statusOnu?.smartolt_account_id || cached.smartolt_account_id || '',
      smartolt_subdomain: statusOnu?.smartolt_subdomain || cached.smartolt_subdomain || '',
      olt_id: statusOnu?.olt_id ?? statusOnu?.oltId ?? cached.olt_id ?? '',
      olt_name: statusOnu?.olt_name || cached.olt_name || '',
      board: statusOnu?.board ?? cached.board,
      port: statusOnu?.port ?? cached.port,
      latitude: statusOnu?.latitude ?? statusOnu?.gps_lat ?? cached.latitude ?? null,
      longitude: statusOnu?.longitude ?? statusOnu?.gps_lng ?? cached.longitude ?? null
    };
  });
}

export async function fetchMonitoringOnus(options = {}) {
  const statuses = await fetchAllOnuStatuses(options);
  return mergeStatusSnapshotWithCache(statuses);
}

export function findCachedOnuBySn(sn) {
  const normalizedSn = String(sn || '').trim().toUpperCase();
  if (!normalizedSn) return null;

  for (const nap of cachedNaps) {
    const client = (nap.clients || []).find((candidate) =>
      String(candidate?.sn || '').trim().toUpperCase() === normalizedSn
    );
    if (!client) continue;
    return {
      ...client,
      sn: normalizedSn,
      odb_name: nap.name,
      smartolt_account_id: client.smartolt_account_id || nap.smartolt_account_id || '',
      smartolt_subdomain: client.smartolt_subdomain || nap.smartolt_subdomain || '',
      olt_id: nap.olt_id,
      olt_name: nap.olt_name,
      board: nap.board,
      port: nap.port,
      latitude: client.latitude ?? nap.latitude,
      longitude: client.longitude ?? nap.longitude
    };
  }

  return null;
}

/**
 * Initialize cache by loading from SQLite database.
 */
export async function initCache() {
  try {
    // 1. Initialize SQLite Database
    await initDb();

    // 2. Load NAPs from database
    const storedNaps = await dbGetAllNaps();
    cachedNaps = storedNaps.map(withoutStoredCoordinates);
    console.log(`📦 Loaded ${cachedNaps.length} NAPs from SQLite database (stored GPS ignored; source: Smart OLT).`);

    const configuredAccountIds = getSmartOltAccounts().map((account) => account.id);
    const cachedAccountIds = new Set(cachedNaps.map((nap) => String(nap.smartolt_account_id || '').trim()));
    const needsAccountMetadata = configuredAccountIds.some((id) => !cachedAccountIds.has(id));
    console.log(cachedNaps.length === 0
      ? '📦 No NAPs found in SQLite. Loading NAP metadata and GPS from Smart OLT...'
      : needsAccountMetadata
        ? '📦 New Smart OLT domain detected. Refreshing NAP metadata and GPS from Smart OLT...'
        : '📍 Refreshing NAP GPS exclusively from Smart OLT...');
    try {
      // This is intentionally done at every process start. Persisted GPS
      // values therefore never appear after a restart, even momentarily.
      await syncCacheWithSmartOlt();
    } catch (syncErr) {
      console.error('❌ Initial Smart OLT metadata/GPS sync failed:', syncErr.message);
    }

    // 3. Load Status History from database
    statusHistory = await dbGetStatusHistory(MAX_HISTORY_ITEMS);
    console.log(`📋 Loaded ${statusHistory.length} status history events from SQLite database.`);

    // Full ONU details are static metadata and Smart OLT restricts this
    // endpoint. Keep this slow; operational status is refreshed separately by
    // the compact monitoring feed used by the radar.
    setInterval(async () => {
      try {
        console.log('🔄 Running slow Smart OLT metadata sync...');
        await syncCacheWithSmartOlt();
      } catch (err) {
        console.error('❌ Failed periodic sync:', err.message);
      }
    }, METADATA_SYNC_MINUTES * 60 * 1000);

  } catch (err) {
    console.error('❌ Error initializing cache:', err.message);
    cachedNaps = [];
  }
}

/**
 * Run a full sync of all ONUs from Smart OLT and rebuild the NAP cache.
 */
export async function syncCacheWithSmartOlt({ forceRefresh = false } = {}) {
  try {
    const onus = await fetchAllOnus({ forceRefresh });
    console.log(`Smart OLT returned ${onus.length} ONUs. Processing NAPs...`);

    const napMap = {};

    onus.forEach((onu) => {
      // Prioritize the direct ODB name field from Smart OLT, fallback to extracting from address/description
      const napName = (onu.odb_name ? onu.odb_name.trim() : '') || (onu.odb ? onu.odb.trim() : '') || extractNapBox(onu.address) || extractNapBox(onu.description);
      if (!napName) return;

      // OLT ids may be reused by different Smart OLT domains. Keep both the
      // account and the OLT in the cache key so their boxes/clients never
      // merge into the same NAP incident.
      const napSourceKey = getNapSourceKey(onu, napName);
      if (!napMap[napSourceKey]) {
        napMap[napSourceKey] = {
          name: napName,
          smartolt_account_id: onu.smartolt_account_id || '',
          smartolt_subdomain: onu.smartolt_subdomain || '',
          olt_id: onu.olt_id || onu.oltId || '',
          olt_name: onu.olt_name || 'OLT Desconocida',
          board: onu.board || '0',
          port: onu.port || '0',
          lats: [],
          lngs: [],
          clients: []
        };
      }

      // Collect client info
      const isOnline = (onu.status || '').toLowerCase() === 'online' || (onu.status || '').toLowerCase() === 'active';
      
      const client = {
        name: onu.name,
        sn: onu.sn.toUpperCase(),
        external_id: onu.external_id || onu.unique_external_id || '',
        smartolt_account_id: onu.smartolt_account_id || '',
        smartolt_subdomain: onu.smartolt_subdomain || '',
        olt_id: onu.olt_id || onu.oltId || '',
        status: onu.status || 'Offline',
        onu_id: onu.onu_id || 'N/A'
      };

      // Handle GPS coordinates
      const lat = parseFloat(onu.gps_lat || onu.latitude);
      const lng = parseFloat(onu.gps_lng || onu.longitude);
      
      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        client.latitude = lat;
        client.longitude = lng;
        napMap[napSourceKey].lats.push(lat);
        napMap[napSourceKey].lngs.push(lng);
      }

      // Automatically save optical power history record in background for online ONUs
      if (isOnline && onu.sn) {
        const rx = parseFloat(onu.rx_power);
        const tx = parseFloat(onu.tx_power);
        const temp = parseFloat(onu.temperature);
        const volt = parseFloat(onu.voltage);
        const bias = parseFloat(onu.bias_current);
        dbSaveOpticalRecord(onu.sn, rx, tx, temp, volt, bias).catch(() => {});
      }

      napMap[napSourceKey].clients.push(client);
    });

    // Build the final NAPs list
    const naps = Object.keys(napMap).map((sourceKey) => {
      const group = napMap[sourceKey];
      const name = group.name;
      
      // Calculate average coordinates
      let latitude = null;
      let longitude = null;
      if (group.lats.length > 0 && group.lngs.length > 0) {
        latitude = group.lats.reduce((sum, val) => sum + val, 0) / group.lats.length;
        longitude = group.lngs.reduce((sum, val) => sum + val, 0) / group.lngs.length;
      }

      // Never fall back to SQLite, CSV, or manually placed GPS. A NAP with no
      // valid Smart OLT coordinates remains unlocated until Smart OLT reports
      // its position.
      const finalLat = latitude;
      const finalLng = longitude;

      const totalClients = group.clients.length;
      const offlineClients = group.clients.filter(c => {
        const s = c.status.toLowerCase();
        return s !== 'online' && s !== 'active';
      }).length;
      const onlineClients = totalClients - offlineClients;

      let status = 'online';
      if (offlineClients === totalClients) {
        status = 'offline';
      } else if (offlineClients > 0) {
        status = 'partial';
      }

      return {
        name,
        smartolt_account_id: group.smartolt_account_id,
        smartolt_subdomain: group.smartolt_subdomain,
        olt_id: group.olt_id,
        olt_name: group.olt_name,
        board: group.board,
        port: group.port,
        latitude: finalLat,
        longitude: finalLng,
        totalClients,
        onlineClients,
        offlineClients,
        status,
        clients: group.clients
      };
    });

    cachedNaps = naps;
    
    // Save NAPs to SQLite in background
    await Promise.all(naps.map(nap => dbSaveNap(nap)));
    console.log(`✅ Synced and saved ${cachedNaps.length} NAPs successfully to SQLite database.`);
  } catch (err) {
    console.error('❌ Error during syncCacheWithSmartOlt:', err.message);
    throw err;
  }
}

/**
 * Update the status of a specific ONU inside the cache.
 * Useful to reflect Zabbix events instantly without doing a full fetch.
 * @param {string} sn - ONU Serial Number
 * @param {string} newStatus - New status ('Online', 'Offline', etc.)
 * @param {Object} [eventMetadata] - Additional metadata (reason, category, eventTime, etc.)
 */
export function updateOnuStatusInCache(sn, newStatus, eventMetadata = {}) {
  if (!sn) return null;
  const cleanSn = sn.toUpperCase();
  const accountId = String(eventMetadata.smartolt_account_id || eventMetadata.smartOltAccountId || '').trim();
  let affectedNap = null;
  let clientFound = null;
  let previousStatus = 'Online';

  cachedNaps.forEach((nap) => {
    const client = nap.clients.find((candidate) =>
      String(candidate.sn || '').toUpperCase() === cleanSn &&
      (!accountId || String(candidate.smartolt_account_id || nap.smartolt_account_id || '').trim() === accountId)
    );
    if (client) {
      previousStatus = client.status || 'Online';
      client.status = newStatus;
      clientFound = client;
      affectedNap = nap;
    }
  });

  if (affectedNap) {
    // Recompute NAP status
    const totalClients = affectedNap.clients.length;
    const offlineClients = affectedNap.clients.filter(c => {
      const s = (c.status || '').toLowerCase();
      return s !== 'online' && s !== 'active';
    }).length;
    affectedNap.totalClients = totalClients;
    affectedNap.offlineClients = offlineClients;
    affectedNap.onlineClients = totalClients - offlineClients;

    if (offlineClients === totalClients) {
      affectedNap.status = 'offline';
    } else if (offlineClients > 0) {
      affectedNap.status = 'partial';
    } else {
      affectedNap.status = 'online';
    }

    dbSaveNap(affectedNap).catch(() => {});
    console.log(`💾 SQLite updated for ONU ${cleanSn} inside ${affectedNap.name}. Status: ${newStatus}`);

    // Record history event if status changed or forced
    const isNewStatusOnline = (newStatus || '').toLowerCase() === 'online' || (newStatus || '').toLowerCase() === 'active';
    const isPrevStatusOnline = (previousStatus || '').toLowerCase() === 'online' || (previousStatus || '').toLowerCase() === 'active';

    if (isNewStatusOnline !== isPrevStatusOnline || eventMetadata.forceRecord) {
      recordStatusChangeEvent({
        sn: cleanSn,
        onuName: clientFound?.name || eventMetadata.onuName || cleanSn,
        napName: affectedNap.name,
        previousStatus: isPrevStatusOnline ? 'Online' : 'Offline',
        newStatus: isNewStatusOnline ? 'Online' : 'Offline',
        napStatus: affectedNap.status,
        reason: eventMetadata.reason || (isNewStatusOnline ? 'Restablecido' : 'Falla detectada'),
        category: eventMetadata.category || (isNewStatusOnline ? 'recovery' : 'unknown'),
        oltName: affectedNap.olt_name,
        board: affectedNap.board,
        port: affectedNap.port,
        latitude: affectedNap.latitude,
        longitude: affectedNap.longitude,
        eventTime: eventMetadata.eventTime || null
      });
    }
  }

  return affectedNap;
}

/**
 * Apply the status returned by a complete Smart OLT scan to the existing NAP
 * cache. Unlike updateOnuStatusInCache(), this writes at most one aggregate
 * history event per affected NAP, so partial changes remain explainable on
 * the map without creating one alert card per ONU.
 *
 * @param {Array<Object>} onus - ONUs returned by Smart OLT.
 * @returns {Array<Object>} NAPs whose calculated status changed.
 */
export function applyOnuStatusSnapshot(onus) {
  if (!Array.isArray(onus) || onus.length === 0 || cachedNaps.length === 0) {
    return [];
  }

  const snapshotBySn = new Map();
  onus.forEach((onu) => {
    const sn = String(onu?.sn || '').trim().toUpperCase();
    if (sn && onu?.status !== undefined && onu?.status !== null) {
      const latitude = Number(onu.gps_lat ?? onu.latitude);
      const longitude = Number(onu.gps_lng ?? onu.longitude);
      snapshotBySn.set(`${getSmartOltAccountKey(onu)}:${sn}`, {
        status: String(onu.status),
        smartolt_account_id: onu.smartolt_account_id || '',
        olt_id: String(onu.olt_id ?? onu.oltId ?? '').trim(),
        reason: String(onu.offline_reason || onu.last_down_reason || onu.status_reason || onu.reason || onu.status || '').trim(),
        eventTime: onu.last_status_change || onu.last_down_time || onu.status_changed_at || null,
        latitude: Number.isFinite(latitude) && latitude !== 0 ? latitude : null,
        longitude: Number.isFinite(longitude) && longitude !== 0 ? longitude : null
      });
    }
  });

  if (snapshotBySn.size === 0) return [];

  const changedNaps = [];
  cachedNaps.forEach((nap) => {
    let changed = false;
    const previousNapStatus = getNapStatusFromClients(nap.clients);
    const statusChanges = [];

    nap.clients.forEach((client) => {
      const clientSn = String(client.sn || '').toUpperCase();
      const snapshot = snapshotBySn.get(`${getSmartOltAccountKey(client.smartolt_account_id ? client : nap)}:${clientSn}`);
      if (snapshot?.status && String(client.status || '') !== snapshot.status) {
        statusChanges.push({
          name: client.name || '',
          previousStatus: String(client.status || ''),
          newStatus: snapshot.status,
          reason: snapshot.reason,
          eventTime: snapshot.eventTime
        });
        client.status = snapshot.status;
        changed = true;
      }
      if (snapshot?.olt_id && String(client.olt_id || '') !== snapshot.olt_id) {
        client.olt_id = snapshot.olt_id;
        changed = true;
      }
      if (snapshot?.smartolt_account_id && client.smartolt_account_id !== snapshot.smartolt_account_id) {
        client.smartolt_account_id = snapshot.smartolt_account_id;
        changed = true;
      }
      if (snapshot && snapshot.latitude !== null && snapshot.longitude !== null) {
        client.latitude = snapshot.latitude;
        client.longitude = snapshot.longitude;
      }
    });

    const firstOltId = nap.clients.map((client) => String(client.olt_id || '').trim()).find(Boolean);
    if (firstOltId && String(nap.olt_id || '') !== firstOltId) {
      nap.olt_id = firstOltId;
      changed = true;
    }

    const coordinates = nap.clients
      .filter((client) => Number.isFinite(client.latitude) && Number.isFinite(client.longitude))
      .map((client) => ({ latitude: client.latitude, longitude: client.longitude }));
    if (coordinates.length > 0) {
      const latitude = coordinates.reduce((sum, coordinate) => sum + coordinate.latitude, 0) / coordinates.length;
      const longitude = coordinates.reduce((sum, coordinate) => sum + coordinate.longitude, 0) / coordinates.length;
      if (nap.latitude !== latitude || nap.longitude !== longitude) {
        nap.latitude = latitude;
        nap.longitude = longitude;
        changed = true;
      }
    }

    if (!changed) return;

    const totalClients = nap.clients.length;
    const offlineClients = nap.clients.filter((client) => !isOnlineStatus(client.status)).length;

    nap.totalClients = totalClients;
    nap.offlineClients = offlineClients;
    nap.onlineClients = totalClients - offlineClients;
    nap.status = getNapStatusFromClients(nap.clients);
    changedNaps.push(nap);
    recordNapSnapshotTransition(nap, previousNapStatus, statusChanges);
  });

  if (changedNaps.length > 0) {
    // Save to SQLite
    Promise.all(changedNaps.map(nap => dbSaveNap(nap))).catch(() => {});
    console.log(`Applied Smart OLT status snapshot to ${changedNaps.length} NAP(s) in SQLite.`);
  }

  return changedNaps;
}

/**
 * Record a state change event into memory, write to database, and broadcast via WebSockets.
 */
export function recordStatusChangeEvent(data) {
  const now = new Date();
  
  // Determine normalized failure type
  let failureType = 'unknown';
  let failureLabel = 'Alerta de Red';
  const reasonText = (data.reason || '').toLowerCase();
  const catText = (data.category || '').toLowerCase();

  const isNapHistoryEvent = String(data.sn || '').startsWith('NAP:');
  const isOnline = isNapHistoryEvent
    ? String(data.napStatus || '').toLowerCase() === 'online'
    : isOnlineStatus(data.newStatus);

  if (isOnline) {
    failureType = 'recovery';
    failureLabel = 'Servicio Restablecido (OK)';
  } else if (catText === 'power_fail' || reasonText.includes('power') || reasonText.includes('dying') || reasonText.includes('gasp') || reasonText.includes('luz') || reasonText.includes('energia')) {
    failureType = 'power_fail';
    failureLabel = 'Corte de Energía (Dying Gasp)';
  } else if (catText === 'loss' || reasonText.includes('los') || reasonText.includes('signal') || reasonText.includes('fibra') || reasonText.includes('cable')) {
    failureType = 'loss';
    failureLabel = 'Pérdida de Señal (LOS)';
  } else {
    failureType = 'unknown';
    failureLabel = 'Corte / Falla General';
  }

  // Format date and time
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const formattedTime = `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;

  const resolved = isOnline;
  const resolvedAt = isOnline ? now.toISOString() : null;

  // If this is a recovery, auto-resolve previous active problem incidents for this SN
  if (isOnline && data.sn) {
    const targetSn = data.sn.toUpperCase();
    statusHistory.forEach(item => {
      if (item.sn && item.sn.toUpperCase() === targetSn && !item.resolved) {
        item.resolved = true;
        item.resolvedAt = now.toISOString();
        dbResolveHistoryItem(item.id, now.toISOString()).catch(() => {});
      }
    });
  }

  const eventRecord = {
    id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    timestamp: now.toISOString(),
    formattedTime,
    eventTime: data.eventTime || formattedTime,
    sn: data.sn ? data.sn.toUpperCase() : 'N/A',
    onuName: data.onuName || data.sn || 'Cliente',
    napName: data.napName || 'NAP Desconocida',
    previousStatus: data.previousStatus || 'Online',
    newStatus: data.newStatus || 'Offline',
    napStatus: data.napStatus || 'partial',
    failureType,
    failureLabel,
    reason: data.reason || failureLabel,
    resolved,
    resolvedAt,
    oltName: data.oltName || 'OLT',
    board: data.board || '0',
    port: data.port || '0',
    latitude: data.latitude !== undefined ? data.latitude : null,
    longitude: data.longitude !== undefined ? data.longitude : null
  };

  // Prepend to history array
  statusHistory.unshift(eventRecord);

  // Keep array within bounds
  if (statusHistory.length > MAX_HISTORY_ITEMS) {
    statusHistory = statusHistory.slice(0, MAX_HISTORY_ITEMS);
  }

  // Save to SQLite in background
  dbSaveHistoryItem(eventRecord).catch(() => {});

  // Broadcast to all connected map clients
  try {
    broadcast('status_history_event', eventRecord);
  } catch (err) {
    console.error('Error broadcasting status history event:', err.message);
  }

  console.log(`📋 [History] Recorded: ${failureLabel} | NAP: ${eventRecord.napName} | Client: ${eventRecord.onuName} (${eventRecord.sn}) | Resolved: ${resolved}`);
  return eventRecord;
}

/**
 * Get the state change history list.
 */
export function getStatusHistory(limit = 100, filter = 'all') {
  let list = statusHistory;
  if (filter === 'pending') {
    list = list.filter(item => !item.resolved);
  } else if (filter === 'resolved') {
    list = list.filter(item => item.resolved);
  }
  return list.slice(0, limit);
}

/**
 * Delete a specific history item by ID.
 */
export function deleteHistoryItem(id) {
  const index = statusHistory.findIndex(item => item.id === id);
  if (index !== -1) {
    const deleted = statusHistory.splice(index, 1)[0];
    dbDeleteHistoryItem(id).catch(() => {});
    try {
      broadcast('status_history_deleted', { id });
    } catch (err) {
      console.error('Error broadcasting history deletion:', err.message);
    }
    return deleted;
  }
  return null;
}

/**
 * Clear history items (all, or only resolved).
 */
export function clearHistory(mode = 'all') {
  if (mode === 'resolved') {
    statusHistory = statusHistory.filter(item => !item.resolved);
  } else {
    statusHistory = [];
  }
  dbClearHistory(mode).catch(() => {});
  try {
    broadcast('status_history_cleared', { mode });
  } catch (err) {
    console.error('Error broadcasting history clear:', err.message);
  }
  return statusHistory;
}

/**
 * Manually mark a specific history item as resolved.
 */
export function resolveHistoryItem(id) {
  const item = statusHistory.find(i => i.id === id);
  if (item) {
    item.resolved = true;
    item.resolvedAt = new Date().toISOString();
    dbResolveHistoryItem(id, item.resolvedAt).catch(() => {});
    try {
      broadcast('status_history_updated', item);
    } catch (err) {
      console.error('Error broadcasting history update:', err.message);
    }
    return item;
  }
  return null;
}

/**
 * Get all cached NAPs.
 */
export function getCachedNaps() {
  return cachedNaps;
}

/**
 * Manual map placement is deliberately disabled. Smart OLT owns NAP GPS.
 * Retained as a no-op for compatibility with older local integrations.
 */
export function updateNapCoordinates(napName, latitude, longitude) {
  console.warn(`📍 Ignored manual GPS update for NAP ${napName || '(unknown)'}; source is Smart OLT.`);
  return null;
}

/**
 * CSV/KML coordinate imports are deliberately disabled. Smart OLT owns NAP
 * GPS. Retained as a no-op for older local integrations.
 */
export function updateNapCoordinatesBulk(updates) {
  console.warn(`📍 Ignored ${Array.isArray(updates) ? updates.length : 0} imported GPS update(s); source is Smart OLT.`);
  return [];
}

// Custom parser to split CSV lines respecting double quotes
function parseCsvLine(line) {
  const cols = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cols.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cols.push(current.trim());
  return cols;
}

/**
 * Reads coordinates from coordinates_mymaps.csv and seeds the cache NAPs that don't have coordinates.
 */
export function applyCsvCoordinatesToCache() {
  console.warn('📍 Ignored local coordenadas_mymaps.csv; source is Smart OLT.');
  return 0;

  /* Legacy parser retained below solely for backward source compatibility.
     The early return above ensures CSV coordinates can never enter the cache. */
  const csvPath = path.resolve(__dirname, '../public/coordenadas_mymaps.csv');
  if (!fs.existsSync(csvPath)) {
    console.log('⚠️ coordenadas_mymaps.csv not found, skipping coordinates auto-seed.');
    return;
  }

  try {
    const text = fs.readFileSync(csvPath, 'utf8');
    const lines = text.split(/\r?\n/);
    const coordsMap = {};

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = parseCsvLine(line);
      if (cols.length < 4) continue;
      const name = cols[1].trim().toUpperCase();
      const lat = parseFloat(cols[2]);
      const lng = parseFloat(cols[3]);
      if (name && !isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        coordsMap[name] = { latitude: lat, longitude: lng };
      }
    }

    let updatedCount = 0;
    cachedNaps.forEach((nap) => {
      if (nap.latitude === null || nap.longitude === null) {
         const match = coordsMap[nap.name.trim().toUpperCase()];
         if (match) {
           nap.latitude = match.latitude;
           nap.longitude = match.longitude;
           dbSaveNap(nap).catch(() => {});
           updatedCount++;
         }
      }
    });

    if (updatedCount > 0) {
      console.log(`📍 Auto-seeded ${updatedCount} NAPs coordinates to SQLite from coordenadas_mymaps.csv`);
    } else {
      console.log('ℹ️ All NAPs already have coordinates or no matching NAP names were found in CSV.');
    }
  } catch (err) {
    console.error('❌ Error applying CSV coordinates to cache:', err.message);
  }
}

/**
 * Dynamically update details of an unresolved status history event for an SN.
 */
export function updateHistoryEventDetails(sn, newCategory, newReason) {
  if (!sn) return null;
  const cleanSn = sn.toUpperCase();
  const item = statusHistory.find(i => i.sn === cleanSn && !i.resolved);
  if (item) {
    let failureType = 'unknown';
    let failureLabel = 'Alerta de Red';
    
    if (newCategory === 'power_fail') {
      failureType = 'power_fail';
      failureLabel = 'Corte de Energía (Dying Gasp)';
    } else if (newCategory === 'loss') {
      failureType = 'loss';
      failureLabel = 'Pérdida de Señal (LOS)';
    }
    
    item.failureType = failureType;
    item.failureLabel = failureLabel;
    item.reason = newReason || failureLabel;
    
    dbSaveHistoryItem(item).catch(() => {});
    try {
      broadcast('status_history_updated', item);
    } catch (err) {
      console.error('Error broadcasting history update:', err.message);
    }
    return item;
  }
  return null;
}
