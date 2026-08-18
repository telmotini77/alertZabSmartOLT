import assert from 'assert';

process.env.TELEGRAM_CHAT_ID = 'test-chat';
const { classifySmartOltAlert } = await import('./routes/webhook.js');

const cases = [
  ['Dying Gasp', 'power_fail', 'Corte de energía'],
  ['Loss of Signal', 'loss', 'Pérdida de señal (LOS)'],
  ['Low optical power detected', 'low_optical_power', 'Potencia óptica baja'],
  ['ONU reboot detected', 'reboot', 'Reinicio de ONU'],
  ['ONU deactivated by OLT', 'disabled', 'ONU deshabilitada'],
  ['Authentication failure', 'authentication', 'Fallo de autenticación de ONU'],
  ['Vendor-specific optical alarm', 'olt_event', 'Vendor-specific optical alarm']
];

for (const [reason, category, label] of cases) {
  const result = classifySmartOltAlert(reason, { onu_status: 'Offline' });
  assert.equal(result.category, category, `Unexpected category for: ${reason}`);
  assert.equal(result.label, label, `Unexpected label for: ${reason}`);
}

const offlineWithoutReason = classifySmartOltAlert('', { onu_status: 'Offline' });
assert.equal(offlineWithoutReason.category, 'olt_offline');

console.log('Smart OLT alert type classification: PASS');
