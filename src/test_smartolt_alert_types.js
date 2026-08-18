import assert from 'assert';

process.env.TELEGRAM_CHAT_ID = 'test-chat';
const { classifySmartOltAlert, compareSmartOltWithZabbix, formatNapLabel } = await import('./routes/webhook.js');

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

assert.equal(formatNapLabel('sm-7030-1'), 'NAP SM-7030-1');
assert.equal(formatNapLabel('SM0201-5'), 'NAP SM0201-5');
assert.equal(formatNapLabel('NAP-04-A'), 'NAP-04-A');
assert.equal(formatNapLabel(''), 'NAP no identificada');

const reclassifiedPower = compareSmartOltWithZabbix(
  classifySmartOltAlert('Dying Gasp', { onu_status: 'Offline' }),
  { category: 'loss', status: 'Pérdida de Señal (Loss of Signal)' },
  'PROBLEM',
  { status: 'Offline' }
);
assert.equal(reclassifiedPower.confirmed, true);
assert.equal(reclassifiedPower.agreement, 'reclassified');
assert.ok(reclassifiedPower.verdict.includes('Corte de energía'));

const rejectedMismatch = compareSmartOltWithZabbix(
  classifySmartOltAlert('', { onu_status: 'Online' }),
  { category: 'loss', status: 'Pérdida de Señal (Loss of Signal)' },
  'PROBLEM',
  { status: 'Online' }
);
assert.equal(rejectedMismatch.confirmed, false);
assert.equal(rejectedMismatch.agreement, 'state_mismatch');

console.log('Smart OLT alert type and NAP label formatting: PASS');
