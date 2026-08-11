import { extractSerialNumber, extractNapBox, parseStatusInfo, extractEventTime } from './utils/parser.js';

console.log('--- STARTING PARSER TESTS ---');

const testCases = [
  {
    text: 'ZABBIX: Problem started at 15:30:00 on 2026.07.27\nProblem name: ONU FHTT8c3a91bf Loss of Signal\nHost: OLT-CENTRAL\nSeverity: High',
    expectedSn: 'FHTT8C3A91BF',
    expectedStatusCategory: 'loss'
  },
  {
    text: 'Alerta: El equipo HWTC12345678 reporta corte de luz (Power Fail) en slot 1 port 3',
    expectedSn: 'HWTC12345678',
    expectedStatusCategory: 'power_fail'
  },
  {
    text: 'ZTEG00998877 status changed to PROBLEM',
    expectedSn: 'ZTEG00998877',
    expectedStatusCategory: 'generic'
  },
  {
    text: 'Host OLT-PRINCIPAL. CPU load is too high (> 95%)',
    expectedSn: null,
    expectedStatusCategory: 'cpu_overload'
  },
  {
    text: 'Zabbix alert: Hex SN 4857544338423232 Loss of Signal detected',
    expectedSn: 'HWTC38423232',
    expectedStatusCategory: 'loss'
  },
  {
    text: 'Zabbix alert: Hex SN with spaces 48 57 54 43 38 42 32 32 Dying gasp',
    expectedSn: 'HWTC38423232',
    expectedStatusCategory: 'power_fail'
  },
  {
    text: 'Zabbix alert: Hex SN for ZTE 5A54454700998877 is offline',
    expectedSn: 'ZTEG00998877',
    expectedStatusCategory: 'loss'
  }
];

let failed = 0;

testCases.forEach((tc, idx) => {
  const sn = extractSerialNumber(tc.text);
  const statusInfo = parseStatusInfo(tc.text);
  
  const snOk = sn === tc.expectedSn;
  const statusOk = statusInfo.category === tc.expectedStatusCategory;
  
  if (snOk && statusOk) {
    console.log(`✅ Test Case ${idx + 1} Passed`);
  } else {
    console.log(`❌ Test Case ${idx + 1} Failed!`);
    console.log(`   Text: ${tc.text.replace(/\n/g, ' ')}`);
    console.log(`   SN: Got "${sn}", Expected "${tc.expectedSn}"`);
    console.log(`   Status Category: Got "${statusInfo.category}", Expected "${tc.expectedStatusCategory}"`);
    failed++;
  }
});

console.log('\n--- STARTING NAP BOX EXTRACTION TESTS ---');
const napTestCases = [
  { text: 'Calle Falsa 123, NAP-04-A, Sector Centro', expectedNap: 'NAP-04-A' },
  { text: 'Caja NAP 12 en poste 4', expectedNap: 'NAP-12' },
  { text: 'Direccion: Av. Siempreviva 742 (NAP_09_B)', expectedNap: 'NAP_09_B' },
  { text: 'NAP 113 principal', expectedNap: 'NAP 113' },
  { text: 'Sin datos de splitter', expectedNap: null }
];

napTestCases.forEach((tc, idx) => {
  const nap = extractNapBox(tc.text);
  if (nap === tc.expectedNap) {
    console.log(`✅ NAP Test Case ${idx + 1} Passed`);
  } else {
    console.log(`❌ NAP Test Case ${idx + 1} Failed!`);
    console.log(`   Text: "${tc.text}"`);
    console.log(`   NAP: Got "${nap}", Expected "${tc.expectedNap}"`);
    failed++;
  }
});

console.log('\n--- STARTING EVENT TIME EXTRACTION TESTS ---');
const timeTestCases = [
  {
    payload: {
      event_name: 'ONU FHTT8c3a91bf: Loss of Signal',
      trigger_description: 'Problem started at 15:30:00 on 2026.07.27'
    },
    expectedTime: '2026-07-27 15:30:00'
  },
  {
    payload: {
      clock: 1772123456
    },
    expectedTime: '2026-02-23 04:30:56'
  },
  {
    payload: {
      event_time: '18:45:00',
      event_date: '2026-08-01'
    },
    expectedTime: '2026-08-01 18:45:00'
  },
  {
    payload: 'Alerta de fibra a las 14:20:10 el dia 2026.08.03',
    expectedTime: '2026-08-03 14:20:10'
  }
];

timeTestCases.forEach((tc, idx) => {
  let expected = tc.expectedTime;
  if (tc.payload.clock) {
    const d = new Date(tc.payload.clock * 1000);
    const actualTime = extractEventTime(tc.payload);
    const hasCorrectFormat = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(actualTime);
    if (hasCorrectFormat) {
      console.log(`✅ Time Test Case ${idx + 1} Passed (Timestamp formatted: ${actualTime})`);
    } else {
      console.log(`❌ Time Test Case ${idx + 1} Failed! Got format: "${actualTime}"`);
      failed++;
    }
  } else {
    const actualTime = extractEventTime(tc.payload);
    if (actualTime === expected) {
      console.log(`✅ Time Test Case ${idx + 1} Passed`);
    } else {
      console.log(`❌ Time Test Case ${idx + 1} Failed!`);
      console.log(`   Payload: ${JSON.stringify(tc.payload)}`);
      console.log(`   Time: Got "${actualTime}", Expected "${expected}"`);
      failed++;
    }
  }
});

if (failed === 0) {
  console.log('\n🎉 ALL PARSER TESTS PASSED SUCCESSFULLY! 🎉');
  process.exit(0);
} else {
  console.log(`\n😢 ${failed} tests failed.`);
  process.exit(1);
}
