import dotenv from 'dotenv';
dotenv.config();

const getApiUrl = () => (process.env.ZABBIX_API_URL || '').trim();
const getApiToken = () => (process.env.ZABBIX_API_TOKEN || '').trim();
const getApiUser = () => (process.env.ZABBIX_API_USER || 'Admin').trim();
const getApiPassword = () => (process.env.ZABBIX_API_PASSWORD || '').trim();

let authToken = null;

/**
 * Perform login to Zabbix API if token is not configured directly.
 */
export async function authenticate() {
  const token = getApiToken();
  if (token) {
    authToken = token;
    return authToken;
  }

  const url = getApiUrl();
  if (!url) {
    throw new Error('ZABBIX_API_URL is missing. Please configure it in the .env file.');
  }

  const user = getApiUser();
  const password = getApiPassword();

  console.log(`Authenticating with Zabbix API at ${url} using user ${user}...`);
  
  const payload = {
    jsonrpc: '2.0',
    method: 'user.login',
    params: {
      username: user,
      password: password
    },
    id: 1,
    auth: null
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Zabbix API responded with status ${response.status}: ${text}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(`Zabbix API Error: ${data.error.message} - ${data.error.data}`);
    }

    authToken = data.result;
    console.log('✅ Zabbix API authenticated successfully.');
    return authToken;
  } catch (error) {
    console.error('Error authenticating with Zabbix:', error.message);
    throw error;
  }
}

/**
 * Fetch all triggers currently in PROBLEM state from Zabbix.
 * @returns {Promise<Array>} - List of active problems
 */
export async function getActiveTriggers() {
  const url = getApiUrl();
  if (!url) {
    console.warn('⚠️ ZABBIX_API_URL is not configured. Active triggers sync is disabled.');
    return [];
  }

  if (!authToken) {
    await authenticate();
  }

  const payload = {
    jsonrpc: '2.0',
    method: 'trigger.get',
    params: {
      output: ['triggerid', 'description', 'priority', 'lastchange'],
      selectHosts: ['hostid', 'host', 'name'],
      filter: {
        value: 1, // PROBLEM state
        status: 0 // Enabled triggers only
      },
      monitored: true,
      skipDependent: true,
      sortfield: 'lastchange',
      sortorder: 'DESC'
    },
    auth: authToken,
    id: 2
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Zabbix API responded with status ${response.status}: ${text}`);
    }

    const data = await response.json();
    if (data.error) {
      const isTokenExpired = data.error.code === -32602 || 
                            data.error.message.toLowerCase().includes('session') || 
                            data.error.message.toLowerCase().includes('auth');
      
      // If token expired and user login is configured, try re-authenticating once
      if (isTokenExpired && !getApiToken()) {
        console.log('Zabbix token expired. Re-authenticating...');
        authToken = null;
        return getActiveTriggers();
      }
      throw new Error(`Zabbix API Error: ${data.error.message} - ${data.error.data}`);
    }

    return data.result || [];
  } catch (error) {
    console.error('Error fetching active triggers from Zabbix:', error.message);
    throw error;
  }
}
