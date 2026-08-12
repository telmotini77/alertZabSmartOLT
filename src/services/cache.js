import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchAllOnus } from './smartOlt.js';
import { extractNapBox } from '../utils/parser.js';
import { broadcast } from './websocket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Debounced async disk write ───────────────────────────────────────────────
let _saveTimer = null;
let _saveHistoryTimer = null;
const SAVE_DEBOUNCE_MS = 2_000; // batch rapid updates into a single disk write

const defaultCacheFile = path.resolve(__dirname, '../../data/nap_cache.json');
const defaultHistoryFile = path.resolve(__dirname, '../../data/status_history.json');

// Tests and maintenance jobs can use an isolated cache without touching the
// production map data.
const cacheFile = process.env.NAP_CACHE_FILE
  ? path.resolve(process.env.NAP_CACHE_FILE)
  : defaultCacheFile;
const historyFile = process.env.STATUS_HISTORY_FILE
  ? path.resolve(process.env.STATUS_HISTORY_FILE)
  : defaultHistoryFile;

const cacheDir = path.dirname(cacheFile);

// Memory cache
let cachedNaps = [];
let statusHistory = [];
const MAX_HISTORY_ITEMS = 5000;

/**
 * Initialize cache by loading from file or running a full sync.
 */
export async function initCache() {
  try {
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    if (fs.existsSync(cacheFile)) {
      const data = fs.readFileSync(cacheFile, 'utf8');
      cachedNaps = JSON.parse(data);
      console.log(`📦 Loaded ${cachedNaps.length} NAPs from disk cache.`);
    } else {
      console.log('📦 No disk cache found. Running initial sync with Smart OLT...');
      try {
        await syncCacheWithSmartOlt();
      } catch (syncErr) {
        console.error('❌ Initial sync with Smart OLT failed:', syncErr.message);
      }
    }

    // Load status change history from disk if exists
    if (fs.existsSync(historyFile)) {
      try {
        const histData = fs.readFileSync(historyFile, 'utf8');
        statusHistory = JSON.parse(histData);
        console.log(`📋 Loaded ${statusHistory.length} status history events from disk.`);
      } catch (hErr) {
        console.error('Error reading history file:', hErr.message);
        statusHistory = [];
      }
    }

    // Auto-seed coordinates from local CSV file
    applyCsvCoordinatesToCache();

    // Auto-sync every 15 minutes in the background
    setInterval(async () => {
      try {
        console.log('🔄 Running background periodic sync with Smart OLT...');
        await syncCacheWithSmartOlt();
      } catch (err) {
        console.error('❌ Failed periodic sync:', err.message);
      }
    }, 15 * 60 * 1000);

  } catch (err) {
    console.error('❌ Error initializing cache:', err.message);
    cachedNaps = [];
  }
}

/**
 * Run a full sync of all ONUs from Smart OLT and rebuild the NAP cache.
 */
export async function syncCacheWithSmartOlt() {
  try {
    const onus = await fetchAllOnus();
    console.log(`Smart OLT returned ${onus.length} ONUs. Processing NAPs...`);

    const napMap = {};

    onus.forEach((onu) => {
      // Prioritize the direct ODB name field from Smart OLT, fallback to extracting from address/description
      const napName = (onu.odb_name ? onu.odb_name.trim() : '') || (onu.odb ? onu.odb.trim() : '') || extractNapBox(onu.address) || extractNapBox(onu.description);
      if (!napName) return;

      if (!napMap[napName]) {
        napMap[napName] = {
          name: napName,
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
        status: onu.status || 'Offline',
        onu_id: onu.onu_id || 'N/A'
      };

      // Handle GPS coordinates
      const lat = parseFloat(onu.gps_lat || onu.latitude);
      const lng = parseFloat(onu.gps_lng || onu.longitude);
      
      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        client.latitude = lat;
        client.longitude = lng;
        napMap[napName].lats.push(lat);
        napMap[napName].lngs.push(lng);
      }

      napMap[napName].clients.push(client);
    });

    // Build the final NAPs list
    const naps = Object.keys(napMap).map((name) => {
      const group = napMap[name];
      
      // Calculate average coordinates
      let latitude = null;
      let longitude = null;
      if (group.lats.length > 0 && group.lngs.length > 0) {
        latitude = group.lats.reduce((sum, val) => sum + val, 0) / group.lats.length;
        longitude = group.lngs.reduce((sum, val) => sum + val, 0) / group.lngs.length;
      }

      // Preserve previously set coordinates if the new sync has no coordinates
      const oldNap = cachedNaps.find(n => n.name.toUpperCase() === name.toUpperCase());
      const finalLat = (latitude !== null) ? latitude : (oldNap ? oldNap.latitude : null);
      const finalLng = (longitude !== null) ? longitude : (oldNap ? oldNap.longitude : null);

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
    saveCacheToDisk();
    console.log(`✅ Synced ${cachedNaps.length} NAPs successfully.`);
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
  let affectedNap = null;
  let clientFound = null;
  let previousStatus = 'Online';

  cachedNaps.forEach((nap) => {
    const client = nap.clients.find(c => c.sn === cleanSn);
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
    affectedNap.offlineClients = offlineClients;
    affectedNap.onlineClients = totalClients - offlineClients;

    if (offlineClients === totalClients) {
      affectedNap.status = 'offline';
    } else if (offlineClients > 0) {
      affectedNap.status = 'partial';
    } else {
      affectedNap.status = 'online';
    }

    saveCacheToDisk();
    console.log(`💾 Cache updated for ONU ${cleanSn} inside ${affectedNap.name}. Status: ${newStatus}`);

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
 * cache. Unlike updateOnuStatusInCache(), this does not record one history
 * event per ONU: callers use it to make a single, coherent NAP decision from
 * one scan cycle.
 *
 * @param {Array<Object>} onus - ONUs returned by Smart OLT.
 * @returns {Array<Object>} NAPs whose calculated status changed.
 */
export function applyOnuStatusSnapshot(onus) {
  if (!Array.isArray(onus) || onus.length === 0 || cachedNaps.length === 0) {
    return [];
  }

  const statusBySn = new Map();
  onus.forEach((onu) => {
    const sn = String(onu?.sn || '').trim().toUpperCase();
    if (sn && onu?.status !== undefined && onu?.status !== null) {
      statusBySn.set(sn, String(onu.status));
    }
  });

  if (statusBySn.size === 0) return [];

  const changedNaps = [];
  cachedNaps.forEach((nap) => {
    let changed = false;

    nap.clients.forEach((client) => {
      const currentStatus = statusBySn.get(String(client.sn || '').toUpperCase());
      if (currentStatus && String(client.status || '') !== currentStatus) {
        client.status = currentStatus;
        changed = true;
      }
    });

    if (!changed) return;

    const totalClients = nap.clients.length;
    const offlineClients = nap.clients.filter((client) => {
      const status = String(client.status || '').toLowerCase();
      return status !== 'online' && status !== 'active';
    }).length;

    nap.totalClients = totalClients;
    nap.offlineClients = offlineClients;
    nap.onlineClients = totalClients - offlineClients;
    nap.status = offlineClients === totalClients
      ? 'offline'
      : offlineClients > 0
        ? 'partial'
        : 'online';
    changedNaps.push(nap);
  });

  if (changedNaps.length > 0) {
    saveCacheToDisk();
    console.log(`Applied Smart OLT status snapshot to ${changedNaps.length} NAP(s).`);
  }

  return changedNaps;
}

/**
 * Record a state change event into memory, write to disk, and broadcast via WebSockets.
 */
export function recordStatusChangeEvent(data) {
  const now = new Date();
  
  // Determine normalized failure type
  let failureType = 'unknown';
  let failureLabel = 'Alerta de Red';
  const reasonText = (data.reason || '').toLowerCase();
  const catText = (data.category || '').toLowerCase();

  const isOnline = (data.newStatus || '').toLowerCase() === 'online' || (data.newStatus || '').toLowerCase() === 'active';

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

  // Keep array within bounds (retains up to 5000 records indefinitely)
  if (statusHistory.length > MAX_HISTORY_ITEMS) {
    statusHistory = statusHistory.slice(0, MAX_HISTORY_ITEMS);
  }

  // Persist to disk debounced
  saveHistoryToDisk();

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
 * @param {number} [limit=100] - Number of items to return
 * @param {string} [filter] - 'all', 'pending', 'resolved'
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
    saveHistoryToDisk();
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
  saveHistoryToDisk();
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
    saveHistoryToDisk();
    try {
      broadcast('status_history_updated', item);
    } catch (err) {
      console.error('Error broadcasting history update:', err.message);
    }
    return item;
  }
  return null;
}

function saveHistoryToDisk() {
  if (_saveHistoryTimer) clearTimeout(_saveHistoryTimer);
  _saveHistoryTimer = setTimeout(async () => {
    _saveHistoryTimer = null;
    try {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      await fs.promises.writeFile(historyFile, JSON.stringify(statusHistory, null, 2), 'utf8');
    } catch (err) {
      console.error('❌ Failed to write status history file to disk:', err.message);
    }
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Get all cached NAPs.
 */
export function getCachedNaps() {
  return cachedNaps;
}

/**
 * Update coordinates for a specific NAP box in cache.
 * @param {string} napName - Name of the NAP box
 * @param {number} latitude - Latitude coordinate
 * @param {number} longitude - Longitude coordinate
 * @returns {Object|null} - The updated NAP object
 */
export function updateNapCoordinates(napName, latitude, longitude) {
  if (!napName) return null;
  const nap = cachedNaps.find(n => n.name.toUpperCase() === napName.toUpperCase());
  if (nap) {
    nap.latitude = parseFloat(latitude);
    nap.longitude = parseFloat(longitude);
    saveCacheToDisk();
    console.log(`📍 Manually updated coordinates for NAP ${napName}: [${latitude}, ${longitude}]`);
    return nap;
  }
  return null;
}

/**
 * Update coordinates for multiple NAPs in bulk.
 * @param {Array} updates - Array of updates: [{ name: '...', latitude: -12.1, longitude: -77.1 }]
 * @returns {Array} - Array of updated NAPs
 */
export function updateNapCoordinatesBulk(updates) {
  if (!Array.isArray(updates)) return [];
  const updatedNaps = [];

  updates.forEach(({ name, latitude, longitude }) => {
    if (!name) return;
    const nap = cachedNaps.find(n => n.name.toUpperCase() === name.toUpperCase());
    if (nap) {
      nap.latitude = parseFloat(latitude);
      nap.longitude = parseFloat(longitude);
      updatedNaps.push(nap);
    }
  });

  if (updatedNaps.length > 0) {
    saveCacheToDisk();
    console.log(`📍 Bulk updated coordinates for ${updatedNaps.length} NAPs.`);
  }

  return updatedNaps;
}

/**
 * Schedule a debounced async write of the memory cache to disk.
 * Rapid-fire calls (e.g. many ONU status updates at once) are coalesced
 * into a single write that fires 2s after the last call.
 */
function saveCacheToDisk() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    try {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      await fs.promises.writeFile(cacheFile, JSON.stringify(cachedNaps, null, 2), 'utf8');
    } catch (err) {
      console.error('❌ Failed to write cache file to disk:', err.message);
    }
  }, SAVE_DEBOUNCE_MS);
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
          updatedCount++;
        }
      }
    });

    if (updatedCount > 0) {
      console.log(`📍 Auto-seeded ${updatedCount} NAPs coordinates from coordenadas_mymaps.csv`);
      fs.writeFileSync(cacheFile, JSON.stringify(cachedNaps, null, 2), 'utf8');
    } else {
      console.log('ℹ️ All NAPs already have coordinates or no matching NAP names were found in CSV.');
    }
  } catch (err) {
    console.error('❌ Error applying CSV coordinates to cache:', err.message);
  }
}
