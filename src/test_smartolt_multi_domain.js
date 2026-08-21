import assert from 'assert';

process.env.NODE_ENV = 'test';
process.env.SMARTOLT_ACCOUNTS_JSON = JSON.stringify([
  { id: 'norte', subdomain: 'norte-red', apiKey: 'token-norte' },
  { id: 'sur', subdomain: 'sur-red', apiKey: 'token-sur' }
]);

const requestedHosts = [];

globalThis.fetch = async (url) => {
  const parsed = new URL(String(url));
  const host = parsed.hostname;
  requestedHosts.push(host);
  const account = host.startsWith('norte-') ? 'norte' : 'sur';
  const serial = account === 'norte' ? 'NORTE0001' : 'SUR0001';
  const externalId = account === 'norte' ? 'onu-norte' : 'onu-sur';

  if (parsed.pathname.endsWith('/onu/get_onus_statuses')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        response: [{
          sn: serial,
          name: `Cliente ${account}`,
          unique_external_id: externalId,
          olt_id: '2', // Intentionally shared between domains.
          board: '1',
          port: '1',
          status: 'Online'
        }]
      })
    };
  }

  if (parsed.pathname.endsWith('/onu/get_all_onus_details')) {
    const requestedSn = parsed.searchParams.get('sn');
    const onus = requestedSn && requestedSn !== serial
      ? []
      : [{
          sn: serial,
          name: `Cliente ${account}`,
          external_id: externalId,
          odb_name: `NAP-${account.toUpperCase()}`,
          olt_id: '2',
          olt_name: `OLT ${account}`,
          board: '1',
          port: '1',
          status: 'Online'
        }];
    return { ok: true, status: 200, json: async () => ({ status: true, onus }) };
  }

  if (parsed.pathname.endsWith('/system/get_odbs')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: true,
        response: [{
          name: `NAP-${account.toUpperCase()}`,
          latitude: account === 'norte' ? '-2.90' : '-2.91',
          longitude: '-78.97'
        }]
      })
    };
  }

  if (parsed.pathname.endsWith('/onu/get_onu_status/onu-sur')) {
    assert.strictEqual(host, 'sur-red.smartolt.com', 'Live status must use the ONU account domain.');
    return { ok: true, status: 200, json: async () => ({ status: true, onu_status: 'Online' }) };
  }

  throw new Error(`Unexpected Smart OLT request: ${url}`);
};

const {
  getSmartOltAccounts,
  fetchAllOnuStatuses,
  fetchAllOnus,
  fetchAllOdbs,
  findOnuBySn,
  getOnuStatus
} = await import('./services/smartOlt.js');
const { initDb, dbGetAllNaps, dbSaveNap } = await import('./services/db.js');

try {
  assert.deepStrictEqual(getSmartOltAccounts(), [
    { id: 'norte', subdomain: 'norte-red' },
    { id: 'sur', subdomain: 'sur-red' }
  ]);

  const statuses = await fetchAllOnuStatuses();
  assert.strictEqual(statuses.length, 2, 'The bulk radar must combine all configured domains.');
  assert.deepStrictEqual(statuses.map((onu) => onu.smartolt_account_id).sort(), ['norte', 'sur']);
  assert.strictEqual(new Set(statuses.map((onu) => `${onu.smartolt_account_id}:${onu.olt_id}`)).size, 2,
    'An OLT id shared by two domains must remain distinct.');

  const onus = await fetchAllOnus();
  assert.strictEqual(onus.length, 2, 'Metadata sync must include every configured domain.');

  const odbs = await fetchAllOdbs();
  assert.strictEqual(odbs.length, 2, 'Splitter GPS metadata must include every configured domain.');
  assert.deepStrictEqual(odbs.map((odb) => odb.smartolt_account_id).sort(), ['norte', 'sur']);

  const onu = await findOnuBySn('SUR0001');
  assert.strictEqual(onu.smartolt_account_id, 'sur');
  assert.strictEqual(onu.external_id, 'onu-sur');

  const live = await getOnuStatus(onu.external_id, onu.smartolt_account_id);
  assert.strictEqual(live.smartolt_account_id, 'sur');
  assert.ok(requestedHosts.includes('norte-red.smartolt.com'));
  assert.ok(requestedHosts.includes('sur-red.smartolt.com'));

  // The same visible NAP code may exist in two SmartOLT domains. Persisted
  // storage must retain both entries so a process restart cannot drop an OLT
  // from either map or the alert correlation cache.
  await initDb();
  await Promise.all([
    dbSaveNap({
      name: 'NAP-CODE-SHARED-TEST', smartolt_account_id: 'norte', olt_id: '2', olt_name: 'OLT norte',
      board: '1', port: '1', totalClients: 1, onlineClients: 1, offlineClients: 0, status: 'online', clients: []
    }),
    dbSaveNap({
      name: 'NAP-CODE-SHARED-TEST', smartolt_account_id: 'sur', olt_id: '2', olt_name: 'OLT sur',
      board: '1', port: '1', totalClients: 1, onlineClients: 1, offlineClients: 0, status: 'online', clients: []
    })
  ]);
  const persistedSharedNaps = (await dbGetAllNaps())
    .filter((nap) => nap.name === 'NAP-CODE-SHARED-TEST');
  assert.strictEqual(persistedSharedNaps.length, 2,
    'Identical NAP codes from distinct SmartOLT domains must not overwrite each other in SQLite.');
  assert.deepStrictEqual(
    persistedSharedNaps.map((nap) => nap.smartolt_account_id).sort(),
    ['norte', 'sur']
  );

  console.log('Smart OLT multi-domain account separation: PASS');
} catch (error) {
  console.error('Smart OLT multi-domain account separation: FAIL', error);
  process.exitCode = 1;
}
