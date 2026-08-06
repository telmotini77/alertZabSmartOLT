import express from 'express';
import dotenv from 'dotenv';
import http from 'http';
import webhookRoutes, { handleTelegramMessage } from './routes/webhook.js';
import { getUpdates, setWebhook, getWebhookInfo } from './services/telegram.js';
import { initWebSocketServer } from './services/websocket.js';
import { initCache } from './services/cache.js';
import { startScanner } from './services/scanner.js';

dotenv.config();

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
const PUBLIC_URL    = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, ''); // strip trailing slash

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

  // Initialize Cache (non-blocking)
  initCache().catch(err => {
    console.error('❌ Failed to initialize cache:', err.message);
  });

  // Start Smart OLT Radar Scanner
  startScanner();

  if (TELEGRAM_MODE === 'webhook') {
    await setupTelegramWebhook();
  } else {
    startTelegramPolling();
  }
});

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
    console.error('   Set it to your ngrok or production HTTPS URL (e.g. https://xxxx.ngrok-free.app)');
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
 */
async function startTelegramPolling() {
  console.log('🤖 Starting Telegram Bot long-polling loop...');
  let offset = 0;

  const poll = async () => {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          handleTelegramMessage(update.message).catch(err => {
            console.error('❌ Error handling message update:', err.message);
          });
        }
      }
    } catch (error) {
      console.error('❌ Error in Telegram polling loop:', error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    setTimeout(poll, 100);
  };

  poll();
}

