import dotenv from 'dotenv';
dotenv.config();

const SMARTOLT_SUBDOMAIN = (process.env.SMARTOLT_SUBDOMAIN || '').trim();
const SMARTOLT_API_KEY = (process.env.SMARTOLT_API_KEY || '').trim();

const DEFAULT_TIMEOUT_MS = 5_000;
const FULL_SNAPSHOT_DEFAULT_TTL_MS = 60 * 60 * 1_000;
const FULL_SNAPSHOT_MIN_TTL_MS = 60 * 60 * 1_000;
const STATUS_SNAPSHOT_DEFAULT_TTL_MS = 5 * 60 * 1_000;
const STATUS_FORCE_REFRESH_MIN_COOLDOWN_MS = 15 * 1_000;

let fullSnapshotCache = {
  onus: null,
  fetchedAt: 0,
  inFlight: null
};
let statusSnapshotCache = {
  onus: null,
  fetchedAt: 0,
  inFlight: null
};
// A Smart OLT account/domain has its own API quota. Keep the emergency live
// diagnostic queue separate per account so one domain cannot throttle another.
const liveStatusQueues = new Map();
const liveStatusRequestTimes = new Map();

const normalizeSubdomain = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/^https?:\/\//, '')
  .replace(/\.smartolt\.com(?:\/.*)?$/, '')
  .replace(/\/$/, '');

function readSmartOltAccounts() {
  const raw = String(process.env.SMARTOLT_ACCOUNTS_JSON || '').trim();
  let entries = [];

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      entries = Array.isArray(parsed) ? parsed : parsed?.accounts;
      if (!Array.isArray(entries)) {
        return { accounts: [], error: 'SMARTOLT_ACCOUNTS_JSON debe ser una lista JSON de cuentas Smart OLT.' };
      }
    } catch {
      return { accounts: [], error: 'SMARTOLT_ACCOUNTS_JSON no contiene JSON válido.' };
    }
  } else if (SMARTOLT_SUBDOMAIN || SMARTOLT_API_KEY) {
    // Backward-compatible single-domain configuration. Existing deployments
    // continue working until SMARTOLT_ACCOUNTS_JSON is added in Render.
    entries = [{ id: 'default', subdomain: SMARTOLT_SUBDOMAIN, apiKey: SMARTOLT_API_KEY }];
  }

  const ids = new Set();
  const accounts = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] || {};
    const subdomain = normalizeSubdomain(entry.subdomain || entry.domain || entry.host);
    const apiKey = String(entry.apiKey || entry.api_key || entry.token || '').trim();
    const id = String(entry.id || entry.name || subdomain || `account-${index + 1}`).trim();
    if (!subdomain || !apiKey) {
      return { accounts: [], error: `La cuenta Smart OLT #${index + 1} necesita subdomain y apiKey.` };
    }
    if (ids.has(id)) {
      return { accounts: [], error: `El identificador de cuenta Smart OLT "${id}" está repetido.` };
    }
    ids.add(id);
    accounts.push({ id, subdomain, apiKey });
  }

  return { accounts, error: '' };
}

const smartOltAccountConfig = readSmartOltAccounts();

/**
 * Safe account metadata for health checks. API keys are never exposed.
 */
export function getSmartOltAccounts() {
  return smartOltAccountConfig.accounts.map(({ id, subdomain }) => ({ id, subdomain }));
}

function getConfiguredAccounts() {
  if (smartOltAccountConfig.error) throw new Error(smartOltAccountConfig.error);
  if (smartOltAccountConfig.accounts.length === 0) {
    throw new Error('No hay cuentas Smart OLT configuradas. Define SMARTOLT_ACCOUNTS_JSON o SMARTOLT_SUBDOMAIN/SMARTOLT_API_KEY.');
  }
  return smartOltAccountConfig.accounts;
}

function getAccount(accountId = '') {
  const accounts = getConfiguredAccounts();
  const cleanId = String(accountId || '').trim();
  if (cleanId) {
    const account = accounts.find((candidate) => candidate.id === cleanId);
    if (!account) throw new Error(`La cuenta Smart OLT "${cleanId}" no está configurada.`);
    return account;
  }
  if (accounts.length === 1) return accounts[0];
  throw new Error('La ONU no identifica su cuenta Smart OLT; no se puede consultar un external_id ambiguo entre dominios.');
}

const addAccountContext = (onu, account) => ({
  ...onu,
  smartolt_account_id: account.id,
  smartolt_subdomain: account.subdomain,
  external_id: onu?.external_id || onu?.unique_external_id || ''
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const getFullSnapshotTtlMs = () =>
  Math.max(
    getPositiveInteger(process.env.SMARTOLT_SNAPSHOT_CACHE_SECONDS, FULL_SNAPSHOT_DEFAULT_TTL_MS / 1_000) * 1_000,
    FULL_SNAPSHOT_MIN_TTL_MS
  );

const getStatusSnapshotTtlMs = () =>
  Math.max(
    getPositiveInteger(process.env.SMARTOLT_STATUS_CACHE_SECONDS, STATUS_SNAPSHOT_DEFAULT_TTL_MS / 1_000) * 1_000,
    STATUS_SNAPSHOT_DEFAULT_TTL_MS
  );

const getStatusForceRefreshCooldownMs = () =>
  Math.max(
    getPositiveInteger(process.env.SMARTOLT_STATUS_FORCE_REFRESH_SECONDS, 15) * 1_000,
    STATUS_FORCE_REFRESH_MIN_COOLDOWN_MS
  );

const getLiveStatusWindowMs = () =>
  getPositiveInteger(process.env.SMARTOLT_LIVE_STATUS_WINDOW_SECONDS, 180) * 1_000;

// Four requests every three minutes is a hard ceiling. A stale deployment
// variable with the former value must not reopen the Smart OLT rate-limit.
const getLiveStatusWindowLimit = () =>
  Math.min(getPositiveInteger(process.env.SMARTOLT_LIVE_STATUS_MAX_REQUESTS, 4), 4);

/**
 * Limit live ONU status reads in a shared queue. Full inventory reads are
 * already paced by the scanner; this protects bursty alert correlations from
 * exhausting Smart OLT's hourly API allowance.
 */
async function acquireLiveStatusSlot(accountId) {
  if (process.env.NODE_ENV === 'test') return;

  const queue = liveStatusQueues.get(accountId) || Promise.resolve();
  const requestTimes = liveStatusRequestTimes.get(accountId) || [];
  const queuedTask = queue.then(async () => {
    const windowMs = getLiveStatusWindowMs();
    const limit = getLiveStatusWindowLimit();

    while (true) {
      const now = Date.now();
      while (requestTimes.length > 0 && requestTimes[0] <= now - windowMs) {
        requestTimes.shift();
      }

      if (requestTimes.length < limit) {
        requestTimes.push(Date.now());
        return;
      }

      const retryAt = requestTimes[0] + windowMs;
      await wait(Math.max(1, retryAt - now));
    }
  });

  // Keep the queue usable after any unexpected error in a caller.
  liveStatusQueues.set(accountId, queuedTask.catch(() => {}));
  liveStatusRequestTimes.set(accountId, requestTimes);
  await queuedTask;
}

const getHeaders = (account) => ({
  'X-Token': account.apiKey,
  'Accept':  'application/json'
});

const getBaseUrl = (account) => `https://${account.subdomain}.smartolt.com/api`;

async function requestAccountJson(account, path, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const response = await fetchWithTimeout(
    `${getBaseUrl(account)}${path}`,
    { method: 'GET', headers: getHeaders(account) },
    timeoutMs
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Smart OLT account "${account.id}" responded with status ${response.status}: ${errorText}`);
  }
  return response.json();
}

async function collectAccounts(operation, label) {
  const accounts = getConfiguredAccounts();
  const results = await Promise.allSettled(accounts.map(operation));
  const successful = [];
  const failed = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') successful.push(result.value);
    else failed.push({ account: accounts[index], error: result.reason });
  });

  failed.forEach(({ account, error }) =>
    console.error(`Smart OLT ${label} failed for account "${account.id}" (${account.subdomain}):`, error?.message || error)
  );
  if (successful.length === 0) {
    throw new Error(`No se pudo consultar ninguna cuenta Smart OLT para ${label}: ${failed.map(({ account, error }) => `${account.id}: ${error?.message || error}`).join(' | ')}`);
  }
  return successful;
}

/**
 * Fetch with an AbortController timeout so a slow/dead Smart OLT API
 * never blocks the event loop indefinitely.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Smart OLT API request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  }
}

/**
 * Find ONU details by its serial number (SN).
 * @param {string} sn - GPON/EPON Serial Number
 * @returns {Promise<Object|null>} - Returns ONU details or null if not found
 */
export async function findOnuBySn(sn) {
  if (!sn) return null;
  const cleanSn = sn.trim();
  try {
    const responses = await collectAccounts(async (account) => {
      const data = await requestAccountJson(
        account,
        `/onu/get_all_onus_details?sn=${encodeURIComponent(cleanSn)}`
      );
      const onu = Array.isArray(data?.onus) && data.onus.length > 0 ? data.onus[0] : null;
      return onu ? addAccountContext(onu, account) : null;
    }, `buscar ONU ${cleanSn}`);
    return responses.find(Boolean) || null;
  } catch (error) {
    console.error(`Error fetching ONU by SN (${cleanSn}) from Smart OLT:`, error.message);
    throw error;
  }
}

/**
 * Get real-time ONU status from the OLT by external ID.
 * @param {string} externalId - ONU external_id
 * @returns {Promise<Object|null>} - Returns live status details (like Rx power, temperature, status description)
 */
export async function getOnuStatus(externalId, smartOltAccountId = '') {
  if (!externalId) return null;
  const account = getAccount(smartOltAccountId);
  await acquireLiveStatusSlot(account.id);
  try {
    const data = await requestAccountJson(account, `/onu/get_onu_status/${encodeURIComponent(externalId)}`);
    if (data && data.status) {
      return addAccountContext(data, account);
    }
    return null;
  } catch (error) {
    console.error(`Error fetching ONU status for ID (${externalId}) from Smart OLT:`, error.message);
    throw error;
  }
}

/**
 * Find all ONUs matching a specific address query (e.g. NAP box code).
 * @param {string} addressQuery - Address search term (e.g. "NAP-04-A")
 * @returns {Promise<Array>} - List of matching ONUs
 */
export async function findOnusByAddressQuery(addressQuery) {
  if (!addressQuery) return [];
  const cleanQuery = addressQuery.trim();
  try {
    const responses = await collectAccounts(async (account) => {
      const data = await requestAccountJson(
        account,
        `/onu/get_all_onus_details?address=${encodeURIComponent(cleanQuery)}`
      );
      return Array.isArray(data?.onus) ? data.onus.map((onu) => addAccountContext(onu, account)) : [];
    }, `buscar dirección ${cleanQuery}`);
    return responses.flat();
  } catch (error) {
    console.error(`Error fetching ONUs by address query (${cleanQuery}) from Smart OLT:`, error.message);
    throw error;
  }
}

/**
 * Find all ONUs on a specific OLT, board, and port.
 * @param {string|number} oltId - OLT ID (optional)
 * @param {string|number} board - Slot / Board number
 * @param {string|number} port - PON Port number
 * @param {string} [oltName] - OLT Name for local fallback filtering
 * @param {string} [smartOltAccountId] - Account/domain that owns the OLT
 * @returns {Promise<Array>} - List of ONUs on that port
 */
export async function findOnusByPort(oltId, board, port, oltName, smartOltAccountId = '') {
  if (board === undefined || port === undefined) return [];
  
  if (!oltId) {
    // Smart OLT requires olt_id for board/port queries. 
    // If we don't have it, we must fetch all ONUs and filter locally.
    try {
      const allOnus = await fetchAllOnus();

      const portOnus = allOnus.filter(o => String(o.board) === String(board) && String(o.port) === String(port));

      if (oltName) {
        const zHost = String(oltName).toLowerCase();
        const matched = portOnus.filter(o => {
          const sHost = String(o.olt_name || '').toLowerCase();
          return sHost === zHost || sHost.includes(zHost) || zHost.includes(sHost);
        });
        
        // If strict/loose match yields results, return them. 
        // Otherwise, return all ONUs on that port (fallback in case Zabbix and Smart OLT names don't match at all).
        if (matched.length > 0) return matched;
      }
      
      return portOnus;
    } catch (err) {
      console.error(`Error filtering ONUs locally by port (${board}/${port}):`, err.message);
      return [];
    }
  }

  try {
    const accounts = smartOltAccountId ? [getAccount(smartOltAccountId)] : getConfiguredAccounts();
    const responses = await collectAccounts(async (account) => {
      if (!accounts.some((candidate) => candidate.id === account.id)) return [];
      const data = await requestAccountJson(
        account,
        `/onu/get_all_onus_details?board=${encodeURIComponent(board)}&port=${encodeURIComponent(port)}&olt_id=${encodeURIComponent(oltId)}`
      );
      return Array.isArray(data?.onus) ? data.onus.map((onu) => addAccountContext(onu, account)) : [];
    }, `buscar puerto ${board}/${port}`);
    let filtered = responses.flat();
    if (oltName) filtered = filtered.filter((onu) => !onu.olt_name || onu.olt_name === oltName);
    return filtered;
  } catch (error) {
    console.error(`Error fetching ONUs by port (${board}/${port}) from Smart OLT:`, error.message);
    throw error;
  }
}

/**
 * Fetch the compact, monitoring-safe Smart OLT status feed. Smart OLT
 * explicitly recommends this endpoint (cached for five minutes) instead of
 * issuing get_onu_status calls for individual ONUs in an automated workflow.
 */
export async function fetchAllOnuStatuses({ forceRefresh = false } = {}) {
  const now = Date.now();
  const snapshotTtlMs = getStatusSnapshotTtlMs();
  const cacheAgeMs = now - statusSnapshotCache.fetchedAt;
  const canReuseCache = statusSnapshotCache.onus && cacheAgeMs < snapshotTtlMs;
  const forceRefreshAllowed = cacheAgeMs >= getStatusForceRefreshCooldownMs();

  if (process.env.NODE_ENV !== 'test' && canReuseCache && (!forceRefresh || !forceRefreshAllowed)) {
    return statusSnapshotCache.onus;
  }
  if (process.env.NODE_ENV !== 'test' && statusSnapshotCache.inFlight) {
    return statusSnapshotCache.inFlight;
  }

  const request = (async () => {
    try {
      const accountOnus = await collectAccounts(async (account) => {
        const data = await requestAccountJson(account, '/onu/get_onus_statuses', 15_000);
        const rawOnus = Array.isArray(data?.response)
          ? data.response
          : Array.isArray(data?.onus)
            ? data.onus
            : [];
        return rawOnus.map((onu) => addAccountContext(onu, account));
      }, 'estado masivo de ONUs');
      const onus = accountOnus.flat();

      if (process.env.NODE_ENV !== 'test') {
        statusSnapshotCache = { onus, fetchedAt: Date.now(), inFlight: null };
      }
      return onus;
    } catch (error) {
      console.error('Error fetching Smart OLT ONU status snapshot:', error.message);
      throw error;
    } finally {
      if (statusSnapshotCache.inFlight) statusSnapshotCache.inFlight = null;
    }
  })();

  if (process.env.NODE_ENV !== 'test') {
    statusSnapshotCache.inFlight = request;
  }
  return request;
}

/**
 * Fetch all ONUs in the system.
 * @returns {Promise<Array>} - List of all ONUs
 */
export async function fetchAllOnus({ forceRefresh = false } = {}) {
  const now = Date.now();
  const snapshotTtlMs = getFullSnapshotTtlMs();

  if (process.env.NODE_ENV !== 'test' && !forceRefresh && fullSnapshotCache.onus &&
      now - fullSnapshotCache.fetchedAt < snapshotTtlMs) {
    return fullSnapshotCache.onus;
  }
  if (process.env.NODE_ENV !== 'test' && !forceRefresh && fullSnapshotCache.inFlight) {
    return fullSnapshotCache.inFlight;
  }

  const request = (async () => {
    try {
      const accountOnus = await collectAccounts(async (account) => {
        const data = await requestAccountJson(account, '/onu/get_all_onus_details', 25_000);
        return Array.isArray(data?.onus) ? data.onus.map((onu) => addAccountContext(onu, account)) : [];
      }, 'inventario de ONUs');
      const onus = accountOnus.flat();
      if (process.env.NODE_ENV !== 'test') {
        fullSnapshotCache = { onus, fetchedAt: Date.now(), inFlight: null };
      }
      return onus;
    } catch (error) {
      console.error('Error fetching all ONUs from Smart OLT:', error.message);
      throw error;
    } finally {
      if (fullSnapshotCache.inFlight) fullSnapshotCache.inFlight = null;
    }
  })();

  if (process.env.NODE_ENV !== 'test') {
    fullSnapshotCache.inFlight = request;
  }
  return request;
}


