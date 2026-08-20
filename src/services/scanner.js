import { applyOnuStatusSnapshot, fetchMonitoringOnus, getCachedNaps } from './cache.js';
import { broadcast } from './websocket.js';
import { extractNapBox } from '../utils/parser.js';
import {
  classifySmartOltAlert,
  clearActiveOperationalNotification,
  hasActiveNapIncidentNotification,
  isNapIncidentRepeatDue,
  processAndSendAlert
} from '../routes/webhook.js';

// SN -> "online", a reportable operational failure type, or
// "ignored_offline".  A bare Offline status is a permanent/disconnected ONU
// in this installation and must never become an operational alert.
let previousStateMap = new Map();
// OLT + normalized NAP -> the complete active incident category. A NAP name
// can be reused on a different OLT, so it must never share alert state.
let previousNapStateMap = new Map();
let isFirstScan = true;
let rateLimitBackoffUntil = 0;
const scannerRuntimeStatus = {
  enabled: false,
  dataSource: 'get_onus_statuses',
  intervalMinutes: null,
  running: false,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastSuccessAt: null,
  lastError: null,
  backoffUntil: null,
  totalOnus: 0,
  oltCount: 0,
  olts: [],
  offlineOnus: 0,
  ignoredOfflineOnus: 0,
  reportableFailureOnus: 0,
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

/**
 * Smart OLT's status label is the source of truth for automatic alerts.
 * "Offline" without Power fail/Dying Gasp or LOS is deliberately ignored: it
 * normally represents an ONU that is permanently disconnected or disabled.
 */
const getReportableFailureCategory = (onu) => {
  if (isOnline(onu)) return null;
  const reason = getRawFailureReason(onu) || String(onu?.status || '').trim();
  const category = classifySmartOltAlert(reason, onu).category;
  return isSupportedFailure(category) ? category : null;
};

const getOperationalState = (onu) => {
  if (isOnline(onu)) return 'online';
  return getReportableFailureCategory(onu) || 'ignored_offline';
};

const getNapName = (onu) => {
  const directName = onu?.odb_name || onu?.odb;
  return String(directName || '').trim() ||
    extractNapBox(onu?.address) ||
    extractNapBox(onu?.description) ||
    extractNapBox(onu?.name) ||
    null;
};

const normalizeNapName = (name) => String(name || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9]/g, '')
  .toUpperCase();

const getOltKey = (onu = {}) => {
  const accountId = String(onu?.smartolt_account_id || onu?.smartOltAccountId || 'default').trim();
  const oltId = String(onu?.olt_id ?? onu?.oltId ?? '').trim();
  if (oltId) return `account:${accountId}:id:${oltId}`;
  return `account:${accountId}:name:${String(onu?.olt_name || onu?.oltName || 'unknown').trim().toUpperCase()}`;
};

const napKey = (name, olt = {}) => `${getOltKey(olt)}:${normalizeNapName(name)}`;

const getNapKeyForOnu = (onu) => napKey(getNapName(onu), onu);

const getOnuKey = (onu = {}) =>
  `${String(onu?.smartolt_account_id || onu?.smartOltAccountId || 'default').trim()}:${String(onu?.sn || '').trim().toUpperCase()}`;

const getMinimumNapClients = () => {
  // A NAP with one provisioned/active router is also fully affected when
  // that router is explicitly reported Power fail or LOS.  This setting is
  // deliberately separate from the previous LOS/Zabbix evidence threshold.
  const configured = Number.parseInt(process.env.NAP_TOTAL_OUTAGE_MIN_ONUS, 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 1;
};

function groupOnusByNap(onus) {
  const naps = new Map();

  onus.forEach((onu) => {
    const name = getNapName(onu);
    if (!name) return;

    const key = getNapKeyForOnu(onu);
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
      // Persisted Power fail/LOS statuses are a valid baseline after a
      // restart. A generic Offline remains ignored because it has no
      // actionable cause. This prevents a deployment from re-sending every
      // already active electrical/LOS incident.
      previousStateMap.set(getOnuKey(client), getOperationalState(client));
      seededClients++;
    });
    const relevantClients = clients.filter((client) =>
      isOnline(client) || getReportableFailureCategory(client)
    );
    const categories = relevantClients.map(getReportableFailureCategory).filter(Boolean);
    const completeCategory = relevantClients.length >= getMinimumNapClients() &&
      categories.length === relevantClients.length &&
      new Set(categories).size === 1
      ? categories[0]
      : null;
    previousNapStateMap.set(napKey(nap.name, nap), completeCategory);
  });

  if (seededClients > 0) {
    isFirstScan = false;
    console.log(`Radar restored its baseline from SQLite: tracking ${seededClients} ONUs.`);
  }
}

// After a deployment the persisted cache can predate the OLT-ID column.  Use
// the individual ONU baseline as a fallback so an already-active complete
// outage is not re-announced simply because its NAP key became more precise.
function getPreviousNapCategory(nap, key) {
  if (previousNapStateMap.has(key)) return previousNapStateMap.get(key);

  const relevantOnus = nap.onus.filter((onu) => isOnline(onu) || getReportableFailureCategory(onu));
  const states = relevantOnus.map((onu) => previousStateMap.get(getOnuKey(onu)));
  return relevantOnus.length >= getMinimumNapClients() &&
    states.length === relevantOnus.length &&
    states.every((state) => state === 'power_fail')
    ? 'power_fail'
    : relevantOnus.length >= getMinimumNapClients() &&
      states.length === relevantOnus.length &&
      states.every((state) => state === 'loss')
      ? 'loss'
      : null;
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
    // Use Smart OLT's compact bulk status endpoint. The full ONU-details
    // export is limited by Smart OLT and is reserved for slow cache refreshes.
    const onus = await fetchMonitoringOnus();
    scannerRuntimeStatus.totalOnus = onus?.length || 0;
    const oltSummary = new Map();
    (onus || []).forEach((onu) => {
      const key = getOltKey(onu);
      const entry = oltSummary.get(key) || {
        accountId: String(onu?.smartolt_account_id || onu?.smartOltAccountId || 'default').trim(),
        id: String(onu?.olt_id ?? onu?.oltId ?? '').trim() || null,
        name: String(onu?.olt_name || onu?.oltName || '').trim() || 'OLT sin nombre',
        onus: 0
      };
      entry.onus++;
      oltSummary.set(key, entry);
    });
    scannerRuntimeStatus.oltCount = oltSummary.size;
    scannerRuntimeStatus.olts = [...oltSummary.values()]
      .sort((left, right) => String(left.id || left.name).localeCompare(String(right.id || right.name)));
    const reportableFailureOnus = (onus || []).filter((onu) => getReportableFailureCategory(onu));
    const ignoredOfflineOnus = (onus || []).filter((onu) => !isOnline(onu) && !getReportableFailureCategory(onu));
    // Kept for backwards-compatible health output: it now means reportable
    // failures only, never the permanent bare-Offline inventory.
    scannerRuntimeStatus.offlineOnus = reportableFailureOnus.length;
    scannerRuntimeStatus.reportableFailureOnus = reportableFailureOnus.length;
    scannerRuntimeStatus.ignoredOfflineOnus = ignoredOfflineOnus.length;
    scannerRuntimeStatus.lastFallbackAlerts = 0;
    if (!onus || onus.length === 0) {
      throw new Error('Smart OLT returned no ONUs');
    }

    // Make the cache reflect one coherent OLT snapshot before deciding whether
    // a NAP is down. Updating ONUs one at a time caused full LOS outages to be
    // presented as independent router/power failures.
    const changedNaps = applyOnuStatusSnapshot(onus);
    changedNaps.forEach((nap) => broadcast('nap_status_update', nap));

    const naps = groupOnusByNap(onus);
    const newlyOfflineNaps = [];
    const minimumNapClients = getMinimumNapClients();

    naps.forEach((nap, key) => {
      // Do not allow permanent bare-Offline ONUs to convert a normal power
      // incident into a "full NAP" outage. Only Online and explicitly
      // classified Power fail/LOS ONUs participate in this decision.
      const relevantOnus = nap.onus.filter((onu) => isOnline(onu) || getReportableFailureCategory(onu));
      const categories = relevantOnus.map(getReportableFailureCategory).filter(Boolean);
      const completeCategory = relevantOnus.length >= minimumNapClients &&
        categories.length === relevantOnus.length &&
        new Set(categories).size === 1
        ? categories[0]
        : null;
      const previousCategory = getPreviousNapCategory(nap, key);
      const repeatDue = completeCategory && isNapIncidentRepeatDue(nap.name, nap.onus[0] || {});
      if (completeCategory &&
          ((!isFirstScan && previousCategory !== completeCategory) || repeatDue)) {
        newlyOfflineNaps.push({ ...nap, category: completeCategory });
      }
      previousNapStateMap.set(key, completeCategory);
    });

    for (const onu of onus) {
      const sn = String(onu.sn || '').toUpperCase();
      if (!sn) continue;

      const currentState = getOperationalState(onu);
      if (currentState === 'online') {
        clearActiveOperationalNotification(sn, getNapName(onu), onu);
      }
      previousStateMap.set(getOnuKey(onu), currentState);
    }

    if (isFirstScan) {
      console.log(`Radar baseline built: tracking ${previousStateMap.size} ONUs.`);
      isFirstScan = false;
    } else {
      const results = [];
      for (const nap of newlyOfflineNaps) {
        results.push(await handleNapOutage(nap, nap.category));
      }
      const delivered = results.filter((result) => result?.sent).length;
      scannerRuntimeStatus.lastFallbackAlerts = delivered;
      console.log(`Radar scan complete. Smart OLT observed ${newlyOfflineNaps.length} total NAP outage(s); ${delivered} fallback alert(s) delivered.`);
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

/**
 * Classify and send one complete-NAP incident. A total outage is not
 * automatically called LOS: Dying Gasp/Power Fail remains an electrical
 * outage, while LOS remains a fibre/signal outage.
 */
async function handleNapOutage(nap, category) {
  if (!isSupportedFailure(category)) {
    return { sent: false, reason: 'Unsupported complete NAP cause' };
  }
  const referenceOnu = nap.onus.find((onu) => getReportableFailureCategory(onu) === category);
  const sn = String(referenceOnu?.sn || '').toUpperCase();
  if (!referenceOnu || !sn) return { sent: false, reason: 'NAP has no reference ONU' };
  if (hasActiveNapIncidentNotification(nap.name, referenceOnu)) {
    console.log(`[Radar] NAP ${nap.name} already has a delivered ${category} alert; fallback suppressed.`);
    return { sent: false, reason: 'Incident already notified' };
  }

  // Do not describe permanently disconnected bare-Offline ONUs as part of
  // this incident's scope.
  const totalClients = nap.onus.filter((onu) =>
    isOnline(onu) || getReportableFailureCategory(onu)
  ).length;
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
