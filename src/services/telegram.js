import dotenv from 'dotenv';
import crypto from 'crypto';
dotenv.config();

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();

// ─── Config ───────────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 20_000; // 20s per Telegram request (Docker may be slow on first connect)
const MAX_RETRIES      = 3;
const DEDUP_TTL_MS     = 60_000; // 60s deduplication window

// ─── In-memory deduplication cache ────────────────────────────────────────────
// Prevents sending the exact same message twice within DEDUP_TTL_MS
const dedupCache = new Map();

function dedupKey(chatId, text) {
  return crypto.createHash('sha1').update(`${chatId}:${text}`).digest('hex');
}

function isDuplicate(chatId, text) {
  const key = dedupKey(chatId, text);
  const ts  = dedupCache.get(key);
  if (ts && Date.now() - ts < DEDUP_TTL_MS) return true;
  dedupCache.set(key, Date.now());
  // Evict expired entries every 100 inserts to prevent unbounded growth
  if (dedupCache.size % 100 === 0) {
    const now = Date.now();
    for (const [k, t] of dedupCache) {
      if (now - t > DEDUP_TTL_MS) dedupCache.delete(k);
    }
  }
  return false;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const getBaseUrl = () => {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN environment variable is missing.');
  }
  return `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
};

/**
 * fetch() with AbortController timeout and exponential-backoff retries.
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} attempt
 */
async function fetchWithRetry(url, options = {}, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    const isRetryable = err.name === 'AbortError' || 
                        err.name === 'TypeError' ||
                        err.code === 'ECONNRESET' || 
                        err.code === 'ETIMEDOUT' || 
                        err.code === 'ENOTFOUND' ||
                        (err.message && err.message.includes('fetch failed'));
    if (isRetryable && attempt < MAX_RETRIES) {
      const delay = 500 * 2 ** (attempt - 1); // 500ms → 1000ms → 2000ms
      console.warn(`⚠️ Telegram fetch failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms… [${err.message}]`);
      await new Promise(r => setTimeout(r, delay));
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a message to Telegram with deduplication, timeout, and retry.
 * @param {string|number} chatId - Telegram chat ID
 * @param {string} text - Message content
 * @param {Object} [options] - Additional Telegram sendMessage options
 * @returns {Promise<Object|null>} - Telegram API result, or null if deduplicated
 */
export async function sendMessage(chatId, text, options = {}) {
  // Deduplicate identical messages within the TTL window
  if (!options.reply_to_message_id && isDuplicate(chatId, text)) {
    console.log(`⚡ [Telegram] Deduplicated duplicate message to chat ${chatId}.`);
    return null;
  }

  const url     = `${getBaseUrl()}/sendMessage`;
  const payload = {
    chat_id:    chatId,
    text:       text,
    parse_mode: options.parse_mode || 'HTML',
    ...options
  };

  try {
    const response = await fetchWithRetry(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(`Telegram API Error ${data.error_code ?? ''}: ${data.description || 'Unknown error'}`);
    }
    return data.result;
  } catch (error) {
    console.error('❌ Error sending message to Telegram:', error.message);
    throw error;
  }
}

/**
 * Reply to a specific message in a chat.
 * @param {string|number} chatId - Telegram chat ID
 * @param {number} replyToMessageId - The message to reply to
 * @param {string} text - Message content
 * @returns {Promise<Object>}
 */
export async function replyToMessage(chatId, replyToMessageId, text) {
  return sendMessage(chatId, text, { reply_to_message_id: replyToMessageId });
}

/**
 * Register a webhook for Telegram Bot updates.
 * @param {string} webhookUrl - Public HTTPS URL of our webhook endpoint
 * @returns {Promise<Object>}
 */
export async function setWebhook(webhookUrl) {
  const url = `${getBaseUrl()}/setWebhook`;
  try {
    const response = await fetchWithRetry(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        url:                  webhookUrl,
        max_connections:      100,
        allowed_updates:      ['message'],
        drop_pending_updates: false
      })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(`Telegram API Error: ${data.description || 'Unknown error'}`);
    }
    return data;
  } catch (error) {
    console.error('❌ Error setting Telegram webhook:', error.message);
    throw error;
  }
}

/**
 * Delete the active Telegram webhook.
 * Call this when switching from webhook to polling mode to avoid conflict errors.
 * @returns {Promise<Object>}
 */
export async function deleteWebhook() {
  const url = `${getBaseUrl()}/deleteWebhook`;
  try {
    const response = await fetchWithRetry(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ drop_pending_updates: false })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(`Telegram API Error: ${data.description || 'Unknown error'}`);
    }
    return data;
  } catch (error) {
    console.error('❌ Error deleting Telegram webhook:', error.message);
    throw error;
  }
}

/**
 * Get current webhook configuration from Telegram servers.
 * Useful for health checks and diagnostics.
 * @returns {Promise<Object>}
 */
export async function getWebhookInfo() {
  const url = `${getBaseUrl()}/getWebhookInfo`;
  try {
    const response = await fetchWithRetry(url, { method: 'GET' });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(`Telegram API Error: ${data.description || 'Unknown error'}`);
    }
    return data.result;
  } catch (error) {
    console.error('❌ Error getting Telegram webhook info:', error.message);
    throw error;
  }
}

/**
 * Get bot updates using long polling.
 * @param {number} offset - The offset of the first update to be returned
 * @returns {Promise<Array>} - List of update objects
 */
export async function getUpdates(offset = 0) {
  const url = `${getBaseUrl()}/getUpdates?offset=${offset}&timeout=30`;
  // Polling timeout is 30s; add buffer so AbortController fires after Telegram's own timeout
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 35_000);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(`Telegram API Error: ${data.description || 'Unknown error'}`);
    }
    return data.result;
  } catch (error) {
    clearTimeout(timer);
    console.error('❌ Error getting Telegram updates (polling):', error.message);
    throw error;
  }
}
