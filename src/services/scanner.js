import { fetchAllOnus, getOnuStatus } from './smartOlt.js';
import { applyOnuStatusSnapshot, getCachedNaps } from './cache.js';
import { broadcast } from './websocket.js';
import { extractNapBox } from '../utils/parser.js';
import {
  classifySmartOltAlert,
  clearActiveOperationalNotification,
  hasActiveOperationalNotification,
  processAndSendAlert
} from '../routes/webhook.js';

// SN -> "Online" or "Offline"
let previousStateMap = new Map();
// Normalized NAP name -> whether every ONU in the NAP was offline in the
// preceding scan. This lets the scanner emit exactly one LOS alert per NAP.
let previousNapStateMap = new Map();
let isFirstScan = true;
let rateLimitBackoffUntil = 0;
const scannerRuntimeStatus = {
  enabled: false,
  intervalMinutes: null,
  running: false,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastSuccessAt: null,
  lastError: null,
  backoffUntil: null,
  totalOnus: 0,
  offlineOnus: 0,
  lastFallbackAlerts: 0
};

export function getScannerStatus() {
  return { ...scannerRuntimeStatus };
}

const isOnline = (onu) => ['online', 'active'].includes(String(onu?.status || '').toLowerCase());
const isSupportedFailure = (category) => ['power_fail', 'loss'].includes(category);

const getRawFailureReason = (onu) => String(
  onu?.offline_reason || onu?.last_down_reason || onu?.status_reason || onu?.reason || ''
).trim();

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

function seedPreviousStateFromCache() {
  const cachedNaps = getCachedNaps();
  let seededClients = 0;

  cachedNaps.forEach((nap) => {
    const clients = nap.clients || [];
    clients.forEach((client) => {
      const sn = String(client.sn || '').trim().toUpperCase();
      if (!sn) return;
      previousStateMap.set(sn, isOnline(client) ? 'Online' : 'Offline');
      seededClients++;
    });
    previousNapStateMap.set(
      napKey(nap.name),
      clients.length >= getMinimumNapClients() && clients.every((client) => !isOnline(client))
    );
  });

  if (seededClients > 0) {
    isFirstScan = false;
    console.log(`Radar restored its baseline from SQLite: tracking ${seededClients} ONUs.`);
  }
}

/**
 * Start the Smart OLT background radar scanner.
 */
export function startScanner() {
  const configuredIntervalMinutes = parseInt(process.env.SMARTOLT_SCAN_INTERVAL_MINUTES, 10);
  const scanIntervalMinutes = Math.max(configuredIntervalMinutes || 0, 6);

  if (isNaN(configuredIntervalMinutes) || configuredIntervalMinutes <= 0) {
    scannerRuntimeStatus.enabled = false;
    scannerRuntimeStatus.lastError = 'SMARTOLT_SCAN_INTERVAL_MINUTES is not configured';
    console.log('Smart OLT Radar Scanner is disabled (SMARTOLT_SCAN_INTERVAL_MINUTES is not set or invalid).');
    return;
  }

  const scanIntervalMs = scanIntervalMinutes * 60 * 1000;
  scannerRuntimeStatus.enabled = true;
  scannerRuntimeStatus.intervalMinutes = scanIntervalMinutes;
  scannerRuntimeStatus.lastError = null;
  if (configuredIntervalMinutes < 6) {
    console.log(`Smart OLT Radar Scanner interval raised from ${configuredIntervalMinutes} to 6 minute(s) to protect the API quota.`);
  }
  console.log(`Starting Smart OLT Radar Scanner. Interval: ${scanIntervalMinutes} minute(s).`);

  // Preserve the last confirmed Smart OLT state across deployments. If the
  // API is temporarily rate-limited, the first successful scan can still
  // detect outages that occurred during the blocked interval.
  seedPreviousStateFromCache();

  // Run immediately (to build the baseline), then loop.
  runScanCycle();
  setInterval(runScanCycle, scanIntervalMs);
}

/**
 * Execute one complete OLT scan. Exported to make the total-NAP outage path
 * testable without starting an HTTP server or a recurring interval.
 */
export async function runScanCycle() {
  if (scannerRuntimeStatus.running) {
    console.log('Radar scan skipped because the preceding Smart OLT scan is still running.');
    return;
  }

  if (rateLimitBackoffUntil > Date.now()) {
    scannerRuntimeStatus.backoffUntil = new Date(rateLimitBackoffUntil).toISOString();
    console.log(`Radar scan deferred until ${scannerRuntimeStatus.backoffUntil} because Smart OLT requested rate-limit backoff.`);
    return;
  }

  scannerRuntimeStatus.running = true;
  scannerRuntimeStatus.lastStartedAt = new Date().toISOString();
  try {
    const onus = await fetchAllOnus();
    scannerRuntimeStatus.totalOnus = onus?.length || 0;
    scannerRuntimeStatus.offlineOnus = (onus || []).filter((onu) => !isOnline(onu)).length;
    scannerRuntimeStatus.lastFallbackAlerts = 0;
    if (!onus || onus.length === 0) {
      throw new Error('Smart OLT returned no ONUs');
    }

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

    const individualDrops = [];
    for (const onu of onus) {
      const sn = String(onu.sn || '').toUpperCase();
      if (!sn) continue;

      const currentStatus = isOnline(onu) ? 'Online' : 'Offline';
      if (currentStatus === 'Online') {
        clearActiveOperationalNotification(sn, getNapName(onu));
      }
      if (!isFirstScan) {
        const previousStatus = previousStateMap.get(sn);

        // A fully down NAP gets one consolidated Power Fail or LOS report
        // below, never one Telegram message per ONU.
        if (previousStatus === 'Online' && currentStatus === 'Offline' && !fullyOfflineNapKeys.has(napKey(getNapName(onu)))) {
          individualDrops.push(onu);
        }
      }
      previousStateMap.set(sn, currentStatus);
    }

    if (isFirstScan) {
      console.log(`Radar baseline built: tracking ${previousStateMap.size} ONUs.`);
      isFirstScan = false;
    } else {
      const results = [];
      for (const nap of newlyOfflineNaps) {
        results.push(await handleNapOutage(nap));
      }
      for (const onu of individualDrops) {
        results.push(await handleIndividualDrop(onu));
      }
      const delivered = results.filter((result) => result?.sent).length;
      scannerRuntimeStatus.lastFallbackAlerts = delivered;
      console.log(`Radar scan complete. Smart OLT observed ${newlyOfflineNaps.length} total NAP outage(s) and ${individualDrops.length} individual drop(s); ${delivered} fallback alert(s) delivered.`);
    }
    scannerRuntimeStatus.lastSuccessAt = new Date().toISOString();
    scannerRuntimeStatus.lastError = null;
    scannerRuntimeStatus.backoffUntil = null;
    rateLimitBackoffUntil = 0;
  } catch (error) {
    scannerRuntimeStatus.lastError = error.message;
    const retryAfterMatch = String(error.message).match(/"retry_after"\s*:\s*(\d+)/i);
    if (retryAfterMatch) {
      const retryAfterSeconds = Number.parseInt(retryAfterMatch[1], 10);
      rateLimitBackoffUntil = Date.now() + (retryAfterSeconds * 1000);
      scannerRuntimeStatus.backoffUntil = new Date(rateLimitBackoffUntil).toISOString();
      console.error(`Smart OLT rate limit reached. Radar will resume after ${scannerRuntimeStatus.backoffUntil}.`);
    }
    console.error('Radar scanner encountered an error:', error.message);
  } finally {
    scannerRuntimeStatus.running = false;
    scannerRuntimeStatus.lastCompletedAt = new Date().toISOString();
  }
}

async function resolveOnuFailure(onu) {
  let reason = getRawFailureReason(onu);
  let classification = classifySmartOltAlert(reason, onu);

  if (!isSupportedFailure(classification.category) && onu?.external_id) {
    try {
      const liveStatus = await getOnuStatus(onu.external_id);
      if (liveStatus) {
        const liveState = String(liveStatus.onu_status || liveStatus.status_desc || '').toLowerCase();
        if (['online', 'active'].includes(liveState)) {
          return { category: 'recovered', reason: '', liveStatus };
        }
        reason = String(
          liveStatus.last_down_reason || liveStatus.offline_reason ||
          liveStatus.status_reason || liveStatus.reason || reason
        ).trim();
        classification = classifySmartOltAlert(reason, liveStatus);
      }
    } catch (error) {
      console.error(`[Radar] Live cause lookup failed for ${onu.sn || 'ONU'}:`, error.message);
    }
  }

  return { ...classification, reason };
}

async function handleIndividualDrop(onu) {
  const sn = String(onu.sn || '').toUpperCase();
  const failure = await resolveOnuFailure(onu);
  if (!isSupportedFailure(failure.category)) {
    console.log(`[Radar] Individual drop ${sn} suppressed: Smart OLT did not classify it as Power Fail or LOS.`);
    return { sent: false, reason: 'Unsupported or unresolved Smart OLT cause' };
  }
  if (hasActiveOperationalNotification(sn, failure.category)) {
    console.log(`[Radar] Individual drop ${sn} already notified by Zabbix; fallback suppressed.`);
    return { sent: false, reason: 'Incident already notified' };
  }

  console.log(`[Radar] Detected ${failure.category} drop for ONU ${sn}. Firing fallback alert...`);

  const zabbixLikePayload = {
    event_name: failure.category === 'power_fail'
      ? 'Smart OLT Radar: ONU Power Fail'
      : 'Smart OLT Radar: ONU Loss of Signal',
    trigger_description: failure.reason,
    host_name: onu.olt_name || 'Smart OLT',
    event_severity: 'High',
    event_status: 'PROBLEM',
    chat_id: process.env.TELEGRAM_CHAT_ID,
    onu_sn: sn,
    source_system: 'smartolt_radar'
  };

  try {
    return await processAndSendAlert(zabbixLikePayload, onu, failure.reason);
  } catch (err) {
    console.error(`[Radar] Error firing alert for ${sn}:`, err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * Classify and send one complete-NAP incident. A total outage is not
 * automatically called LOS: Dying Gasp/Power Fail remains an electrical
 * outage, while LOS remains a fibre/signal outage.
 */
async function handleNapOutage(nap) {
  let classified = nap.onus
    .map((onu) => ({ onu, classification: classifySmartOltAlert(getRawFailureReason(onu), onu) }))
    .filter(({ classification }) => isSupportedFailure(classification.category));

  if (classified.length === 0) {
    const reference = nap.onus.find((onu) => !isOnline(onu));
    if (reference) {
      const resolved = await resolveOnuFailure(reference);
      if (isSupportedFailure(resolved.category)) {
        classified = [{ onu: reference, classification: { ...resolved, rawReason: resolved.reason } }];
      }
    }
  }

  const powerCount = classified.filter(({ classification }) => classification.category === 'power_fail').length;
  const lossCount = classified.filter(({ classification }) => classification.category === 'loss').length;
  if (powerCount === 0 && lossCount === 0) {
    console.log(`[Radar] NAP ${nap.name} is fully offline, but Smart OLT did not report Power Fail or LOS.`);
    return { sent: false, reason: 'Unsupported or unresolved Smart OLT cause' };
  }

  // A full NAP with at least as much LOS evidence as electrical evidence is
  // treated as a shared optical incident. Otherwise it remains Power Fail.
  const category = lossCount >= powerCount ? 'loss' : 'power_fail';
  const selected = classified.find(({ classification }) => classification.category === category);
  const referenceOnu = selected?.onu || nap.onus.find((onu) => !isOnline(onu));
  const sn = String(referenceOnu?.sn || '').toUpperCase();
  if (!referenceOnu || !sn) return { sent: false, reason: 'NAP has no reference ONU' };
  if (hasActiveOperationalNotification(sn, category)) {
    console.log(`[Radar] NAP ${nap.name} already has a delivered ${category} alert; fallback suppressed.`);
    return { sent: false, reason: 'Incident already notified' };
  }

  const totalClients = nap.onus.length;
  const failureType = category === 'power_fail' ? 'Power Fail' : 'Loss of Signal';
  const reason = category === 'power_fail'
    ? 'Corte de Energía (Dying Gasp)'
    : 'Pérdida de Señal (LOS)';
  console.log(`[Radar] NAP ${nap.name}: ${totalClients}/${totalClients} ONUs offline. Sending consolidated ${failureType} fallback alert...`);

  const payload = {
    event_name: `Smart OLT Radar: NAP ${nap.name} ${failureType}`,
    trigger_description: category === 'power_fail'
      ? `Corte de energía confirmado: ${totalClients}/${totalClients} ONU/router de ${nap.name} están apagados.`
      : `Pérdida de señal confirmada: ${totalClients}/${totalClients} ONUs de ${nap.name} están sin señal.`,
    host_name: referenceOnu.olt_name || 'Smart OLT',
    event_severity: 'High',
    event_status: 'PROBLEM',
    chat_id: process.env.TELEGRAM_CHAT_ID,
    onu_sn: sn,
    source_system: 'smartolt_radar'
  };

  try {
    return await processAndSendAlert(payload, referenceOnu, reason);
  } catch (err) {
    console.error(`[Radar] Error sending ${failureType} alert for NAP ${nap.name}:`, err.message);
    return { sent: false, reason: err.message };
  }
}
