import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { extractNapBox } from './utils/parser.js';

// Mock ONUs details
const mockOnus = [
  {
    onu_id: '1/1/3:12',
    sn: 'FHTT8C3A91BF',
    name: 'Juan Pérez',
    status: 'Offline',
    olt_name: 'OLT-CENTRAL',
    board: '1',
    port: '3',
    address: 'Calle Falsa 123, NAP-04-A, Sector Centro',
    description: 'Caja NAP-04-A splitter principal',
    gps_lat: '-12.0463',
    gps_lng: '-77.0427'
  },
  {
    onu_id: '1/1/3:13',
    sn: 'HWTC12345678',
    name: 'María López',
    status: 'Online',
    olt_name: 'OLT-CENTRAL',
    board: '1',
    port: '3',
    address: 'Av. Siempre Viva 742, NAP-04-A',
    description: 'Caja NAP-04-A splitter principal',
    gps_lat: '-12.0465',
    gps_lng: '-77.0429'
  },
  {
    onu_id: '1/1/3:14',
    sn: 'ZTEG00998877',
    name: 'Carlos Rodríguez',
    status: 'Online',
    olt_name: 'OLT-CENTRAL',
    board: '1',
    port: '3',
    address: 'Pasaje del Pino 4, NAP-04-A',
    description: 'Caja NAP-04-A splitter principal',
    gps_lat: '0.0', // Invalid/Zero coordinate
    gps_lng: '0.0'
  },
  {
    onu_id: '1/1/3:15',
    sn: 'FHTT11112222',
    name: 'Ana Gómez',
    status: 'Online',
    olt_name: 'OLT-CENTRAL',
    board: '1',
    port: '3',
    address: 'Av. Brasil 1500, Sector Jesús María', // No NAP in text
    description: 'Splitter principal sin texto de NAP', // No NAP in text
    odb: 'NAP-04-B', // Directly mapped ODB
    gps_lat: '-12.0800',
    gps_lng: '-77.0500'
  }
];

let mockOdbs = [
  { name: 'NAP-04-A', latitude: '-12.0500', longitude: '-77.0600' },
  { name: 'NAP-04-B', latitude: '-12.0800', longitude: '-77.0500' }
];
let fullOnuRequestCount = 0;

// Set process env variables
process.env.SMARTOLT_SUBDOMAIN = 'testcompany';
process.env.SMARTOLT_API_KEY = 'test_key';
process.env.NAP_CACHE_FILE = path.resolve('data/.nap_cache.test.json');

// Mock global fetch to intercept Smart OLT request
globalThis.fetch = async (url) => {
  if (url.includes('/system/get_odbs')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: true, response: mockOdbs })
    };
  }
  if (url.includes('/onu/get_all_onus_details')) {
    fullOnuRequestCount++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        onus: mockOnus
      })
    };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

console.log('--- STARTING MAP AND CACHE UNIT TESTS ---');

// Load cache service after configuring the isolated test cache path.
const { getCachedNaps, getStatusHistory, updateOnuStatusInCache, syncCacheWithSmartOlt, refreshNapCoordinatesFromSmartOlt, applyOnuStatusSnapshot } =
  await import('./services/cache.js');

async function runTests() {
  try {
    // 1. Test full sync and grouping
    console.log('[1] Running syncCacheWithSmartOlt...');
    await syncCacheWithSmartOlt({ forceRefresh: true });
    
    const naps = getCachedNaps();
    console.log(`    NAPs in cache: ${naps.length}`);
    
    assert.strictEqual(naps.length, 2, 'Should group ONUs into 2 NAPs (NAP-04-A and NAP-04-B)');
    
    const napA = naps.find(n => n.name === 'NAP-04-A');
    const napB = naps.find(n => n.name === 'NAP-04-B');
    
    assert.ok(napA, 'NAP-04-A should exist in cache');
    assert.ok(napB, 'NAP-04-B should exist in cache');
    
    // Check clients grouping count
    assert.strictEqual(napA.totalClients, 3, 'NAP-04-A should have 3 clients');
    assert.strictEqual(napB.totalClients, 1, 'NAP-04-B should have 1 client');
    
    // Check status calculations
    // NAP-04-A has 1 offline (Juan) and 2 online (María, Carlos) -> status should be 'partial'
    assert.strictEqual(napA.status, 'partial', 'NAP-04-A status should be partial');
    assert.strictEqual(napA.onlineClients, 2, 'NAP-04-A should have 2 online clients');
    assert.strictEqual(napA.offlineClients, 1, 'NAP-04-A should have 1 offline client');
    
    // NAP-04-B has 1 online -> status should be 'online'
    assert.strictEqual(napB.status, 'online', 'NAP-04-B status should be online');
    
    // A NAP is physically represented by its ODB/Splitter. Its Smart OLT
    // coordinate must win over the average of its individual ONU locations.
    assert.strictEqual(napA.latitude, -12.0500, 'NAP-04-A must use its Smart OLT Splitter latitude');
    assert.strictEqual(napA.longitude, -77.0600, 'NAP-04-A must use its Smart OLT Splitter longitude');
    assert.strictEqual(napA.coordinate_source, 'smartolt_odb', 'NAP-04-A GPS must identify the Smart OLT Splitter source');
    
    console.log('✅ Grouping, Status and Average GPS Coordinate calculation: PASS');

    // 2. Test status updates in cache (Zabbix triggers simulation)
    console.log('\n[2] Simulating Zabbix alert - Setting FHTT8C3A91BF to Online (Recovery)...');
    
    // Juan Pérez (FHTT8C3A91BF) goes Online
    let updatedNap = updateOnuStatusInCache('FHTT8C3A91BF', 'Online');
    
    assert.ok(updatedNap, 'Should return the updated NAP object');
    assert.strictEqual(updatedNap.status, 'online', 'NAP-04-A status should now be online (all clients online)');
    assert.strictEqual(updatedNap.onlineClients, 3, 'NAP-04-A should have 3 online clients');
    assert.strictEqual(updatedNap.offlineClients, 0, 'NAP-04-A should have 0 offline clients');
    
    console.log('✅ Cache status updates (Recovery): PASS');

    // 3. Test status updates in cache (Zabbix triggers simulation)
    console.log('\n[3] Simulating Zabbix alert - Setting all ONUs in NAP-04-A to Offline...');
    // Set all ONUs in NAP-04-A to Offline
    updateOnuStatusInCache('FHTT8C3A91BF', 'Offline');
    updateOnuStatusInCache('HWTC12345678', 'Offline');
    updatedNap = updateOnuStatusInCache('ZTEG00998877', 'Offline');
    
    assert.strictEqual(updatedNap.status, 'offline', 'NAP-04-A status should now be offline (all clients offline)');
    assert.strictEqual(updatedNap.onlineClients, 0, 'NAP-04-A should have 0 online clients');
    assert.strictEqual(updatedNap.offlineClients, 3, 'NAP-04-A should have 3 offline clients');
    
    console.log('✅ Cache status updates (Total Fall): PASS');

    // 4. NAP GPS comes exclusively from Smart OLT. A NAP without GPS in the
    // inventory must not reuse a stored or CSV position.
    console.log('\n[4] Testing Smart OLT-only GPS policy...');
    const savedNapBCoordinates = { gps_lat: mockOnus[3].gps_lat, gps_lng: mockOnus[3].gps_lng };
    const savedOdbBCoordinates = { ...mockOdbs[1] };
    mockOnus[3].gps_lat = '0.0';
    mockOnus[3].gps_lng = '0.0';
    mockOdbs[1] = { ...mockOdbs[1], latitude: '0.0', longitude: '0.0' };
    await syncCacheWithSmartOlt({ forceRefresh: true });
    const napBWithoutSmartOltGps = getCachedNaps().find(n => n.name === 'NAP-04-B');
    assert.strictEqual(napBWithoutSmartOltGps.latitude, null,
      'A NAP without Smart OLT GPS must not reuse an old stored coordinate');
    assert.strictEqual(napBWithoutSmartOltGps.longitude, null,
      'A NAP without Smart OLT GPS must not reuse an old stored coordinate');
    assert.strictEqual(napBWithoutSmartOltGps.coordinate_source, null,
      'A NAP without Smart OLT GPS must not identify a local coordinate source');
    mockOnus[3].gps_lat = savedNapBCoordinates.gps_lat;
    mockOnus[3].gps_lng = savedNapBCoordinates.gps_lng;
    mockOdbs[1] = savedOdbBCoordinates;
    await syncCacheWithSmartOlt({ forceRefresh: true });
    const refreshedNapB = getCachedNaps().find(n => n.name === 'NAP-04-B');
    assert.strictEqual(refreshedNapB.latitude, -12.0800, 'NAP GPS must be restored from Smart OLT');
    assert.strictEqual(refreshedNapB.longitude, -77.0500, 'NAP GPS must be restored from Smart OLT');
    console.log('✅ Smart OLT-only GPS policy: PASS');

    // A process restart must be able to refresh ODB locations without making
    // another full ONU inventory request (Smart OLT rate-limits that endpoint).
    console.log('\n[4.1] Refreshing Splitter GPS without a full ONU inventory...');
    const onuRequestsBeforeGpsRefresh = fullOnuRequestCount;
    mockOdbs[0] = { ...mockOdbs[0], latitude: '-12.0510', longitude: '-77.0610' };
    await refreshNapCoordinatesFromSmartOlt({ forceRefresh: true });
    const napAAfterOdbOnlyRefresh = getCachedNaps().find(n => n.name === 'NAP-04-A');
    assert.strictEqual(fullOnuRequestCount, onuRequestsBeforeGpsRefresh,
      'ODB coordinate refresh must not call the rate-limited full ONU inventory');
    assert.strictEqual(napAAfterOdbOnlyRefresh.latitude, -12.0510,
      'Cached NAP GPS must update from the ODB-only Smart OLT request');
    assert.strictEqual(napAAfterOdbOnlyRefresh.coordinate_source, 'smartolt_odb');
    mockOdbs[0] = { ...mockOdbs[0], latitude: '-12.0500', longitude: '-77.0600' };
    console.log('✅ Splitter-only GPS refresh avoids the full ONU inventory: PASS');

    // 5. A full OLT snapshot must be applied before deciding whether a NAP
    // has lost signal completely.
    console.log('\n[5] Applying a complete Smart OLT status snapshot...');
    updateOnuStatusInCache('HWTC12345678', 'Online');
    const snapshot = mockOnus.map((onu) => ({
      ...onu,
      status: onu.odb === 'NAP-04-B' ? 'Online' : 'Offline'
    }));
    const changedNaps = applyOnuStatusSnapshot(snapshot);
    const snapNapA = getCachedNaps().find(n => n.name === 'NAP-04-A');
    assert.ok(changedNaps.some(n => n.name === 'NAP-04-A'), 'Snapshot should mark NAP-04-A as changed');
    assert.strictEqual(snapNapA.status, 'offline', 'Full snapshot should mark NAP-04-A as fully offline');
    assert.strictEqual(snapNapA.offlineClients, 3, 'Full snapshot should count every affected ONU');
    const napSnapshotHistory = getStatusHistory(100).find((item) =>
      item.napName === 'NAP-04-A' && String(item.sn || '').startsWith('NAP:')
    );
    assert.ok(napSnapshotHistory, 'A Smart OLT snapshot status transition must appear in the map history');
    assert.ok(napSnapshotHistory.newStatus.includes('caída total'), 'The history must explain the NAP-level transition');
    assert.ok(!napSnapshotHistory.onuName.includes('FHTT'), 'NAP history must identify affected clients without device serials');

    // Smart OLT may omit previously cached/decommissioned ONUs from a scan.
    // Missing snapshot entries must not abort the complete radar cycle.
    assert.doesNotThrow(
      () => applyOnuStatusSnapshot(snapshot.slice(0, 1)),
      'A partial Smart OLT snapshot must safely ignore unmatched cached clients'
    );

    const recoverySnapshot = mockOnus.map((onu) => ({ ...onu, status: 'Online' }));
    applyOnuStatusSnapshot(recoverySnapshot);
    const napEventsAfterRecovery = getStatusHistory(100).filter((item) =>
      item.napName === 'NAP-04-A' && String(item.sn || '').startsWith('NAP:')
    );
    assert.ok(napEventsAfterRecovery.some((item) => item.failureType === 'recovery'),
      'A full NAP recovery must also be documented in map history');
    assert.ok(napEventsAfterRecovery.every((item) => item.resolved),
      'A full NAP recovery must resolve the preceding NAP history incident');
    console.log('Full scan snapshot and total NAP outage calculation: PASS');

    // Clean up cache file generated during test
    const cacheFile = process.env.NAP_CACHE_FILE;
    if (fs.existsSync(cacheFile)) {
      fs.unlinkSync(cacheFile);
    }
    
    console.log('\n🎉 ALL MAP AND CACHE SERVICE TESTS PASSED SUCCESSFULLY! 🎉');
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  }
}

runTests();
