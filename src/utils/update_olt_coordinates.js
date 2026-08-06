import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Configure dotenv
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import Smart OLT API clients and utils
import { fetchAllOnus } from '../services/smartOlt.js';
import { syncCacheWithSmartOlt } from '../services/cache.js';
import { extractNapBox } from './parser.js';

// Setup paths
const CSV_PATH = path.join(__dirname, '../public/coordenadas_mymaps.csv');
const SMARTOLT_SUBDOMAIN = (process.env.SMARTOLT_SUBDOMAIN || '').trim();
const SMARTOLT_API_KEY = (process.env.SMARTOLT_API_KEY || '').trim();

const getHeaders = () => ({
  'X-Token': SMARTOLT_API_KEY,
  'Accept': 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded'
});

const getBaseUrl = () => {
  if (!SMARTOLT_SUBDOMAIN) {
    throw new Error('SMARTOLT_SUBDOMAIN environment variable is missing.');
  }
  return `https://${SMARTOLT_SUBDOMAIN}.smartolt.com/api`;
};

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

// Read and parse coordinates CSV
function loadCoordinatesFromCsv(filePath) {
  console.log(`📖 Reading coordinates from CSV: ${filePath}`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV file not found at: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const napCoordinates = {};

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCsvLine(line);
    if (cols.length < 4) continue;

    const name = cols[1]; // Nombre
    const latStr = cols[2]; // Latitud
    const lngStr = cols[3]; // Longitud

    const lat = parseFloat(latStr);
    const lng = parseFloat(lngStr);

    if (name && !isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
      napCoordinates[name.trim().toUpperCase()] = { latitude: lat, longitude: lng };
    }
  }

  console.log(`✅ Loaded ${Object.keys(napCoordinates).length} unique NAP coordinates from CSV.`);
  return napCoordinates;
}

// Delay helper for rate limiting
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function updateOnuCoordinates(onuExternalId, lat, lng) {
  const url = `${getBaseUrl()}/onu/update_location_details/${encodeURIComponent(onuExternalId)}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: getHeaders(),
    body: new URLSearchParams({
      latitude: lat.toFixed(6),
      longitude: lng.toFixed(6)
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API returned ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  if (data && data.status === false) {
    throw new Error(data.error || 'Unknown API error');
  }

  return data;
}

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run') || args.includes('-d');

  console.log('==================================================');
  console.log('📍 SMART OLT COORDINATES UPDATER');
  if (isDryRun) {
    console.log('🧪 MODE: DRY-RUN (Simulación - No se realizarán cambios)');
  } else {
    console.log('🚀 MODE: EXECUTE (Se realizarán escrituras en Smart OLT)');
  }
  console.log('==================================================');

  try {
    // 1. Load CSV coordinates
    const csvCoordinates = loadCoordinatesFromCsv(CSV_PATH);

    // 2. Fetch all ONUs from OLT
    console.log('📡 Fetching all ONUs from Smart OLT...');
    const onus = await fetchAllOnus();
    console.log(`✅ Fetched ${onus.length} ONUs from OLT.`);

    // 3. Process each ONU
    const updatesNeeded = [];

    onus.forEach((onu) => {
      // Find NAP name associated with ONU
      const napName = (onu.odb_name ? onu.odb_name.trim() : '') || 
                      (onu.odb ? onu.odb.trim() : '') || 
                      extractNapBox(onu.address) || 
                      extractNapBox(onu.description);
      
      if (!napName) return;

      const napKey = napName.trim().toUpperCase();
      const csvCoords = csvCoordinates[napKey];

      if (csvCoords) {
        const currentLat = parseFloat(onu.latitude);
        const currentLng = parseFloat(onu.longitude);

        // Check if coordinates need updating
        const needsUpdate = isNaN(currentLat) || isNaN(currentLng) ||
                            Math.abs(currentLat - csvCoords.latitude) > 0.00001 ||
                            Math.abs(currentLng - csvCoords.longitude) > 0.00001;

        if (needsUpdate) {
          updatesNeeded.push({
            onu_name: onu.name,
            unique_external_id: onu.unique_external_id || onu.sn,
            nap: napName,
            current: { lat: currentLat, lng: currentLng },
            target: csvCoords
          });
        }
      }
    });

    console.log(`\n📊 Analysis Summary:`);
    console.log(`- Total ONUs analyzed: ${onus.length}`);
    console.log(`- ONUs needing coordinates update: ${updatesNeeded.length}`);

    if (updatesNeeded.length === 0) {
      console.log('🎉 All ONUs already have up-to-date coordinates. Nothing to do!');
      return;
    }

    if (isDryRun) {
      console.log('\n🔍 Preview of updates (first 10):');
      updatesNeeded.slice(0, 10).forEach((up, idx) => {
        console.log(`  [${idx+1}] ONU: "${up.onu_name}" (${up.unique_external_id}) under NAP: ${up.nap}`);
        console.log(`      Current: [${isNaN(up.current.lat) ? 'N/A' : up.current.lat.toFixed(6)}, ${isNaN(up.current.lng) ? 'N/A' : up.current.lng.toFixed(6)}]`);
        console.log(`      Target:  [${up.target.latitude.toFixed(6)}, ${up.target.longitude.toFixed(6)}]`);
      });
      if (updatesNeeded.length > 10) {
        console.log(`  ... and ${updatesNeeded.length - 10} more updates.`);
      }
      return;
    }

    // 4. Perform updates
    console.log(`\n⏳ Starting sequential updates to Smart OLT (with 300ms delay between calls)...`);
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < updatesNeeded.length; i++) {
      const up = updatesNeeded[i];
      const percent = (((i + 1) / updatesNeeded.length) * 100).toFixed(1);
      
      try {
        console.log(`[${i + 1}/${updatesNeeded.length}] (${percent}%) Updating ONU "${up.onu_name}" (${up.unique_external_id}) to [${up.target.latitude.toFixed(6)}, ${up.target.longitude.toFixed(6)}]`);
        
        await updateOnuCoordinates(up.unique_external_id, up.target.latitude, up.target.longitude);
        successCount++;
      } catch (err) {
        console.error(`❌ Failed to update ONU "${up.onu_name}" (${up.unique_external_id}): ${err.message}`);
        failCount++;
      }

      // 300ms delay to avoid OLT API rate limits
      await delay(300);
    }

    console.log(`\n🏁 Update completed! Success: ${successCount}, Failures: ${failCount}`);

    // 5. Rebuild local cache
    if (successCount > 0) {
      console.log('\n🔄 Rebuilding local NAP cache from updated OLT data...');
      await syncCacheWithSmartOlt();
      console.log('✅ Local cache successfully updated.');
    }

  } catch (error) {
    console.error('💥 Execution failed:', error.message);
  }
}

main();
