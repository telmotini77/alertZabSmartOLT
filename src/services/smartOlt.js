import dotenv from 'dotenv';
dotenv.config();

const SMARTOLT_SUBDOMAIN = (process.env.SMARTOLT_SUBDOMAIN || '').trim();
const SMARTOLT_API_KEY   = (process.env.SMARTOLT_API_KEY   || '').trim();

const DEFAULT_TIMEOUT_MS = 5_000;

const getHeaders = () => ({
  'X-Token': SMARTOLT_API_KEY,
  'Accept':  'application/json'
});

const getBaseUrl = () => {
  if (!SMARTOLT_SUBDOMAIN) {
    throw new Error('SMARTOLT_SUBDOMAIN environment variable is missing.');
  }
  return `https://${SMARTOLT_SUBDOMAIN}.smartolt.com/api`;
};

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
  const url = `${getBaseUrl()}/onu/get_all_onus_details?sn=${encodeURIComponent(cleanSn)}`;
  
  try {
    const response = await fetchWithTimeout(url, { method: 'GET', headers: getHeaders() });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Smart OLT API responded with status ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    
    if (data && data.status && data.onus && data.onus.length > 0) {
      // Return the first matching ONU
      return data.onus[0];
    }
    
    return null;
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
export async function getOnuStatus(externalId) {
  if (!externalId) return null;
  
  const url = `${getBaseUrl()}/onu/get_onu_status/${encodeURIComponent(externalId)}`;
  
  try {
    const response = await fetchWithTimeout(url, { method: 'GET', headers: getHeaders() });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Smart OLT API responded with status ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    if (data && data.status) {
      return data;
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
  const url = `${getBaseUrl()}/onu/get_all_onus_details?address=${encodeURIComponent(cleanQuery)}`;
  
  try {
    const response = await fetchWithTimeout(url, { method: 'GET', headers: getHeaders() });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Smart OLT API responded with status ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    
    if (data && data.status && data.onus) {
      return data.onus;
    }
    
    return [];
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
 * @returns {Promise<Array>} - List of ONUs on that port
 */
export async function findOnusByPort(oltId, board, port, oltName) {
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

  const url = `${getBaseUrl()}/onu/get_all_onus_details?board=${encodeURIComponent(board)}&port=${encodeURIComponent(port)}&olt_id=${encodeURIComponent(oltId)}`;
  
  try {
    const response = await fetchWithTimeout(url, { method: 'GET', headers: getHeaders() });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Smart OLT API responded with status ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    
    if (data && data.status && data.onus) {
      let filtered = data.onus;
      if (oltName) {
        filtered = filtered.filter(o => !o.olt_name || o.olt_name === oltName);
      }
      return filtered;
    }
    
    return [];
  } catch (error) {
    console.error(`Error fetching ONUs by port (${board}/${port}) from Smart OLT:`, error.message);
    throw error;
  }
}

/**
 * Fetch all ONUs in the system.
 * @returns {Promise<Array>} - List of all ONUs
 */
export async function fetchAllOnus() {
  const url = `${getBaseUrl()}/onu/get_all_onus_details`;
  
  try {
    const response = await fetchWithTimeout(url, { method: 'GET', headers: getHeaders() }, 25_000);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Smart OLT API responded with status ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    if (data && data.status && data.onus) {
      return data.onus;
    }
    return [];
  } catch (error) {
    console.error('Error fetching all ONUs from Smart OLT:', error.message);
    throw error;
  }
}


