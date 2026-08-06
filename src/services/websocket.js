import { WebSocketServer } from 'ws';

let wss = null;

const PING_INTERVAL_MS = 30_000; // ping clients every 30s

/**
 * Initialize the WebSocket Server attached to the HTTP server.
 * @param {Object} server - HTTP Server instance
 */
export function initWebSocketServer(server) {
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    console.log('🔌 New WebSocket client connected');

    // Mark alive on first connection
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Send a welcome snapshot
    ws.send(JSON.stringify({
      event:   'welcome',
      message: 'Connected to Zabbix & Smart OLT real-time map'
    }));

    ws.on('close', () => {
      console.log('🔌 WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      console.error('❌ WebSocket client error:', error.message);
    });
  });

  // ─── Ping/Pong keepalive ──────────────────────────────────────────────────
  // Detects and removes stale connections that TCP never reported as closed
  const pingInterval = setInterval(() => {
    if (!wss) { clearInterval(pingInterval); return; }

    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        console.warn('⚠️ Terminating unresponsive WebSocket client');
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, PING_INTERVAL_MS);

  wss.on('close', () => clearInterval(pingInterval));

  console.log('🚀 WebSocket server attached to HTTP server');
}

/**
 * Broadcast an event to all connected alive clients.
 * @param {string} event - Name of the event
 * @param {Object} data  - Payload data
 */
export function broadcast(event, data) {
  if (!wss) {
    console.warn('⚠️ WebSocket server is not initialized yet. Cannot broadcast.');
    return;
  }

  const payload = JSON.stringify({ event, data });
  let count = 0;

  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
      count++;
    }
  });

  if (count > 0) {
    console.log(`📡 Broadcasted event "${event}" to ${count} client(s).`);
  }
}

