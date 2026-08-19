import express from 'express';
import dotenv from 'dotenv';
import http from 'http';
import dns from 'dns';
import { Agent, setGlobalDispatcher } from 'undici';
import webhookRoutes, { handleTelegramMessage } from './routes/webhook.js';
import { getUpdates, setWebhook, getWebhookInfo, deleteWebhook, setBotCommands } from './services/telegram.js';
import { initWebSocketServer } from './services/websocket.js';
import { initCache } from './services/cache.js';
import { getScannerStatus, startScanner } from './services/scanner.js';
import { PUBLIC_URL } from './config/publicUrl.js';

dotenv.config();

// Force Node to prefer IPv4 DNS resolution (fixes `fetch failed` in Docker Alpine)
dns.setDefaultResultOrder('ipv4first');

// Configure global Keep-Alive agent for native fetch to reuse connections
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 15_000, // 15s keep-alive
  keepAliveMaxTimeout: 30_000,
  connections: 50 // Increased pool size
}));

// ─── Startup validation ───────────────────────────────────────────────────────
const REQUIRED_VARS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
const missing = REQUIRED_VARS.filter(v => !process.env[v]?.trim());
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error('   Please configure them in your .env file and restart.');
  process.exit(1);
}

const PORT          = process.env.PORT || 3000;
const TELEGRAM_MODE = (process.env.TELEGRAM_MODE || 'polling').toLowerCase().trim();
const configuredPublicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
if (configuredPublicUrl && configuredPublicUrl !== PUBLIC_URL) {
  console.warn(`Ignoring stale PUBLIC_URL (${configuredPublicUrl}); using Render URL ${PUBLIC_URL}.`);
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

// Serve frontend static files
app.use(express.static('src/public'));

// Mount API routes
app.use('/webhook', webhookRoutes);

// ─── Health check ─────────────────────────────────────────────────────────────
let _webhookInfoCache = null;
let _webhookInfoTs    = 0;

app.get('/health', async (req, res) => {
  const mem    = process.memoryUsage();
  const uptime = process.uptime();

  // Refresh webhook info at most once per 60s
  if (TELEGRAM_MODE === 'webhook' && Date.now() - _webhookInfoTs > 60_000) {
    try {
      _webhookInfoCache = await getWebhookInfo();
      _webhookInfoTs    = Date.now();
    } catch { /* non-fatal */ }
  }

  res.json({
    status:       'ok',
    timestamp:    new Date().toISOString(),
    uptime_s:     Math.floor(uptime),
    telegramMode: TELEGRAM_MODE,
    port:         PORT,
    publicUrl:    PUBLIC_URL || null,
    webhook:      _webhookInfoCache || null,
    smartOltScanner: getScannerStatus(),
    memory: {
      rss_mb:       (mem.rss          / 1024 / 1024).toFixed(1),
      heap_used_mb: (mem.heapUsed     / 1024 / 1024).toFixed(1),
      heap_total_mb:(mem.heapTotal    / 1024 / 1024).toFixed(1)
    }
  });
});

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(app);

server.listen(PORT, async () => {
  console.log(`====================================================`);
  console.log(`🚀 Zabbix & Smart OLT Integration API Initialized`);
  console.log(`   Port:          ${PORT}`);
  console.log(`   Telegram Mode: ${TELEGRAM_MODE.toUpperCase()}`);
  if (PUBLIC_URL) {
    console.log(`   Public URL:    ${PUBLIC_URL}`);
    console.log(`\n   [Webhooks]`);
    console.log(`   Zabbix Webhook:    ${PUBLIC_URL}/webhook/zabbix`);
    console.log(`   Smart OLT Webhook: ${PUBLIC_URL}/webhook/smartolt`);
  }
  console.log(`====================================================`);

  // Initialize WebSockets
  initWebSocketServer(server);

  // Load the persisted Smart OLT state before starting the radar. This lets
  // the scanner retain its baseline across deployments and API rate limits.
  try {
    await initCache();
  } catch (err) {
    console.error('❌ Failed to initialize cache:', err.message);
  }

  // Start Smart OLT Radar Scanner
  startScanner();

  if (TELEGRAM_MODE !== 'disabled') {
    configurePublicBotCommands().catch((error) => {
      console.error('❌ Failed to publish Telegram bot commands:', error.message);
    });
  }

  if (TELEGRAM_MODE === 'webhook') {
    await setupTelegramWebhook();
  } else if (TELEGRAM_MODE === 'polling') {
    startTelegramPolling();
  } else {
    // 'disabled' mode: outbound sendMessage still works, no polling loop
    console.log('📤 Telegram mode: SEND-ONLY (polling disabled). Alerts will be sent but bot commands are inactive.');
  }
});

async function configurePublicBotCommands() {
  await setBotCommands([
    { command: 'start', description: 'Abrir el asistente público' },
    { command: 'alertas', description: 'Ver el historial público de alertas' },
    { command: 'fallas', description: 'Ver las fallas activas' },
    { command: 'mapa', description: 'Abrir el mapa público de NAPs' },
    { command: 'olt', description: 'Ver el resumen general de la red' },
    { command: 'buscar', description: 'Buscar una NAP, cliente o serial' },
    { command: 'diagnostico', description: 'Consultar una ONU por serial' },
    { command: 'ayuda', description: 'Mostrar todos los comandos' }
  ]);
  console.log('🌐 Telegram bot commands published for all users.');
}

// Graceful shutdown
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });

// ─── Webhook setup ────────────────────────────────────────────────────────────
/**
 * Register the Telegram webhook URL on startup.
 */
async function setupTelegramWebhook() {
  if (!PUBLIC_URL) {
    console.error('❌ ERROR: PUBLIC_URL must be configured in .env when using webhook mode.');
    console.error('   Set it to the public HTTPS URL of the deployed API (e.g. https://alertzabsmartolt.onrender.com)');
    return;
  }

  const webhookUrl = `${PUBLIC_URL}/webhook/telegram`;
  console.log(`⚙️  Registering Telegram Webhook: ${webhookUrl}`);
  try {
    const result = await setWebhook(webhookUrl);
    console.log('✅ Telegram Webhook registered successfully:', result.description || 'Done');

    // Cache webhook info immediately
    _webhookInfoCache = await getWebhookInfo();
    _webhookInfoTs    = Date.now();
    if (_webhookInfoCache?.last_error_message) {
      console.warn(`⚠️  Telegram webhook last error: ${_webhookInfoCache.last_error_message}`);
    }
  } catch (error) {
    console.error('❌ Failed to set Telegram Webhook:', error.message);
  }
}

// ─── Polling loop ─────────────────────────────────────────────────────────────
/**
 * Run Telegram Bot Updates using Long Polling.
 * (Used only when TELEGRAM_MODE=polling)
 * Auto-removes any previously registered webhook before starting.
 */
async function startTelegramPolling() {
  console.log('🤖 Starting Telegram Bot long-polling loop...');

  // Remove any active webhook so polling can work without conflicts
  try {
    const webhookInfo = await getWebhookInfo();
    if (webhookInfo && webhookInfo.url) {
      console.log(`⚠️  Active webhook detected (${webhookInfo.url}). Removing it to enable polling...`);
      await deleteWebhook();
      console.log('✅ Webhook removed successfully. Polling is now active.');
    }
  } catch (err) {
    console.warn(`⚠️  Could not check/remove existing webhook: ${err.message}`);
  }

  let offset        = 0;
  let consecutiveFails = 0;
  let isPolling     = false; // mutex to prevent concurrent calls

  const poll = async () => {
    if (isPolling) return; // skip if already running
    isPolling = true;
    try {
      const updates = await getUpdates(offset);
      consecutiveFails = 0; // reset on success
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          handleTelegramMessage(update.message).catch(err => {
            console.error('❌ Error handling message update:', err.message);
          });
        }
      }
      isPolling = false;
      setTimeout(poll, 200); // small gap between polls
    } catch (error) {
      isPolling = false;
      consecutiveFails++;
      const isConflict = error.message && error.message.includes('Conflict');
      const isFetchFail = error.message && (error.message.includes('fetch failed') || error.message.includes('ECONNRESET'));

      if (isConflict) {
        // Another getUpdates session is active — wait longer for it to expire
        const waitMs = Math.min(5000 * consecutiveFails, 60_000);
        console.warn(`⚠️  Telegram Conflict detected. Waiting ${waitMs / 1000}s before retrying...`);
        await new Promise(r => setTimeout(r, waitMs));
      } else if (isFetchFail) {
        // Network error — short retry
        const waitMs = Math.min(3000 * consecutiveFails, 30_000);
        console.warn(`⚠️  Telegram network error. Retrying in ${waitMs / 1000}s...`);
        await new Promise(r => setTimeout(r, waitMs));
      } else {
        console.error('❌ Telegram polling error:', error.message);
        await new Promise(r => setTimeout(r, 5000));
      }
      setTimeout(poll, 200);
    }
  };

  poll();
}
