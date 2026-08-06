import { fetchAllOnus } from './smartOlt.js';
import { processAndSendAlert } from '../routes/webhook.js';
import { updateOnuStatusInCache } from './cache.js';
import { broadcast } from './websocket.js';

// SN -> "Online" or "Offline"
let previousStateMap = new Map();
let isFirstScan = true;

/**
 * Start the Smart OLT background radar scanner.
 */
export function startScanner() {
  const scanIntervalMinutes = parseInt(process.env.SMARTOLT_SCAN_INTERVAL_MINUTES, 10);
  
  if (isNaN(scanIntervalMinutes) || scanIntervalMinutes <= 0) {
    console.log('📡 Smart OLT Radar Scanner is disabled (SMARTOLT_SCAN_INTERVAL_MINUTES is not set or invalid).');
    return;
  }

  const scanIntervalMs = scanIntervalMinutes * 60 * 1000;
  console.log(`📡 Starting Smart OLT Radar Scanner. Interval: ${scanIntervalMinutes} minute(s).`);

  // Run immediately (to build the baseline), then loop
  runScanCycle();
  setInterval(runScanCycle, scanIntervalMs);
}

async function runScanCycle() {
  try {
    const onus = await fetchAllOnus();
    if (!onus || onus.length === 0) return;

    let dropsDetected = 0;

    for (const onu of onus) {
      const sn = (onu.sn || '').toUpperCase();
      if (!sn) continue;

      const rawStatus = (onu.status || '').toLowerCase();
      const currentStatus = (rawStatus === 'online' || rawStatus === 'active') ? 'Online' : 'Offline';

      if (!isFirstScan) {
        const previousStatus = previousStateMap.get(sn);

        // Detect Drop (Online -> Offline)
        if (previousStatus === 'Online' && currentStatus === 'Offline') {
          dropsDetected++;
          handleIndividualDrop(onu);
        }
      }

      // Update baseline
      previousStateMap.set(sn, currentStatus);
    }

    if (isFirstScan) {
      console.log(`📡 Radar Baseline Built: Tracking ${previousStateMap.size} ONUs.`);
      isFirstScan = false;
    } else {
      console.log(`📡 Radar Scan Complete. Detected ${dropsDetected} new individual drops.`);
    }

  } catch (error) {
    console.error('❌ Radar Scanner encountered an error:', error.message);
  }
}

async function handleIndividualDrop(onu) {
  const sn = onu.sn.toUpperCase();
  console.log(`[Radar] Detected drop for ONU ${sn}. Firing alert...`);
  
  // Construct a fake Zabbix payload so the existing processing logic handles it perfectly
  const eventName = `Smart OLT Radar: ONU Offline`;
  const reason = onu.offline_reason || onu.last_down_reason || 'Desconexión detectada por escáner';
  
  const zabbixLikePayload = {
    event_name: eventName,
    trigger_description: reason,
    host_name: onu.olt_name || 'Smart OLT',
    event_severity: 'High',
    event_status: 'PROBLEM',
    chat_id: process.env.TELEGRAM_CHAT_ID,
    onu_sn: sn
  };

  try {
    let overrideReason = reason;
    if (reason.toLowerCase().includes('power') || reason.toLowerCase().includes('dying')) {
      overrideReason = 'Corte de Energía (Dying Gasp)';
    } else if (reason.toLowerCase().includes('los') || reason.toLowerCase().includes('signal')) {
      overrideReason = 'Pérdida de Señal (LOS)';
    }

    // Pass it directly to the webhook handler logic
    await processAndSendAlert(zabbixLikePayload, null, overrideReason);
    
    // Update local cache manually just in case
    const updatedNap = updateOnuStatusInCache(sn, 'Offline');
    if (updatedNap) broadcast('nap_status_update', updatedNap);

  } catch (err) {
    console.error(`[Radar] Error firing alert for ${sn}:`, err.message);
  }
}
