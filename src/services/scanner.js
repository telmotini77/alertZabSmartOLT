import { fetchAllOnus } from './smartOlt.js';
import { processAndSendAlert } from '../routes/webhook.js';
import { applyOnuStatusSnapshot, getCachedNaps } from './cache.js';
import { broadcast } from './websocket.js';
import { extractNapBox } from '../utils/parser.js';

// SN -> "Online" or "Offline"
let previousStateMap = new Map();
// Normalized NAP name -> whether every ONU in the NAP was offline in the
// preceding scan. This lets the scanner emit exactly one LOS alert per NAP.
let previousNapStateMap = new Map();
let isFirstScan = true;

const isOnline = (onu) => ['online', 'active'].includes(String(onu?.status || '').toLowerCase());

const getNapName = (onu) => {
  const directName = onu?.odb_name || onu?.odb;
  return String(directName || '').trim() ||
    extractNapBox(onu?.address) ||
    extractNapBox(onu?.description) ||
    extractNapBox(onu?.name) ||
    null;
};

const napKey = (name) => String(name || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9]/g, '')
  .toUpperCase();

const getMinimumNapClients = () => {
  const configured = Number.parseInt(process.env.NAP_LOSS_MIN_ONUS, 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 2;
};

function groupOnusByNap(onus) {
  const naps = new Map();

  onus.forEach((onu) => {
    const name = getNapName(onu);
    if (!name) return;

    const key = napKey(name);
    if (!naps.has(key)) naps.set(key, { name, onus: [] });
    naps.get(key).onus.push(onu);
  });

  return naps;
}

/**
 * Start the Smart OLT background radar scanner.
 */
export function startScanner() {
  const scanIntervalMinutes = parseInt(process.env.SMARTOLT_SCAN_INTERVAL_MINUTES, 10);

  if (isNaN(scanIntervalMinutes) || scanIntervalMinutes <= 0) {
    console.log('Smart OLT Radar Scanner is disabled (SMARTOLT_SCAN_INTERVAL_MINUTES is not set or invalid).');
    return;
  }

  const scanIntervalMs = scanIntervalMinutes * 60 * 1000;
  console.log(`Starting Smart OLT Radar Scanner. Interval: ${scanIntervalMinutes} minute(s).`);

  // Run immediately (to build the baseline), then loop.
  runScanCycle();
  setInterval(runScanCycle, scanIntervalMs);
}

/**
 * Execute one complete OLT scan. Exported to make the total-NAP outage path
 * testable without starting an HTTP server or a recurring interval.
 */
export async function runScanCycle() {
  try {
    const onus = await fetchAllOnus();
    if (!onus || onus.length === 0) return;

    // Make the cache reflect one coherent OLT snapshot before deciding whether
    // a NAP is down. Updating ONUs one at a time caused full LOS outages to be
    // presented as independent router/power failures.
    const offlineBeforeSnapshot = new Set(
      getCachedNaps()
        .filter((nap) => nap.status === 'offline')
        .map((nap) => napKey(nap.name))
    );
    const changedNaps = applyOnuStatusSnapshot(onus);
    changedNaps.forEach((nap) => broadcast('nap_status_update', nap));

    const naps = groupOnusByNap(onus);
    const fullyOfflineNapKeys = new Set();
    const newlyOfflineNaps = [];
    const minimumNapClients = getMinimumNapClients();

    naps.forEach((nap, key) => {
      const isFullyOffline = nap.onus.length >= minimumNapClients && nap.onus.every((onu) => !isOnline(onu));
      if (isFullyOffline) fullyOfflineNapKeys.add(key);

      if (!isFirstScan && isFullyOffline && !previousNapStateMap.get(key) && !offlineBeforeSnapshot.has(key)) {
        newlyOfflineNaps.push(nap);
      }
      previousNapStateMap.set(key, isFullyOffline);
    });

    let individualDropsDetected = 0;
    for (const onu of onus) {
      const sn = String(onu.sn || '').toUpperCase();
      if (!sn) continue;

      const currentStatus = isOnline(onu) ? 'Online' : 'Offline';
      if (!isFirstScan) {
        const previousStatus = previousStateMap.get(sn);

        // A fully down NAP gets the consolidated LOS report below, never one
        // Telegram message per ONU.
        if (previousStatus === 'Online' && currentStatus === 'Offline' && !fullyOfflineNapKeys.has(napKey(getNapName(onu)))) {
          individualDropsDetected++;
          await handleIndividualDrop(onu);
        }
      }
      previousStateMap.set(sn, currentStatus);
    }

    for (const nap of newlyOfflineNaps) {
      await handleNapLoss(nap);
    }

    if (isFirstScan) {
      console.log(`Radar baseline built: tracking ${previousStateMap.size} ONUs.`);
      isFirstScan = false;
    } else {
      console.log(`Radar scan complete. Detected ${newlyOfflineNaps.length} total NAP outage(s) and ${individualDropsDetected} individual drop(s).`);
    }
  } catch (error) {
    console.error('Radar scanner encountered an error:', error.message);
  }
}

async function handleIndividualDrop(onu) {
  const sn = String(onu.sn || '').toUpperCase();
  console.log(`[Radar] Detected drop for ONU ${sn}. Firing alert...`);

  const reason = onu.offline_reason || onu.last_down_reason || 'Desconexión detectada por escáner';
  const zabbixLikePayload = {
    event_name: 'Smart OLT Radar: ONU Offline',
    trigger_description: reason,
    host_name: onu.olt_name || 'Smart OLT',
    event_severity: 'High',
    event_status: 'PROBLEM',
    chat_id: process.env.TELEGRAM_CHAT_ID,
    onu_sn: sn
  };

  try {
    let overrideReason = reason;
    if (reason.toLowerCase().includes('power') || reason.toLowerCase().includes('dying')) {
      overrideReason = 'Corte de Energía (Dying Gasp)';
    } else if (reason.toLowerCase().includes('los') || reason.toLowerCase().includes('signal')) {
      overrideReason = 'Pérdida de Señal (LOS)';
    }

    await processAndSendAlert(zabbixLikePayload, onu, overrideReason);
  } catch (err) {
    console.error(`[Radar] Error firing alert for ${sn}:`, err.message);
  }
}

/**
 * Send one critical LOS notification after the complete scan confirms that all
 * registered ONUs in a NAP are offline. The cache snapshot provides the full
 * impact and its averaged GPS location for the Telegram message.
 */
async function handleNapLoss(nap) {
  const referenceOnu = nap.onus.find((onu) => !isOnline(onu));
  if (!referenceOnu) return;

  const totalClients = nap.onus.length;
  console.log(`[Radar] NAP ${nap.name}: ${totalClients}/${totalClients} ONUs offline. Sending consolidated LOS alert...`);

  const payload = {
    event_name: `Smart OLT Radar: NAP ${nap.name} Loss of Signal`,
    trigger_description: `Caída total confirmada: ${totalClients}/${totalClients} ONUs de la NAP ${nap.name} están sin señal.`,
    host_name: referenceOnu.olt_name || 'Smart OLT',
    event_severity: 'High',
    event_status: 'PROBLEM',
    chat_id: process.env.TELEGRAM_CHAT_ID,
    onu_sn: String(referenceOnu.sn || '').toUpperCase()
  };

  try {
    await processAndSendAlert(payload, referenceOnu, 'Pérdida de Señal (LOS)');
  } catch (err) {
    console.error(`[Radar] Error sending LOS alert for NAP ${nap.name}:`, err.message);
  }
}
