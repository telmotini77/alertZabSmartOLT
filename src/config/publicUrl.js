// This deployment is served exclusively through Render. Keeping the URL in
// one module prevents stale tunnel environment variables from leaking into
// Telegram buttons, map links, health checks, or Telegram webhooks.
export const PUBLIC_URL = 'https://alertzabsmartolt.onrender.com';
