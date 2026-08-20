import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findOnuBySn, getOnuStatus } from '../services/smartOlt.js';
import { sendMessage, sendNotification, replyToMessage } from '../services/telegram.js';
import { extractSerialNumber, extractNapBox, parseStatusInfo, extractEventTime, formatDateTime, extractBoardAndPort } from '../utils/parser.js';
import { broadcast } from '../services/websocket.js';
import { applyOnuStatusSnapshot, fetchMonitoringOnus, findCachedOnuBySn, updateOnuStatusInCache, getCachedNaps, getStatusHistory, deleteHistoryItem, clearHistory, resolveHistoryItem, updateHistoryEventDetails } from '../services/cache.js';
import { getActiveTriggers } from '../services/zabbix.js';
import {
  dbDeleteOperationalAlertState,
  dbGetOperationalAlertStates,
  dbGetOpticalHistory,
  dbSaveOperationalAlertState,
  dbSaveOpticalRecord
} from '../services/db.js';
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

const findCachedNap = (napName, referenceOnu = null) => {
  const normalizedName = normalizeNapName(napName);
  if (!normalizedName) return null;
  const candidates = getCachedNaps().filter((nap) => normalizeNapName(nap.name) === normalizedName);
  if (!referenceOnu) return candidates[0] || null;
  const accountId = String(referenceOnu.smartolt_account_id || referenceOnu.smartOltAccountId || 'default').trim();
  const oltId = String(referenceOnu.olt_id ?? referenceOnu.oltId ?? '').trim();
  return candidates.find((nap) => {
    const napAccountId = String(nap.smartolt_account_id || 'default').trim();
    if (napAccountId !== accountId) return false;
    return !oltId || String(nap.olt_id || '').trim() === oltId;
  }) || null;
};

const findCachedNapBySn = (sn) => {
  const normalizedSn = String(sn || '').trim().toUpperCase();
  if (!normalizedSn) return null;
  return getCachedNaps().find((nap) =>
    nap.clients?.some((client) => String(client.sn || '').trim().toUpperCase() === normalizedSn)
  ) || null;
};

const getCoordinates = (source) => {
  const latitude = Number(source?.latitude ?? source?.gps_lat);
  const longitude = Number(source?.longitude ?? source?.gps_lng);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude !== 0 && longitude !== 0
    ? { latitude, longitude }
    : null;
};

const getNearbyNapAnalysisRadiusKm = () =>
  Math.min(getPositiveNumber(process.env.NAP_NEARBY_ANALYSIS_RADIUS_KM, 1), 5);

/**
 * Keep the expensive live Smart OLT checks physically local to the incident.
 * The complete port snapshot is still used to calculate impact, but the cause
 * is corroborated with the affected NAP and NAPs inside the configured radius.
 * When GPS is unavailable, only the affected NAP is selected conservatively.
 */
export function selectNearbyNapOnusForAnalysis(onus = [], preferredNapName = '') {
  const groupsByNap = new Map();

  onus.forEach((onu) => {
    const name = getNapNameFromOnu(onu) || 'NAP Desconocida';
    const key = normalizeNapName(name) || 'NAPDESCONOCIDA';
    if (!groupsByNap.has(key)) groupsByNap.set(key, { key, name, onus: [] });
    groupsByNap.get(key).onus.push(onu);
  });

  const groups = [...groupsByNap.values()];
  if (groups.length === 0) {
    return { onus: [], focusNapName: '', nearbyNapCount: 0, radiusKm: getNearbyNapAnalysisRadiusKm() };
  }

  const preferredKey = normalizeNapName(preferredNapName);
  const focusGroup = groups.find((group) => group.key === preferredKey) ||
    [...groups].sort((left, right) =>
      right.onus.length - left.onus.length || left.name.localeCompare(right.name, undefined, { numeric: true })
    )[0];
  const focusCoordinates = getCoordinates(findCachedNap(focusGroup.name)) ||
    focusGroup.onus.map(getCoordinates).find(Boolean) || null;
  const radiusKm = getNearbyNapAnalysisRadiusKm();

  const nearbyGroups = groups
    .map((group) => {
      const coordinates = getCoordinates(findCachedNap(group.name)) || group.onus.map(getCoordinates).find(Boolean) || null;
      const distanceKm = focusCoordinates && coordinates
        ? haversineKm(focusCoordinates.latitude, focusCoordinates.longitude, coordinates.latitude, coordinates.longitude)
        : null;
      return { group, distanceKm };
    })
    .filter(({ group, distanceKm }) => group.key === focusGroup.key || (distanceKm !== null && distanceKm <= radiusKm))
    .sort((left, right) => {
      if (left.group.key === focusGroup.key) return -1;
      if (right.group.key === focusGroup.key) return 1;
      return (left.distanceKm || 0) - (right.distanceKm || 0) ||
        left.group.name.localeCompare(right.group.name, undefined, { numeric: true });
    });

  // Interleave NAPs so the configured lookup cap samples the failed box and
  // each nearby box, instead of spending every lookup on a large single NAP.
  const selectedOnus = [];
  for (let index = 0; ; index++) {
    let added = false;
    nearbyGroups.forEach(({ group }) => {
      if (group.onus[index]) {
        selectedOnus.push(group.onus[index]);
        added = true;
      }
    });
    if (!added) break;
  }

  return {
    onus: selectedOnus,
    focusNapName: focusGroup.name,
    nearbyNapCount: Math.max(nearbyGroups.length - 1, 0),
    radiusKm
  };
}

const getMinimumNapClients = () => {
  const configured = Number.parseInt(process.env.NAP_TOTAL_OUTAGE_MIN_ONUS, 10);
  // A NAP with one registered active ONU is still a complete NAP outage when
  // that ONU is confirmed Power fail or LOS.
  return Number.isInteger(configured) && configured > 0 ? configured : 1;
};

// One operational Telegram alert is enough while a NAP is down. If it still
// has not recovered six hours later, operations receive a single reminder.
// The timestamps are persisted so a deploy cannot reset this six-hour window.
const OPERATIONAL_ALERT_REPEAT_MS = 6 * 60 * 60 * 1_000;
const ACTIVE_ONU_ALERT_PREFIX = 'onu:';
const ACTIVE_NAP_ALERT_PREFIX = 'nap:';
const activeNapIncidentNotifications = new Map();
const activeOperationalNotifications = new Map();
const pendingNapIncidentNotifications = new Set();

const operationalNotificationKey = (sn, category, olt = {}) =>
  `${ACTIVE_ONU_ALERT_PREFIX}${getOltIdentity(olt)}:${String(sn || '').trim().toUpperCase()}:${String(category || '').trim().toLowerCase()}`;

const napNotificationKey = (napName, olt = {}) =>
  `${ACTIVE_NAP_ALERT_PREFIX}${getNapIncidentKey(napName, olt)}`;

const wasSentWithinRepeatWindow = (notifications, key) => {
  const lastSentAt = Number(notifications.get(key));
  return Number.isFinite(lastSentAt) && Date.now() - lastSentAt < OPERATIONAL_ALERT_REPEAT_MS;
};

const isRepeatDue = (notifications, key) => {
  const lastSentAt = Number(notifications.get(key));
  return Number.isFinite(lastSentAt) && Date.now() - lastSentAt >= OPERATIONAL_ALERT_REPEAT_MS;
};

export function hasActiveOperationalNotification(sn, category, olt = {}) {
  return wasSentWithinRepeatWindow(activeOperationalNotifications, operationalNotificationKey(sn, category, olt));
}

export function hasActiveNapIncidentNotification(napName, olt = {}) {
  return wasSentWithinRepeatWindow(activeNapIncidentNotifications, napNotificationKey(napName, olt));
}

export function isNapIncidentRepeatDue(napName, olt = {}) {
  return isRepeatDue(activeNapIncidentNotifications, napNotificationKey(napName, olt));
}

export function clearActiveOperationalNotification(sn, napName = '', olt = {}) {
  const prefix = `${ACTIVE_ONU_ALERT_PREFIX}${getOltIdentity(olt)}:${String(sn || '').trim().toUpperCase()}:`;
  for (const key of activeOperationalNotifications.keys()) {
    if (key.startsWith(prefix)) {
      activeOperationalNotifications.delete(key);
      dbDeleteOperationalAlertState(key).catch(() => {});
    }
  }
  if (napName) {
    const key = napNotificationKey(napName, olt);
    activeNapIncidentNotifications.delete(key);
    dbDeleteOperationalAlertState(key).catch(() => {});
  }
}

function markActiveOperationalNotification(sn, category, olt = {}) {
  if (sn && category) {
    const now = Date.now();
    const key = operationalNotificationKey(sn, category, olt);
    activeOperationalNotifications.set(key, now);
    dbSaveOperationalAlertState(key, now).catch(() => {});
    const napName = getNapNameFromOnu(olt);
    if (napName) {
      const napKey = napNotificationKey(napName, olt);
      activeNapIncidentNotifications.set(napKey, now);
      dbSaveOperationalAlertState(napKey, now).catch(() => {});
    }
  }
}

/** Restore six-hour Telegram throttles before the Smart OLT radar starts. */
export async function restoreOperationalNotificationState() {
  const states = await dbGetOperationalAlertStates();
  states.forEach((state) => {
    const key = String(state?.alertKey || '');
    const timestamp = Number(state?.lastSentAt);
    if (!Number.isFinite(timestamp)) return;
    if (key.startsWith(ACTIVE_ONU_ALERT_PREFIX)) activeOperationalNotifications.set(key, timestamp);
    if (key.startsWith(ACTIVE_NAP_ALERT_PREFIX)) activeNapIncidentNotifications.set(key, timestamp);
  });
  if (states.length > 0) {
    console.log(`📨 Restored ${states.length} Telegram operational alert throttle(s).`);
  }
}

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
  if (text.includes('los') || text.includes('signal') || text.includes('señal') || text.includes('fibra') || text.includes('fiber')) {
    return 'loss';
  }
  return 'unknown';
};

/**
 * Smart OLT is the authoritative source for the incident type. Keep the raw
 * reason for the technician, but map common OLT reasons to a concise title.
 * Unknown values are still notified verbatim instead of being relabelled from
 * the Zabbix trigger.
 */
export function classifySmartOltAlert(reason, liveStatus = {}) {
  const rawReason = String(reason || '').trim();
  const text = rawReason
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const status = String(
    liveStatus?.onu_status || liveStatus?.status_desc || liveStatus?.status || ''
  ).trim().toLowerCase();

  if (/(low.*(power|signal|optic)|weak.*signal|rx.*low|optical.*power)/.test(text)) {
    return { category: 'low_optical_power', label: 'Potencia óptica baja', emoji: '📶', rawReason };
  }
  if (/(dying|gasp|power|energia|electric|pwrfail)/.test(text) || /(?:power\s*fail|pwrfail)/.test(status)) {
    return { category: 'power_fail', label: 'Corte de energía', emoji: '🔌', rawReason };
  }
  if (/(loss of signal|\blos\b|signal|fibra|fiber|optic.*loss|link.*down)/.test(text) || /(?:loss\s*of\s*signal|\blos\b)/.test(status)) {
    return { category: 'loss', label: 'Pérdida de señal (LOS)', emoji: '🔴', rawReason };
  }
  if (/(reboot|reset|restart)/.test(text)) {
    return { category: 'reboot', label: 'Reinicio de ONU', emoji: '🔄', rawReason };
  }
  if (/(disable|deactiv|deregister|delete)/.test(text)) {
    return { category: 'disabled', label: 'ONU deshabilitada', emoji: '⛔', rawReason };
  }
  if (/(auth|password|unauthor|registration fail|rogue)/.test(text)) {
    return { category: 'authentication', label: 'Fallo de autenticación de ONU', emoji: '🔐', rawReason };
  }
  if (rawReason) {
    return { category: 'olt_event', label: rawReason, emoji: '⚠️', rawReason };
  }
  if (/(offline|down|inactive)/.test(status)) {
    return { category: 'olt_offline', label: 'ONU Offline reportada por Smart OLT', emoji: '🔴', rawReason: '' };
  }
  return { category: 'unknown', label: 'Tipo no reportado por Smart OLT', emoji: '⚠️', rawReason: '' };
}

/**
 * Compare the diagnosis already obtained from Smart OLT with the trigger sent
 * by Zabbix. Smart OLT owns the state and failure type; Zabbix contributes the
 * independent event evidence, severity and timestamp.
 */
export function compareSmartOltWithZabbix(smartOltAlert, zabbixStatusInfo = {}, eventStatus = 'PROBLEM', onu = {}) {
  const smartCategory = smartOltAlert?.category || 'unknown';
  const zabbixCategory = zabbixStatusInfo?.category || 'unknown';
  const smartLabel = smartOltAlert?.label || 'Tipo no reportado por Smart OLT';
  const zabbixLabel = zabbixStatusInfo?.status || 'Evento genérico de Zabbix';
  const smartIsOnline = isOnuOnline(onu);

  if (eventStatus === 'PROBLEM' && smartIsOnline) {
    return {
      confirmed: false,
      agreement: 'state_mismatch',
      smartCategory,
      zabbixCategory,
      smartLabel,
      zabbixLabel,
      verdict: 'No confirmada: Zabbix reporta PROBLEM, pero Smart OLT mantiene la ONU Online.'
    };
  }

  if (eventStatus === 'OK') {
    return {
      confirmed: smartIsOnline,
      agreement: smartIsOnline ? 'recovery_match' : 'state_mismatch',
      smartCategory,
      zabbixCategory,
      smartLabel,
      zabbixLabel,
      verdict: smartIsOnline
        ? 'Restablecimiento confirmado por ambas fuentes.'
        : 'Restablecimiento no confirmado: Smart OLT todavía reporta la ONU Offline.'
    };
  }

  const comparableSmartCategory = !['unknown', 'olt_offline'].includes(smartCategory);
  const comparableZabbixCategory = zabbixCategory !== 'unknown';
  const sameCategory = comparableSmartCategory && comparableZabbixCategory && smartCategory === zabbixCategory;

  return {
    confirmed: !smartIsOnline,
    agreement: sameCategory ? 'match' : 'reclassified',
    smartCategory,
    zabbixCategory,
    smartLabel,
    zabbixLabel,
    verdict: sameCategory
      ? `Confirmada: Smart OLT y Zabbix coinciden en ${smartLabel}.`
      : `Confirmada y clasificada por Smart OLT como ${smartLabel}; Zabbix se usa como evidencia del evento.`
  };
}

function formatSourceComparison(comparison, eventStatus, onu, oltStatusReason = '') {
  if (!comparison) return '';
  const smartState = isOnuOnline(onu) ? 'Online' : 'Offline';
  const reasonSuffix = oltStatusReason ? ` — <code>${oltStatusReason}</code>` : '';
  if (comparison.radarOnly) {
    return `
🔎 <b>Validación de la alerta:</b>
• <b>Smart OLT (principal):</b> ${smartState} — ${comparison.smartLabel}${reasonSuffix}
• <b>Zabbix:</b> Sin evento oportuno para esta caída
• <b>Resultado:</b> Smart OLT confirmó el estado y activó la alerta de respaldo.
`.trim();
  }
  return `
🔎 <b>Comparación Smart OLT ↔ Zabbix:</b>
• <b>1. Smart OLT (principal):</b> ${smartState} — ${comparison.smartLabel}${reasonSuffix}
• <b>2. Zabbix (confirmación):</b> ${eventStatus} — ${comparison.zabbixLabel}
• <b>Resultado:</b> ${comparison.verdict}
`.trim();
}

const getNapNameFromOnu = (onu) => String(
  onu?.odb_name || onu?.odb || extractNapBox(onu?.address) || extractNapBox(onu?.description) || ''
).trim();

/**
 * Make the physical box unmistakable in Telegram. Smart OLT commonly stores
 * only the site code (for example SM-7030-1), while technicians refer to it as
 * "NAP SM-7030-1". Codes that already start with NAP are left unchanged.
 */
export function formatNapLabel(napName) {
  const code = String(napName || '').trim().toUpperCase();
  if (!code) return 'NAP no identificada';
  return /^NAP(?:[-_.\s]|$)/i.test(code) ? code : `NAP ${code}`;
}

const isDeviceSerialLike = (value) => {
  const text = String(value || '').trim();
  return /^(?=[A-Z0-9]{12,20}$)(?=[A-Z0-9]*\d)[A-Z]{4}[A-Z0-9]{8,16}$/i.test(text) ||
    /^(?=[A-F0-9]{16}$)(?=[A-F0-9]*\d)[A-F0-9]{16}$/i.test(text);
};

const getClientName = (client) => {
  const name = String(client?.name || client?.customer_name || client?.client_name || '').trim();
  return name && !isDeviceSerialLike(name) ? name : '';
};

const getAffectedClientNames = (clients = []) => [...new Set(
  clients.map(getClientName).filter(Boolean)
)];

function determineRequiredFailureType(onus = [], fallbackText = '') {
  const categories = onus.map((candidate) => getFailureCategoryFromOltReason(
    candidate?.offline_reason || candidate?.last_down_reason || candidate?.status_reason || candidate?.reason || candidate?.status || ''
  ));
  const powerCount = categories.filter((category) => category === 'power_fail').length;
  const lossCount = categories.filter((category) => category === 'loss').length;
  if (powerCount > lossCount) return 'Corte de energía';
  if (lossCount > 0) return 'Pérdida de señal';

  // A generic Zabbix "port/link down" event describes the state, not the
  // physical cause. Only explicit power/LOS words may be used as fallback.
  const fallbackCategory = getFailureCategoryFromOltReason(fallbackText);
  if (fallbackCategory === 'power_fail') return 'Corte de energía';
  if (fallbackCategory === 'loss') return 'Pérdida de señal';
  return null;
}

/**
 * A bare Smart OLT Offline state is not an incident type. These ONUs are
 * frequently permanently disconnected and must be excluded from automatic
 * Telegram reports, port correlation and NAP impact totals.
 */
function getExplicitSmartOltFailureCategory(onu = {}) {
  return getFailureCategoryFromOltReason(
    onu.offline_reason || onu.last_down_reason || onu.status_reason || onu.reason || onu.status || ''
  );
}

const isReportableSmartOltFailure = (onu) =>
  ['power_fail', 'loss'].includes(getExplicitSmartOltFailureCategory(onu));

const getOltIdentity = (onu = {}) => {
  const accountId = String(onu?.smartolt_account_id || onu?.smartOltAccountId || 'default').trim();
  const oltId = String(onu?.olt_id ?? onu?.oltId ?? '').trim();
  if (oltId) return `account:${accountId}:id:${oltId}`;
  return `account:${accountId}:name:${String(onu?.olt_name || onu?.oltName || '').trim().toUpperCase()}`;
};

const getNapIncidentKey = (napName, olt = {}) =>
  `${getOltIdentity(olt)}:${normalizeNapName(napName)}`;

const sameOlt = (left = {}, right = {}) => {
  const leftAccount = String(left?.smartolt_account_id || left?.smartOltAccountId || 'default').trim();
  const rightAccount = String(right?.smartolt_account_id || right?.smartOltAccountId || 'default').trim();
  if (leftAccount !== rightAccount) return false;
  const leftId = String(left?.olt_id ?? left?.oltId ?? '').trim();
  const rightId = String(right?.olt_id ?? right?.oltId ?? '').trim();
  // If either source has a real OLT id, only an identical real id is a
  // match. Falling back to the (often shared) display name would mix ONUs
  // from different OLTs into the same NAP incident.
  if (leftId || rightId) return Boolean(leftId && rightId && leftId === rightId);
  const leftName = String(left?.olt_name || left?.oltName || '').trim().toUpperCase();
  const rightName = String(right?.olt_name || right?.oltName || '').trim().toUpperCase();
  return Boolean(leftName && rightName && leftName === rightName);
};

function getNapOnusFromSnapshot(referenceOnu, onus = []) {
  const napKey = normalizeNapName(getNapNameFromOnu(referenceOnu));
  if (!napKey) return [];
  const referenceSn = String(referenceOnu?.sn || '').trim().toUpperCase();
  return onus
    .filter((candidate) => normalizeNapName(getNapNameFromOnu(candidate)) === napKey)
    .filter((candidate) => sameOlt(referenceOnu, candidate))
    .map((candidate) => String(candidate?.sn || '').trim().toUpperCase() === referenceSn
      ? { ...candidate, ...referenceOnu }
      : candidate
    );
}

function getCompleteNapIncident(snapshotOnus, referenceOnu, expectedCategory) {
  const napOnus = getNapOnusFromSnapshot(referenceOnu, snapshotOnus);
  const actionableOnus = napOnus.filter((candidate) =>
    isOnuOnline(candidate) || isReportableSmartOltFailure(candidate)
  );
  const categories = actionableOnus.map(getExplicitSmartOltFailureCategory);
  const complete = actionableOnus.length >= getMinimumNapClients() &&
    categories.length === actionableOnus.length &&
    categories.every((category) => category === expectedCategory);
  return { complete, napOnus, actionableOnus };
}

async function isTelegramEligibleOperationalAlert(onu, category) {
  if (!onu || !['power_fail', 'loss'].includes(category)) {
    return { eligible: false, reason: 'No corroborated Smart OLT incident' };
  }

  try {
    // This is the cached/coalesced bulk endpoint, never an individual ONU
    // query. It covers every OLT registered in Smart OLT in one snapshot.
    const snapshotOnus = await fetchMonitoringOnus({ forceRefresh: true });
    const incident = getCompleteNapIncident(snapshotOnus, onu, category);
    return incident.complete
      ? { eligible: true, reason: `Complete ${category} NAP incident`, ...incident }
      : { eligible: false, reason: 'NAP is not totally affected by one confirmed cause', ...incident };
  } catch (error) {
    return { eligible: false, reason: `Unable to verify total NAP scope: ${error.message}` };
  }
}

function hasExplicitZabbixFailureType(eventName = '', triggerDescription = '', category = '') {
  const text = `${eventName} ${triggerDescription}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (category === 'power_fail') {
    return /(power fail(?:ure)?|dying gasp|d-gasp|dgasp|sin energia|corte de luz|power down|alimentacion electrica)/.test(text);
  }
  if (category === 'loss') {
    return /(loss of signal|\blos\b|perdida de senal|sin senal|corte de fibra|fibra cortada)/.test(text);
  }
  return false;
}

function isSmartOltRateLimitError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return text.includes('rate_limit_exceeded') || text.includes('status 429');
}

async function fetchMonitoringOnusOnPort(board, port, oltName = '') {
  const allOnus = await fetchMonitoringOnus({ forceRefresh: true });
  const portOnus = allOnus.filter((onu) =>
    String(onu?.board) === String(board) && String(onu?.port) === String(port)
  );
  if (!oltName) return portOnus;

  const normalizedHost = String(oltName).toLowerCase();
  const matched = portOnus.filter((onu) => {
    const smartOltName = String(onu?.olt_name || '').toLowerCase();
    return smartOltName && (smartOltName === normalizedHost ||
      smartOltName.includes(normalizedHost) || normalizedHost.includes(smartOltName));
  });
  return matched.length > 0 ? matched : portOnus;
}

function formatMandatoryAlertData(failureType, clientNames, eventTime) {
  const names = [...new Set(clientNames.filter(Boolean))];
  const safeNames = names.length > 0
    ? names.map(escapeTelegramHtml).join(', ')
    : 'Clientes no identificados por Smart OLT';
  return `📋 <b>Datos obligatorios:</b>\n` +
    `• <b>Tipo de caída:</b> ${failureType}\n` +
    `• <b>Clientes afectados:</b> ${safeNames}\n` +
    `• <b>Fecha y hora:</b> <code>${eventTime || formatDateTime(new Date())}</code>`;
}

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

async function corroborateTotalNapIncidentWithSmartOlt(nap, referenceOnu) {
  const napName = String(nap?.name || '').trim();
  if (!napName || !referenceOnu) return { confirmed: false, reason: 'NAP or OLT not identified' };

  try {
    const returnedOnus = await fetchMonitoringOnus({ forceRefresh: true });
    const onus = getNapOnusFromSnapshot(referenceOnu, returnedOnus);
    const actionableOnus = onus.filter((onu) =>
      isOnuOnline(onu) || isReportableSmartOltFailure(onu)
    );
    const minimumClients = getMinimumNapClients();

    if (actionableOnus.length < minimumClients) {
      return { confirmed: false, reason: `Smart OLT returned only ${actionableOnus.length} actionable ONU(s) for ${napName}` };
    }
    if (actionableOnus.some(isOnuOnline)) {
      return { confirmed: false, reason: 'Smart OLT still reports online ONUs in the NAP' };
    }

    // Being 100% offline describes the impact, not the cause. If Smart OLT
    // reports Dying Gasp/Power Fail, this is an electrical incident affecting
    // the ONUs/routers and must never be announced as a fibre or NAP LOS.
    const causeCategories = actionableOnus.map(getExplicitSmartOltFailureCategory);
    let powerFailureCount = causeCategories.filter((category) => category === 'power_fail').length;
    let lossCount = causeCategories.filter((category) => category === 'loss').length;

    if (powerFailureCount > 0 && lossCount > 0) {
      return {
        confirmed: false,
        category: 'mixed',
        reason: `Smart OLT reports mixed causes (${powerFailureCount} power, ${lossCount} LOS)`
      };
    }
    if (powerFailureCount === actionableOnus.length) {
      return { confirmed: true, category: 'power_fail', onus, powerFailureCount };
    }
    if (lossCount === actionableOnus.length) {
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

// Locations are read-only in this service: Smart OLT is the sole GPS source.
router.post('/naps/coordinates/bulk', (req, res) => {
  return res.status(409).json({
    error: 'Manual/imported coordinates are disabled. NAP locations are synchronized from Smart OLT.'
  });
});

// Kept solely for old browser versions; it must not overwrite Smart OLT GPS.
router.post('/naps/coordinates', (req, res) => {
  return res.status(409).json({
    error: 'Manual coordinates are disabled. NAP locations are synchronized from Smart OLT.'
  });
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
    onu_sn: sn.toUpperCase(),
    source_system: 'smartolt_webhook'
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
    
    // This request already comes from Smart OLT, so it is authoritative and
    // must not depend on another API call that may be rate-limited. Enrich the
    // webhook event with local customer/NAP metadata and pass it as confirmed
    // Smart OLT data to the normal notification formatter.
    const normalizedSn = sn.toUpperCase();
    const cachedNap = findCachedNapBySn(normalizedSn);
    const cachedClient = cachedNap?.clients?.find((client) =>
      String(client.sn || '').trim().toUpperCase() === normalizedSn
    );
    if (!cachedClient) {
      console.log(`[Smart OLT Webhook] Event for ${normalizedSn} suppressed because the ONU/customer is not registered in the local Smart OLT cache.`);
      return res.status(202).json({ status: 'ignored', reason: 'Unknown ONU/customer' });
    }
    const webhookFailureCategory = classifySmartOltAlert(overrideReason, {
      status: eventStatus === 'PROBLEM' ? 'Offline' : 'Online'
    }).category;
    const webhookStatus = eventStatus === 'OK'
      ? 'Online'
      : webhookFailureCategory === 'power_fail'
        ? 'Power fail'
        : webhookFailureCategory === 'loss'
          ? 'LOS'
          : 'Offline';
    const webhookOnu = {
      ...(payload.onu || {}),
      sn: normalizedSn,
      name: payload.onu?.name || payload.customer_name || cachedClient?.name,
      status: webhookStatus,
      odb_name: payload.onu?.odb_name || payload.odb_name || cachedNap?.name,
      olt_name: payload.onu?.olt_name || payload.olt_name || cachedNap?.olt_name,
      board: payload.onu?.board ?? payload.board ?? cachedNap?.board,
      port: payload.onu?.port ?? payload.port ?? cachedNap?.port
    };

    const result = await processAndSendAlert(zabbixLikePayload, webhookOnu, overrideReason);
    
    // Update local map
    const updatedNap = updateOnuStatusInCache(normalizedSn, webhookStatus, {
      reason: overrideReason || 'Evento nativo de Smart OLT',
      category: webhookFailureCategory
    });
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

    const monitoringOnus = await fetchMonitoringOnus({ forceRefresh: true });
    const monitoringBySn = new Map(monitoringOnus.map((onu) => [
      String(onu?.sn || '').trim().toUpperCase(),
      onu
    ]));
    
    const reports = [];
    let synchronizedCount = 0;
    
    for (const trigger of activeTriggers) {
      const hostText = trigger.hosts ? trigger.hosts.map(h => `${h.name} ${h.host}`).join(' ') : '';
      const fullText = `${trigger.description} ${hostText}`;
      const sn = extractSerialNumber(fullText);

      const zabbixTime = formatDateTime(new Date(Number(trigger.lastchange) * 1000));

      if (!sn) {
        console.log(`[Sync] Generic Zabbix event suppressed because Smart OLT cannot identify affected clients: "${trigger.description}".`);
        continue;
      }
      
      try {
        console.log(`Syncing SN ${sn} found in active problem trigger: "${trigger.description}"`);
        const onu = monitoringBySn.get(String(sn).trim().toUpperCase()) || null;
        
        if (onu) {
          const rawStatus = onu.last_down_reason || onu.offline_reason || onu.status || '';
          const bulkClassification = classifySmartOltAlert(rawStatus, onu);
          const oltReason = bulkClassification.label;
          
          const isOltOnline = (onu.status || '').toLowerCase() === 'online' || (onu.status || '').toLowerCase() === 'active';
          const statusDot = isOltOnline ? '🟢' : '🔴';
          const oltDownTime = onu.last_status_change || onu.last_down_time || 'N/A';
          const failureCategory = bulkClassification.category;
          const clientName = getClientName(onu);

          if (isOltOnline || !['power_fail', 'loss'].includes(failureCategory) || !clientName) {
            console.log('[Sync] Event suppressed: Smart OLT did not confirm an energy/signal outage with an affected client name.');
            continue;
          }
          const eligibility = await isTelegramEligibleOperationalAlert(onu, failureCategory, rawStatus);
          if (!eligibility.eligible) {
            console.log(`[Sync] Event suppressed: ${eligibility.reason}.`);
            continue;
          }
          const failureType = failureCategory === 'power_fail' ? 'Corte de energía' : 'Pérdida de señal';
          
          const publicUrl = PUBLIC_URL;
          const sNapBox = extractNapBox(onu.address) || extractNapBox(onu.description) || 'N/A';
          const sNapLink = (sNapBox !== 'N/A' && publicUrl) ? `<a href="${publicUrl}/?nap=${encodeURIComponent(sNapBox)}">${sNapBox}</a>` : sNapBox;
          
          reports.push(
            `${formatMandatoryAlertData(failureType, [clientName], zabbixTime)}\n\n` +
            `• <b>Dirección/NAP:</b> ${onu.address || 'N/A'}\n` +
            `• <b>Caja NAP:</b> <b>${sNapLink}</b>\n` +
            `• <b>Estado Smart OLT:</b> ${statusDot} <b>${onu.status || 'Offline'}</b>\n` +
            `• <b>Causa OLT:</b> <code>${oltReason}</code>\n` +
            `• <b>Hora del corte Smart OLT:</b> <code>${oltDownTime}</code>`
          );
          
          const cacheStatus = isOltOnline
            ? 'Online'
            : failureCategory === 'power_fail'
              ? 'Power fail'
              : failureCategory === 'loss'
                ? 'LOS'
                : 'Offline';
          const updatedNap = updateOnuStatusInCache(sn, cacheStatus, {
            reason: oltReason,
            category: failureCategory
          });
          if (updatedNap) {
            broadcast('nap_status_update', updatedNap);
          }
          
          synchronizedCount++;
        } else {
          console.log('[Sync] Zabbix event suppressed because its ONU was not found in Smart OLT.');
        }
      } catch (err) {
        console.error(`Failed to synchronize SN ${sn}:`, err.message);
      }
    }

    if (reports.length === 0) {
      const emptyDetailedMsg = `✅ <b>Sincronización completada</b>\n\nNo existen caídas de energía o señal con clientes identificados y corroboradas por Smart OLT.`;
      await sendMessage(targetChatId, emptyDetailedMsg);
      return { total: activeTriggers.length, synchronized: 0, sent: true };
    }
    
    const summaryText = `🔄 <b>REPORTE DE INCIDENTES SINCRONIZADO</b> 🔄\n\n${reports.join('\n\n')}\n\n📊 <b>Resumen:</b>\n• Total alertas activas Zabbix: <b>${activeTriggers.length}</b>\n• Corroboradas con Smart OLT: <b>${synchronizedCount}</b>`;
    
    await sendNotification(targetChatId, summaryText.trim());
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
 * Send a single NAP-level LOS report after the Smart OLT snapshot confirmed
 * the complete impact and Zabbix supplied fresh evidence for every ONU.
 */
async function sendCachedNapLossAlert(payload, nap, eventTime = '') {
  const referenceClient = nap.clients?.find((client) => client.sn);
  if (!referenceClient) return { sent: false, reason: 'NAP has no clients' };

  const totalClients = nap.totalClients || nap.clients.length;
  // This path runs only after Smart OLT corroborated a NAP-wide LOS event.
  // Store the confirmed type, not a generic Offline state, so the detailed
  // report lists only the actual LOS clients.
  nap.clients.forEach((client) => {
    updateOnuStatusInCache(client.sn, 'LOS', {
      smartolt_account_id: client.smartolt_account_id || nap.smartolt_account_id || '',
      reason: 'Pérdida de Señal (LOS)',
      category: 'loss',
      eventTime,
      forceRecord: true
    });
  });
  const representativeOnu = {
    sn: String(referenceClient.sn).toUpperCase(),
    name: referenceClient.name || nap.name,
    status: 'LOS',
    odb_name: nap.name,
    smartolt_account_id: referenceClient.smartolt_account_id || nap.smartolt_account_id || '',
    smartolt_subdomain: referenceClient.smartolt_subdomain || nap.smartolt_subdomain || '',
    olt_id: nap.olt_id,
    olt_name: nap.olt_name,
    board: nap.board,
    port: nap.port
  };
  const enrichedPayload = {
    ...payload,
    onu_sn: representativeOnu.sn,
    chat_id: getLossChatId(),  // Route LOS alerts to the dedicated LOS group
    zabbix_event_name: payload.zabbix_event_name || payload.event_name || payload.trigger_name || '',
    zabbix_trigger_description: payload.zabbix_trigger_description || payload.trigger_description || '',
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
  // This path has already been confirmed by Smart OLT as an electrical
  // incident for the NAP. Preserve Power fail rather than generic Offline.
  nap.clients.forEach((client) => {
    updateOnuStatusInCache(client.sn, 'Power fail', {
      smartolt_account_id: client.smartolt_account_id || nap.smartolt_account_id || '',
      reason: 'Corte de Energía (Dying Gasp)',
      category: 'power_fail',
      eventTime,
      forceRecord: true
    });
  });
  const representativeOnu = {
    ...(confirmation.onus?.[0] || {}),
    sn: String(referenceClient.sn).toUpperCase(),
    name: referenceClient.name || nap.name,
    status: 'Power fail',
    odb_name: nap.name,
    smartolt_account_id: referenceClient.smartolt_account_id || nap.smartolt_account_id || '',
    smartolt_subdomain: referenceClient.smartolt_subdomain || nap.smartolt_subdomain || '',
    olt_id: nap.olt_id,
    olt_name: nap.olt_name,
    board: nap.board,
    port: nap.port
  };
  const enrichedPayload = {
    ...payload,
    onu_sn: representativeOnu.sn,
    chat_id: payload.chat_id || DEFAULT_CHAT_ID,
    zabbix_event_name: payload.zabbix_event_name || payload.event_name || payload.trigger_name || '',
    zabbix_trigger_description: payload.zabbix_trigger_description || payload.trigger_description || '',
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

/**
 * Decide a NAP-wide incident only after Smart OLT has been queried. Zabbix
 * evidence is required for every ONU, but it never changes the live Smart OLT
 * snapshot or decides whether the cause is optical or electrical.
 */
async function trySendSmartOltFirstNapIncident(payload, nap, referenceOnu, eventTime = '') {
  if (!nap || !referenceOnu) {
    return false;
  }

  const confirmation = await corroborateTotalNapIncidentWithSmartOlt(nap, referenceOnu);
  if (!confirmation.confirmed) {
    console.log(`[NAP Correlation] ${nap.name}: Smart OLT did not confirm a total incident (${confirmation.reason}).`);
    return false;
  }

  // Replace stale/local states with the coherent Smart OLT snapshot
  // before calculating totals or rendering the Telegram notification.
  const changedNaps = applyOnuStatusSnapshot(confirmation.onus || []);
  changedNaps.forEach((changedNap) => broadcast('nap_status_update', changedNap));
  const confirmedNap = findCachedNap(nap.name, referenceOnu) || nap;
  const notificationKey = napNotificationKey(confirmedNap.name, referenceOnu);

  if (hasActiveNapIncidentNotification(confirmedNap.name, referenceOnu) ||
      pendingNapIncidentNotifications.has(notificationKey)) {
    return true;
  }

  pendingNapIncidentNotifications.add(notificationKey);
  cancelPendingAlertsForNap(confirmedNap);
  try {
    const result = confirmation.category === 'power_fail'
      ? await sendCachedNapPowerFailAlert(payload, confirmedNap, confirmation, eventTime)
      : await sendCachedNapLossAlert(payload, confirmedNap, eventTime);
    return result?.sent !== false;
  } finally {
    pendingNapIncidentNotifications.delete(notificationKey);
  }
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
  const areaClientNames = getAffectedClientNames(
    entries.flatMap((entry) => entry.nap.clients || [])
  );
  if (areaClientNames.length === 0) {
    console.log('[Area Outage] Report suppressed because Smart OLT did not provide affected client names.');
    return;
  }
  const mandatoryAreaData = formatMandatoryAlertData('Pérdida de señal', areaClientNames, now);
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

${mandatoryAreaData}

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

${mandatoryAreaData}

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

${mandatoryAreaData}

Se detectaron ${entries.length} caídas de NAP sin relación geográfica ni de red en los últimos ${Math.round(getAreaOutageWindowMs() / 60000)} min:

${napListLines}

📊 <b>Distancia máxima entre NAPs:</b> ${maxDistKm.toFixed(1)} km (umbral: ${radiusKm} km)
📅 <b>Hora de detección:</b> <code>${now}</code>
<i>Cada caída fue notificada individualmente.</i>
`.trim();
  }

  console.log(`[Area Outage] Sending ${areaType} area report for ${entries.length} NAPs.`);
  await sendNotification(chatId, message);
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
  const onusOnPort = await fetchMonitoringOnusOnPort(onu.board, onu.port, hostName);
  // Exclude bare Offline clients. Only an explicit Smart OLT Power fail or
  // LOS is actionable and may appear in an operational report.
  const reportableOnus = onusOnPort.filter(isReportableSmartOltFailure);
  const localScope = selectNearbyNapOnusForAnalysis(reportableOnus, getNapNameFromOnu(onu));
  const locallyReportableOnus = localScope.onus.filter(isReportableSmartOltFailure);
  console.log(`[Port correlation] Bulk status scope: ${formatNapLabel(localScope.focusNapName)} + ${localScope.nearbyNapCount} NAP(s) within ${localScope.radiusKm} km.`);
  const failureType = determineRequiredFailureType(locallyReportableOnus, oltStatusReason) ||
    determineRequiredFailureType(reportableOnus, oltStatusReason);
  if (!failureType) {
    console.log(`[Port correlation] Suppressed ${hostName} board ${onu.board}/port ${onu.port}: Smart OLT did not report Power Fail or LOS.`);
    return { sent: false, reason: 'Smart OLT failure cause unavailable' };
  }
  const expectedCategory = failureType === 'Corte de energía' ? 'power_fail' : 'loss';
  const offlineOnus = reportableOnus.filter((candidate) =>
    getExplicitSmartOltFailureCategory(candidate) === expectedCategory
  );
  const totalClients = onusOnPort.filter((candidate) =>
    isOnline(candidate) || getExplicitSmartOltFailureCategory(candidate) === expectedCategory
  ).length;
  const offlineCount = offlineOnus.length;
  const percentage = totalClients ? ((offlineCount / totalClients) * 100).toFixed(1) : 'N/A';
  const minOffline = getPositiveNumber(process.env.PORT_OUTAGE_MIN_OFFLINE, 3);
  const minPercentage = getPositiveNumber(process.env.PORT_OUTAGE_MIN_PERCENT, 30);
  const isPortOutage = offlineCount >= minOffline && Number(percentage) >= minPercentage;
  const zabbixEventCount = [...sns].filter(Boolean).length;
  const affectedClientNames = getAffectedClientNames(offlineOnus);
  const eventTime = extractEventTime(payload);
  const representativeCause = offlineOnus
    .map((candidate) => candidate.offline_reason || candidate.last_down_reason || '')
    .find((reason) => getFailureCategoryFromOltReason(reason) === expectedCategory) || oltStatusReason;
  const portSourceComparison = compareSmartOltWithZabbix(
    classifySmartOltAlert(representativeCause, onu),
    parseStatusInfo(`${payload.event_name || payload.trigger_name || ''} ${payload.trigger_description || ''}`),
    payload.event_status || payload.status || 'PROBLEM',
    { ...onu, status: offlineCount > 0 ? 'Offline' : 'Online' }
  );
  if (!portSourceComparison.confirmed) {
    console.log(`[Port correlation] Suppressed ${hostName} board ${onu.board}/port ${onu.port}: Smart OLT reports no offline ONUs.`);
    return { sent: false, reason: portSourceComparison.verdict };
  }
  if (affectedClientNames.length === 0) {
    console.log(`[Port correlation] Suppressed ${hostName} board ${onu.board}/port ${onu.port}: Smart OLT did not provide affected client names.`);
    return { sent: false, reason: 'Affected client names unavailable' };
  }
  const offlineDetail = offlineOnus.slice(0, 20)
    .map(candidate => `• 🔴 ${getClientName(candidate) || 'Cliente no identificado'}`)
    .join('\n') || '• Smart OLT aún no reporta ONUs Offline.';
  const title = failureType === 'Corte de energía'
    ? '🔌⚡ <b>CORTE DE ENERGÍA EN CLIENTES DEL PUERTO OLT</b>'
    : isPortOutage
      ? '🚨🔴 <b>CAÍDA DE SEÑAL EN PUERTO OLT CORROBORADA</b>'
      : '⚠️ <b>PÉRDIDA PARCIAL DE SEÑAL EN PUERTO OLT</b>';

  const report = `${title}\n\n` +
    `${formatMandatoryAlertData(failureType, affectedClientNames, eventTime)}\n\n` +
    `<b>OLT:</b> ${hostName}\n` +
    `<b>Puerto afectado:</b> Tarjeta ${onu.board} | PON ${onu.port}\n` +
    `\n🔎 <b>Comparación Smart OLT ↔ Zabbix:</b>\n` +
    `<b>1. Smart OLT (principal):</b> ${offlineCount}/${totalClients} ONUs Offline (${percentage}%)\n` +
    (representativeCause ? `<b>Causa confirmada OLT:</b> ${representativeCause}\n` : '') +
    `<b>2. Zabbix (confirmación):</b> ${zabbixEventCount} evento(s)\n` +
    `<b>Resultado:</b> ${portSourceComparison.verdict}\n` +
    `📅 <b>Hora del evento:</b> <code>${eventTime}</code>\n\n` +
    `<b>Detalle Smart OLT:</b>\n${offlineDetail}` +
    (offlineCount > 20 ? `\n<i>…y ${offlineCount - 20} ONUs más.</i>` : '') +
    `\n\n<i>Correlación Zabbix + Smart OLT completada en ${getPortCorrelationMs() / 1000}s.</i>`;

  await sendNotification(targetChatId, report);
  console.log(`[Port correlation] Sent report for ${hostName}, board ${onu.board}, port ${onu.port}. Offline: ${offlineCount}/${totalClients}.`);
  return { sent: true, offlineCount, totalClients };
}

/**
 * Helper to generate a detailed NAP connectivity report.
 * If no NAP box is found in the ONU details, falls back to a clean individual customer report.
 */
/**
 * Helper to generate a detailed NAP connectivity report.
 * If no NAP box is found in the ONU details, falls back to a clean individual customer report.
 */
async function generateNapReport(onu, eventStatus, severity, hostName, eventName, statusEmoji, statusLabel, priorityTitle, oltStatusReason = '', eventTime = '', sourceComparison = null) {
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
    cachedNap = findCachedNap(napBox, onu);
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

  const napLabel = formatNapLabel(napBox);
  const napDisplay = napBox ? `<code>${napLabel}</code>` : '<i>NAP no identificada en Smart OLT</i>';
  const napLink = (napBox && publicUrl) ? `<a href="${publicUrl}/?nap=${encodeURIComponent(napBox)}"><b>${napLabel}</b></a>` : napDisplay;
  const onuName = getClientName(onu) || 'Cliente no identificado';
  const onuIdentityLine = `👤 <b>ONU/cliente reportado:</b> ${escapeTelegramHtml(onuName)}`;
  const comparisonText = formatSourceComparison(sourceComparison, eventStatus, onu, oltStatusReason);

  // Build technical diagnostic explanation based on failure type
  let techExplanation = '';
  const reasonLower = (oltStatusReason || '').toLowerCase();
  const isLoss = reasonLower.includes('los') || reasonLower.includes('signal') || reasonLower.includes('fibra') || parseStatusInfo(eventName).category === 'loss';
  const isPower = reasonLower.includes('power') || reasonLower.includes('dying') || reasonLower.includes('gasp') || parseStatusInfo(eventName).category === 'power_fail';
  const failureType = isPower ? 'Corte de energía' : 'Pérdida de señal';

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
        const monitoringOnus = await fetchMonitoringOnus();
        onusOnNap = monitoringOnus.filter((candidate) =>
          normalizeNapName(getNapNameFromOnu(candidate)) === normalizeNapName(napBox)
        );
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

    const boxLabel = napBox ? napLink + coordsText : '<i>NAP no identificada en Smart OLT</i>';
    const singleIsPower = eventStatus !== 'OK' && /energ|power|dying|gasp/i.test(`${singleLabel} ${singleReason}`);
    const singlePowerNapLine = singleIsPower && napBox
      ? `\n🔌 <b>Corte de energía en equipo conectado a:</b> <b>${napLabel}</b>`
      : '';

    return `
${singleTitle}

${formatMandatoryAlertData(failureType, [onuName], eventTime)}

📦 <b>Caja afectada:</b> ${boxLabel}
${onuIdentityLine}${singlePowerNapLine}
🏢 <b>OLT:</b> ${onu.olt_name || hostName} | <b>Puerto PON:</b> Slot ${onu.board || 'N/A'} / Puerto ${onu.port || 'N/A'}

⚡ <b>Detalle del Incidente:</b>
• <b>Estado:</b> ${singleEmoji} <b>${singleLabel}</b> (${severity})
${eventTime ? `• 📅 <b>Hora del Evento:</b> <code>${eventTime}</code>\n` : ''}${singleReason ? `• 🔌 <b>Causa Reportada OLT:</b> <code>${singleReason}</code>\n` : ''}${singleTechExplanation}

${comparisonText || ''}
`.trim();
  }

  // Calculate the NAP impact only from the same explicit Smart OLT cause as
  // this alert. A plain Offline status is permanently disconnected inventory
  // and is excluded from the totals and customer list.
  const incidentCategory = isPower ? 'power_fail' : 'loss';
  const onusInAlertScope = onusOnNap.filter((candidate) =>
    isOnline(candidate) || getExplicitSmartOltFailureCategory(candidate) === incidentCategory
  );
  // Native Smart OLT webhooks and a Zabbix event can arrive milliseconds
  // before the cache reflects their explicit cause. Never lose the confirmed
  // triggering ONU merely because an older cache entry still says Offline.
  const triggerSn = String(onu?.sn || '').trim().toUpperCase();
  if (triggerSn && !onusInAlertScope.some((candidate) =>
    String(candidate?.sn || '').trim().toUpperCase() === triggerSn
  )) {
    onusInAlertScope.push({
      ...onu,
      status: incidentCategory === 'power_fail' ? 'Power fail' : 'LOS'
    });
  }
  const totalClients = onusInAlertScope.length;
  const offlineOnus = onusInAlertScope.filter((candidate) =>
    getExplicitSmartOltFailureCategory(candidate) === incidentCategory
  );

  const totalOffline = offlineOnus.length;
  const totalOnline = onusInAlertScope.filter(isOnline).length;
  const percentageDown = ((totalOffline / totalClients) * 100).toFixed(1);
  const affectedClientNames = getAffectedClientNames(offlineOnus);
  if (affectedClientNames.length === 0 && onuName !== 'Cliente no identificado') {
    affectedClientNames.push(onuName);
  }

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

  const powerNapDetail = eventStatus !== 'OK' && isPower
    ? `\n🔌 <b>Corte de energía en equipos conectados a:</b> <b>${napLabel}</b>\n🎯 <b>Alcance eléctrico:</b> <b>${totalOffline} de ${totalClients}</b> ONU/router sin alimentación`
    : '';

  let lastActiveNapInfo = '';
  if (eventStatus !== 'OK' && isNapTotalLoss) {
    try {
      const onusOnPort = await fetchMonitoringOnusOnPort(onu.board, onu.port, onu.olt_name || hostName);
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

${formatMandatoryAlertData(failureType, affectedClientNames, eventTime)}

📦 <b>Caja afectada:</b> ${napLink}${coordsText}
${onuIdentityLine}${powerNapDetail}
🏢 <b>OLT:</b> ${onu.olt_name || hostName} | <b>Puerto PON:</b> Slot ${onu.board || 'N/A'} / Puerto ${onu.port || 'N/A'}

⚡ <b>Detalle del Incidente:</b>
• <b>Estado:</b> ${effectiveEmoji} <b>${effectiveStatusLabel}</b> (${severity})
${eventTime ? `• 📅 <b>Hora del Evento:</b> <code>${eventTime}</code>\n` : ''}${effectiveReason ? `• 🔌 <b>Causa Reportada OLT:</b> <code>${effectiveReason}</code>\n` : ''}${effectiveTechExplanation}

📊 <b>Estado de la caja ${napLabel}:</b>
• Total Conexiones: <b>${totalClients}</b>
• 🟢 Operativas (Online): <b>${totalOnline}</b>
• 🔴 Afectadas (Offline): <b>${totalOffline}</b> (<b>${percentageDown}%</b>)
• <b>Diagnóstico:</b> ${napWarning}${lastActiveNapInfo}

${comparisonText || ''}
`.trim();
}

/**
 * Helper to process and send a Zabbix alert to Telegram (reusable for immediate & delayed alerts).
 */
export async function processAndSendAlert(payload, prefetchedOnu = null, prefetchedOltStatusReason = '', options = {}) {
  const eventName = payload.event_name || payload.trigger_name || '';
  const triggerDesc = payload.trigger_description || '';
  const zabbixEventName = payload.zabbix_event_name || eventName;
  const zabbixTriggerDesc = payload.zabbix_trigger_description || triggerDesc;
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
  let smartOltRateLimited = false;
  let smartOltAlert = prefetchedOltStatusReason
    ? classifySmartOltAlert(prefetchedOltStatusReason, onu)
    : null;

  if (sn) {
    try {
      if (!onu) {
        console.log(`Extracted SN: ${sn}. Reading the cached Smart OLT status feed...`);
        const monitoringOnus = await fetchMonitoringOnus({ forceRefresh: eventStatus === 'PROBLEM' });
        onu = monitoringOnus.find((candidate) =>
          String(candidate?.sn || '').trim().toUpperCase() === String(sn).trim().toUpperCase()
        ) || null;
      }
      
      if (onu) {
        // The bulk feed reports the Smart OLT classification directly (LOS or
        // Power fail). Do not use get_onu_status here: Smart OLT reserves it
        // for a technician's interactive diagnosis, not automated alerts.
        if (!oltStatusReason) {
          const rawReason = onu.last_down_reason || onu.offline_reason ||
            onu.status_reason || onu.reason || onu.status || '';
          smartOltAlert = classifySmartOltAlert(rawReason, onu);
          oltStatusReason = smartOltAlert.rawReason || String(onu.status || '');
          console.log(`Smart OLT bulk type for ${sn}: "${smartOltAlert.label}"${oltStatusReason ? ` (${oltStatusReason})` : ''}`);
        }
        smartOltEnriched = true;
      }
    } catch (smartOltError) {
      smartOltRateLimited = isSmartOltRateLimitError(smartOltError);
      console.error(`[Smart OLT error ignored to maintain independence]:`, smartOltError.message);
    }
  }

  // Fallback: Resolve ONU and NAP from local disk cache if Smart OLT API didn't return an ONU
  if (!onu && sn) {
    const cleanSn = sn.toUpperCase();
    onu = findCachedOnuBySn(cleanSn);
    if (onu) {
      console.log(`[Cache Metadata Fallback] Resolved SN ${cleanSn} to NAP ${onu.odb_name}; this is not treated as live Smart OLT corroboration.`);
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
        console.log(`[Cache Metadata Fallback] Resolved direct NAP name "${napFromEvent}"; this is not treated as live Smart OLT corroboration.`);
      }
    }
  }

  // Parse alert category & status info
  const statusInfo = parseStatusInfo(zabbixEventName + ' ' + zabbixTriggerDesc);

  // The live OLT reason is authoritative whenever it is available. Zabbix
  // contributes the event timing and internal correlation key, but never overwrites the
  // diagnosed cause reported by Smart OLT.
  if (!smartOltAlert && oltStatusReason) {
    smartOltAlert = classifySmartOltAlert(oltStatusReason, onu);
  }
  let category = smartOltAlert && smartOltAlert.category !== 'unknown'
    ? smartOltAlert.category
    : statusInfo.category;
  const alertLabel = eventStatus === 'OK'
    ? 'Servicio restablecido'
    : smartOltAlert?.label || statusInfo.status || 'Alerta de red';
  const alertEmoji = eventStatus === 'OK'
    ? '🟢'
    : smartOltAlert?.emoji || (category === 'power_fail' ? '🔌' : '⚠️');
  const sourceComparison = smartOltEnriched && onu
    ? payload.source_system === 'smartolt_radar'
      ? {
          confirmed: !isOnuOnline(onu),
          radarOnly: true,
          smartCategory: category,
          smartLabel: smartOltAlert?.label || statusInfo.status || 'ONU Offline'
        }
      : compareSmartOltWithZabbix(smartOltAlert, statusInfo, eventStatus, onu)
    : null;

  if (eventStatus === 'OK' && sn) {
    clearActiveOperationalNotification(sn, getNapNameFromOnu(onu), onu);
  }

  if (eventStatus === 'PROBLEM' && !['power_fail', 'loss'].includes(category)) {
    console.log(`[Notification Filter] Suppressing category "${category}": alerts must be classified as power failure or signal loss.`);
    return { sn, enriched: smartOltEnriched, sent: false, reason: 'Unsupported failure type' };
  }

  if (eventStatus === 'PROBLEM' && payload.source_system === 'smartolt_radar' &&
      hasActiveOperationalNotification(sn, category, onu)) {
    console.log(`[Radar fallback] Suppressed duplicate ${category} alert for ${sn}; it was already delivered.`);
    return { sn, enriched: smartOltEnriched, sent: false, reason: 'Incident already notified' };
  }

  if (eventStatus === 'PROBLEM' && onu && !getClientName(onu)) {
    const napWithNamedClient = findCachedNap(getNapNameFromOnu(onu), onu);
    if (!getAffectedClientNames(napWithNamedClient?.clients || []).length) {
      console.log('[Notification Filter] Suppressing alert because Smart OLT did not provide affected client names.');
      return { sn, enriched: smartOltEnriched, sent: false, reason: 'Affected client names unavailable' };
    }
  }

  // Smart OLT is the only source allowed to change the operational map state.
  // Zabbix data is retained as event evidence but does not mark an ONU up/down.
  if (smartOltEnriched && onu && sn) {
    // Preserve the explicit Smart OLT state (Power fail / LOS) in the local
    // cache. Collapsing it to generic Offline made permanently disconnected
    // equipment indistinguishable from a reportable electrical/fibre event.
    const smartStatus = isOnuOnline(onu)
      ? 'Online'
      : category === 'power_fail'
        ? 'Power fail'
        : category === 'loss'
          ? 'LOS'
          : String(onu.status || 'Offline');
    const smartUpdatedNap = updateOnuStatusInCache(sn, smartStatus, {
      reason: smartOltAlert?.label || oltStatusReason || 'Estado consultado en Smart OLT',
      category,
      eventTime: extractEventTime(payload)
    });
    if (smartUpdatedNap) broadcast('nap_status_update', smartUpdatedNap);
    if (smartStatus === 'Online') {
      clearActiveOperationalNotification(sn, smartUpdatedNap?.name || getNapNameFromOnu(onu), onu);
    }
  }

  if (sn && eventStatus === 'PROBLEM' && smartOltEnriched && sourceComparison?.confirmed) {
    updateHistoryEventDetails(sn, category, smartOltAlert?.label || oltStatusReason || statusInfo.status);
  }

  // Corroboration verification
  if (eventStatus === 'PROBLEM') {
    // Route Loss of Signal alerts to the dedicated LOS chat group
    if (category === 'loss') {
      targetChatId = getLossChatId();
    }
    if ((!smartOltEnriched || !onu) && (category === 'power_fail' || category === 'loss')) {
      const canUseRateLimitFallback = smartOltRateLimited && onu && getClientName(onu) &&
        hasExplicitZabbixFailureType(zabbixEventName, zabbixTriggerDesc, category);
      if (REQUIRE_SMARTOLT_CORROBORATION && !canUseRateLimitFallback) {
        console.log(`[Corroboration Blocked] Event category "${category}" for SN "${sn}" was not enriched with Smart OLT. Skipping Telegram notification.`);
        return { sn, enriched: false, sent: false, reason: 'Not enriched' };
      }
      console.warn(
        canUseRateLimitFallback
          ? `[Smart OLT rate limit] Sending explicit Zabbix ${category} alert for SN "${sn}" with cached customer metadata.`
          : `[Smart OLT fallback] Sending ${category} alert for SN "${sn}" using Zabbix data only.`
      );
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

    // Telegram is intentionally reserved for a complete NAP outage of one
    // type. Partial Power fail/LOS and any generic Offline state remain
    // visible in monitoring but are never sent as an operational alert.
    if (!smartOltEnriched || !onu) {
      console.log(`[Notification Filter] Suppressing ${category}: Smart OLT did not provide a verifiable NAP scope.`);
      return { sn, enriched: false, sent: false, reason: 'Smart OLT scope unavailable' };
    }
    const eligibility = await isTelegramEligibleOperationalAlert(onu, category);
    if (!eligibility.eligible) {
      console.log(`[Notification Filter] Suppressing ${category} for ${sn}: ${eligibility.reason}.`);
      return { sn, enriched: true, sent: false, reason: eligibility.reason };
    }

    // The same outage may be reported by Zabbix several times. Telegram gets
    // the first verified event, then only the six-hour scanner reminder while
    // the service remains down.
    const napName = getNapNameFromOnu(onu);
    if (hasActiveOperationalNotification(sn, category, onu) ||
        (napName && hasActiveNapIncidentNotification(napName, onu))) {
      console.log(`[Notification Filter] Suppressing duplicate ${category} alert for ${sn}; it was delivered less than six hours ago.`);
      return { sn, enriched: true, sent: false, reason: 'Incident already notified within six-hour window' };
    }
  }

  // ── Apply notification rules ──────────────────────────────────────────────
  if (eventStatus === 'OK') {
    // Suppress Telegram notifications for recovery (stable green NAP)
    console.log(`[Notification Filter] Suppressing Telegram recovery alert for SN "${sn}" as green connections are not notified.`);
    options.suppressSend = true;
  } else if (onu) {
    const napBox = (onu.odb_name ? onu.odb_name.trim() : '') || (onu.odb ? onu.odb.trim() : '') || extractNapBox(onu.address) || extractNapBox(onu.description);
    if (napBox) {
      const cachedNap = findCachedNap(napBox, onu);
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
          // A Smart OLT-confirmed partial outage still needs a notification:
          // the live OLT type is valuable even when the NAP is not fully down.
          console.log(`[Notification] Partial outage on NAP "${cachedNap.name}". Sending Smart OLT type "${alertLabel}".`);
        }
      }
    }
  }

  const eventTime = extractEventTime(payload);

  const statusEmoji = alertEmoji;
  const statusLabel = alertLabel;

  // Set visual priority title based on category & status & custom risk levels
  let priorityTitle = '';
  if (eventStatus === 'OK') {
    priorityTitle = `🟢 <b>SERVICIO RESTABLECIDO</b>`;
  } else if (onu) {
    const napBox = (onu.odb_name ? onu.odb_name.trim() : '') || (onu.odb ? onu.odb.trim() : '') || extractNapBox(onu.address) || extractNapBox(onu.description);
    if (napBox) {
      const cachedNap = findCachedNap(napBox, onu);
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
      priorityTitle = `🚨🔴 <b>RIESGO ALTO: ${alertLabel.toUpperCase()}</b>`;
    } else if (category === 'power_fail') {
      priorityTitle = `🔌⚡ <b>RIESGO MEDIO: ${alertLabel.toUpperCase()}</b>`;
    } else {
      priorityTitle = `${statusEmoji} <b>ALERTA SMART OLT: ${alertLabel.toUpperCase()}</b>`;
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
      zabbixEventName,
      statusEmoji,
      statusLabel,
      priorityTitle,
      oltStatusReason,
      eventTime,
      sourceComparison
    );
  }

  if (!smartOltEnriched) {
    // Standalone Zabbix Alert (Fallback / Decoupled mode)
    const reasonPart = oltStatusReason ? `\n• <b>Causa OLT:</b> <code>${oltStatusReason}</code>` : '';
    const fallbackNames = getAffectedClientNames(onu ? [onu] : []);
    if (fallbackNames.length === 0) {
      console.log('[Notification Filter] Standalone alert suppressed because no affected client names are available.');
      return { sn, enriched: false, sent: false, reason: 'Affected client names unavailable' };
    }
    const sourceNote = smartOltRateLimited
      ? '⚠️ <i>Smart OLT alcanzó temporalmente su límite de consultas; tipo recibido explícitamente desde Zabbix y datos de cliente recuperados de la caché.</i>'
      : '⚠️ <i>Nota: Alerta enviada sin enriquecimiento de Smart OLT (Modo Independiente).</i>';
    enrichedText = `
${priorityTitle}

${formatMandatoryAlertData(category === 'power_fail' ? 'Corte de energía' : 'Pérdida de señal', fallbackNames, eventTime)}

<b>Estado:</b> ${statusLabel}
<b>Severidad:</b> ${severity}
<b>Host/Equipo:</b> ${hostName}${reasonPart}

📝 <b>Detalle del Evento (Zabbix):</b>
${eventName}
${triggerDesc ? `\n<i>Descripción: ${triggerDesc}</i>` : ''}

${sourceNote}
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
      
      const coordinates = (napBox ? getCoordinates(findCachedNap(napBox, onu)) : null) || getCoordinates(onu);
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
    await sendNotification(targetChatId, enrichedText.trim(), sendOptions);
    if (eventStatus === 'PROBLEM') {
      markActiveOperationalNotification(sn, category, onu);
    }
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
  const zabbixStatusInfo = parseStatusInfo(eventName + ' ' + triggerDesc);

  const sn = payload.onu_sn || payload.sn ||
             extractSerialNumber(eventName) ||
             extractSerialNumber(triggerDesc);

  // ── Register Zabbix evidence without changing the Smart OLT state ─────────
  // The map/cache must never be changed optimistically from a Zabbix trigger.
  // Resolve only the NAP identity here so the event can be correlated later;
  // live status, scope and cause are obtained from Smart OLT first.
  if (sn) {
    const cachedNap = findCachedNapBySn(sn);

    if (zabbixStatusInfo.category === 'loss') {
      if (eventStatus === 'PROBLEM') {
        registerNapLossEvidence(cachedNap, sn);
      } else {
        clearNapLossEvidence(cachedNap, sn);
      }
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
    console.log(`[Settle] SN ${cleanSn}: settle window elapsed. Refreshing Smart OLT bulk status...`);

    // ── Re-query Smart OLT with FRESH data after the settle window ───────────
    let freshOnu            = null;
    let freshOltStatusReason = '';

    try {
      const monitoringOnus = await fetchMonitoringOnus({ forceRefresh: true });
      freshOnu = monitoringOnus.find((candidate) =>
        String(candidate?.sn || '').trim().toUpperCase() === cleanSn
      ) || null;
      if (freshOnu) {
        freshOltStatusReason = freshOnu.last_down_reason || freshOnu.offline_reason ||
          freshOnu.status_reason || freshOnu.reason || freshOnu.status || '';
        const bulkAlert = classifySmartOltAlert(freshOltStatusReason, freshOnu);
        console.log(`[Settle] SN ${cleanSn}: Smart OLT bulk type = "${bulkAlert.label}"${freshOltStatusReason ? ` (${freshOltStatusReason})` : ''}`);
      }
    } catch (err) {
      console.error(`[Settle] SN ${cleanSn}: Smart OLT query failed after settle — ${err.message}`);
    }

    // ── Smart OLT first: persist its live state, then compare with Zabbix ────
    try {
      let smartNap = null;
      if (freshOnu) {
        const freshCategory = classifySmartOltAlert(freshOltStatusReason, freshOnu).category;
        const smartStatus = isOnuOnline(freshOnu)
          ? 'Online'
          : freshCategory === 'power_fail'
            ? 'Power fail'
            : freshCategory === 'loss'
              ? 'LOS'
              : 'Offline';
        smartNap = updateOnuStatusInCache(cleanSn, smartStatus, {
          smartolt_account_id: freshOnu.smartolt_account_id,
          reason: freshOltStatusReason || 'Estado consultado en Smart OLT',
          category: freshCategory,
          eventTime: extractEventTime(payload)
        });
        if (smartNap) broadcast('nap_status_update', smartNap);
        smartNap = smartNap || findCachedNap(getNapNameFromOnu(freshOnu), freshOnu);
      } else {
        smartNap = findCachedNapBySn(cleanSn);
      }

      // A NAP-wide alert is emitted only when Smart OLT confirms the complete
      // scope and cause after Zabbix supplied fresh evidence for every ONU.
      if (freshOnu && !isOnuOnline(freshOnu)) {
        const napIncidentSent = await trySendSmartOltFirstNapIncident(
          payload,
          smartNap,
          freshOnu,
          extractEventTime(payload)
        );
        if (napIncidentSent) {
          console.log(`[Correlation] ${smartNap?.name || cleanSn}: consolidated incident sent after Smart OLT-first analysis.`);
          return;
        }
      }

      const result = await processAndSendAlert(
        payload,
        freshOnu,
        freshOltStatusReason
      );
      if (result.sent === false) {
        console.log(`[Settle] Alert suppressed for SN ${cleanSn}: ${result.reason || 'No complete corroborated output'}`);
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
    
    const liveStatus = await getOnuStatus(onu.external_id, onu.smartolt_account_id);
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
      
      const coordinates = (napBox ? getCoordinates(findCachedNap(napBox, onu)) : null) || getCoordinates(onu);
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
      `   🕒 ${escapeTelegramHtml(item.eventTime || item.formattedTime || item.timestamp)}\n` +
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
      const chatType = message.chat.type || 'unknown';
      const chatTypeLabels = {
        private: 'Conversación privada con el bot',
        group: 'Grupo',
        supergroup: 'Supergrupo',
        channel: 'Canal'
      };
      await replyToMessage(
        chatId,
        messageId,
        `🆔 <b>ID de esta conversación:</b> <code>${chatId}</code>\n` +
        `💬 <b>Tipo:</b> ${chatTypeLabels[chatType] || chatType}\n` +
        `🌐 <b>Acceso al bot:</b> ${TELEGRAM_BOT_PUBLIC ? 'Público — cualquier usuario puede abrirlo' : 'Privado'}\n\n` +
        (chatType === 'private'
          ? '<i>Telegram siempre identifica como “private” una conversación individual. Para que todos vean las alertas automáticamente, agrega el bot a un grupo o canal público.</i>'
          : '<i>Esta conversación puede utilizarse como destino compartido de alertas.</i>')
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
    let statusEmoji = isProblem ? '🔴' : '🟢';
    let statusLabel = isProblem ? statusInfo.status : 'Servicio Operativo / Online';
    
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
        let smartOltAlert = null;
        try {
          console.log(`Querying live status for ONU ${onu.external_id} (${sn}) on Smart OLT...`);
          const liveStatus = await getOnuStatus(onu.external_id, onu.smartolt_account_id);
          if (liveStatus && liveStatus.status) {
            const rawReason = liveStatus.last_down_reason || liveStatus.offline_reason ||
              liveStatus.status_reason || liveStatus.reason || '';
            smartOltAlert = classifySmartOltAlert(rawReason, liveStatus);
            oltStatusReason = smartOltAlert.rawReason;
            console.log(`Smart OLT live type for ${sn}: "${smartOltAlert.label}"`);
          }
        } catch (err) {
          console.error(`[Telegram bot Smart OLT live status query failed]:`, err.message);
        }

        const category = smartOltAlert && smartOltAlert.category !== 'unknown'
          ? smartOltAlert.category
          : statusInfo.category;
        if (isProblem && smartOltAlert) {
          statusEmoji = smartOltAlert.emoji;
          statusLabel = smartOltAlert.label;
          priorityTitle = `${smartOltAlert.emoji} <b>ALERTA SMART OLT: ${smartOltAlert.label.toUpperCase()}</b>`;
        }

        // Corroboration verification for bot
        let canSend = true;
        if (isProblem) {
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
            
            const coordinates = (napBox ? getCoordinates(findCachedNap(napBox, onu)) : null) || getCoordinates(onu);
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
        await replyToMessage(
          chatId,
          messageId,
          '⚠️ <b>No se generó una alerta operativa.</b>\n\nSmart OLT no aportó el tipo de caída y el nombre del cliente requeridos.'
        );
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
export async function processPortAlert(payload, board, port) {
  const hostName = payload.host_name || payload.host || '';
  const eventStatus = payload.event_status || payload.status || 'PROBLEM';
  const targetChatId = payload.chat_id || DEFAULT_CHAT_ID;

  if (eventStatus !== 'PROBLEM') {
    console.log(`[Port Alert] Recovery suppressed for Board ${board} Port ${port}; only detailed outage reports are sent.`);
    return { sent: false, reason: 'Recovery notification filtered' };
  }

  // A port-down trigger alone cannot prove that an individual NAP is totally
  // without power or signal, nor identify the OLT safely when board/port
  // numbers repeat. The all-OLT Smart OLT radar and SN workflow evaluate the
  // complete NAP scope instead.
  console.log(`[Port Alert] Suppressed Board ${board} Port ${port}: port-only events are not Telegram alerts under the complete-NAP policy.`);
  return { sent: false, reason: 'Port-only event requires complete NAP confirmation' };

  console.log(`[Port Alert] Detected GPON Port failure: Board ${board}, Port ${port} on OLT ${hostName}`);
  
  // 1. Read the monitoring-safe bulk status feed and join it with the local
  // NAP cache. This avoids using Smart OLT's full-details export per event.
  const onusOnPort = await fetchMonitoringOnusOnPort(board, port, hostName);
  
  if (!onusOnPort || onusOnPort.length === 0) {
    console.log(`[Port Alert] Suppressed Board ${board} Port ${port}: Smart OLT returned no registered ONUs, so a detailed alert cannot be built.`);
    return { sent: false, reason: 'No ONUs found in Smart OLT' };
  }
  
  // 2. The bulk status snapshot measures the total *actionable* impact.
  // A plain Offline state is permanently disconnected inventory here and is
  // deliberately omitted from alerts and all impact calculations.
  const reportableOnus = onusOnPort.filter(isReportableSmartOltFailure);
  const localScope = selectNearbyNapOnusForAnalysis(reportableOnus);
  const locallyReportableOnus = localScope.onus.filter(isReportableSmartOltFailure);
  console.log(`[Port Alert] Bulk status scope: ${formatNapLabel(localScope.focusNapName)} + ${localScope.nearbyNapCount} NAP(s) within ${localScope.radiusKm} km.`);
  const eventTime = extractEventTime(payload);
  const zabbixFailureText = `${payload.event_name || payload.trigger_name || ''} ${payload.trigger_description || ''}`;
  const failureType = determineRequiredFailureType(locallyReportableOnus, zabbixFailureText) ||
    determineRequiredFailureType(reportableOnus, zabbixFailureText);

  if (!failureType) {
    console.log(`[Port Alert] Suppressed Board ${board} Port ${port}: Smart OLT did not report Power Fail or LOS.`);
    return { sent: false, reason: 'Smart OLT failure cause unavailable', totalClients: onusOnPort.length, offlineCount: 0 };
  }

  const expectedCategory = failureType === 'Corte de energía' ? 'power_fail' : 'loss';
  const offlineOnus = reportableOnus.filter((onu) =>
    getExplicitSmartOltFailureCategory(onu) === expectedCategory
  );
  
  // Group by NAP for better readability
  const naps = {};
  offlineOnus.forEach(o => {
    const nap = getNapNameFromOnu(o) || 'NAP Desconocida';
    if (!naps[nap]) naps[nap] = [];
    naps[nap].push(o);
  });
  
  const totalClients = onusOnPort.filter((onu) =>
    isOnline(onu) || getExplicitSmartOltFailureCategory(onu) === expectedCategory
  ).length;
  const offlineCount = offlineOnus.length;
  const percentage = ((offlineCount / totalClients) * 100).toFixed(1);
  
  if (offlineCount === 0) {
    console.log(`[Port Alert] Suppressed Board ${board} Port ${port}: Smart OLT reports ${totalClients}/${totalClients} ONUs Online.`);
    return { sent: false, reason: 'Smart OLT reports no offline ONUs', totalClients, offlineCount };
  }

  const affectedClientNames = getAffectedClientNames(offlineOnus);
  if (affectedClientNames.length === 0) {
    console.log(`[Port Alert] Suppressed Board ${board} Port ${port}: Smart OLT did not provide affected client names.`);
    return { sent: false, reason: 'Affected client names unavailable', totalClients, offlineCount };
  }

  const BATCH_SIZE = 32;
  const totalChunks = Math.ceil(offlineCount / BATCH_SIZE);

  for (let i = 0; i < totalChunks; i++) {
    const chunkOnus = offlineOnus.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    const chunkClientNames = getAffectedClientNames(chunkOnus);
    
    const reportTitle = failureType === 'Corte de energía'
      ? `🔌⚡ <b>CORTE DE ENERGÍA EN CLIENTES DEL PUERTO GPON (Parte ${i + 1}/${totalChunks})</b>`
      : `🚨🔴 <b>CAÍDA DE SEÑAL EN PUERTO GPON (Parte ${i + 1}/${totalChunks})</b>`;
    let reportText = `${reportTitle}\n\n`;
    reportText += `${formatMandatoryAlertData(failureType, chunkClientNames, eventTime)}\n\n`;
    
    if (i === 0) {
      reportText += `🏢 <b>OLT:</b> ${hostName}\n`;
      reportText += `🔌 <b>Puerto PON Afectado:</b> Slot ${board} | Puerto PON ${port}\n`;
      reportText += `📅 <b>Hora del Evento:</b> <code>${eventTime}</code>\n\n`;
      reportText += `📊 <b>Resumen de Afectación:</b>\n`;
      reportText += `• Total Clientes en el Puerto: <b>${totalClients}</b>\n`;
      reportText += `• 🔴 Clientes Caídos (Offline): <b>${offlineCount}</b> (<b>${percentage}%</b> de afectación)\n`;
      reportText += `• 🟢 Clientes Operativos (Online): <b>${totalClients - offlineCount}</b>\n`;
      const affectedNapLabels = Object.keys(naps).map(formatNapLabel);
      reportText += `• 📦 Cajas NAP afectadas: <b>${affectedNapLabels.length}</b> — ${affectedNapLabels.map(label => `<code>${label}</code>`).join(', ')}\n`;
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
      reportText += `\n📦 <b>Caja afectada: ${formatNapLabel(nap)}</b>${mapLink} - <b>${clients.length} cliente(s) caído(s):</b>\n`;
      clients.forEach(c => {
        reportText += `  🔴 ${escapeTelegramHtml(getClientName(c))}\n`;
      });
    }
    
    await sendNotification(targetChatId, reportText.trim());
  }
  
  console.log(`[Port Alert] Successfully sent port summary for Board ${board} Port ${port} in ${totalChunks} messages. Affected: ${offlineCount}`);
  return { sent: true, messages: totalChunks, totalClients, offlineCount };
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

    const liveStatus = await getOnuStatus(onu.external_id, onu.smartolt_account_id);
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
