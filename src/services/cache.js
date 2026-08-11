import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchAllOnus } from './smartOlt.js';
import { extractNapBox } from '../utils/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Debounced async disk write ───────────────────────────────────────────────
let _saveTimer = null;
const SAVE_DEBOUNCE_MS = 2_000; // batch rapid updates into a single disk write

const defaultCacheFile = path.resolve(__dirname, '../../data/nap_cache.json');
// Tests and maintenance jobs can use an isolated cache without touching the
// production map data.
const cacheFile = process.env.NAP_CACHE_FILE
  ? path.resolve(process.env.NAP_CACHE_FILE)
  : defaultCacheFile;
const cacheDir = path.dirname(cacheFile);

// Memory cache
let cachedNaps = [];

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
 */
export function updateOnuStatusInCache(sn, newStatus) {
  if (!sn) return null;
  const cleanSn = sn.toUpperCase();
  let affectedNap = null;

  cachedNaps.forEach((nap) => {
    const client = nap.clients.find(c => c.sn === cleanSn);
    if (client) {
      client.status = newStatus;
      affectedNap = nap;
    }
  });

  if (affectedNap) {
    // Recompute NAP status
    const totalClients = affectedNap.clients.length;
    const offlineClients = affectedNap.clients.filter(c => {
      const s = c.status.toLowerCase();
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
  }

  return affectedNap;
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
