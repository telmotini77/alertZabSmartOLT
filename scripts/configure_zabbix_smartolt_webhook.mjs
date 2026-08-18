import dotenv from 'dotenv';

dotenv.config();

const ZABBIX_MEDIA_TYPE_ID = '16';
const ACTION_ID = '3';
const ADMIN_USER_ID = '1';
const ROUTER_NAME = 'Zabbix SmartOLT Router';
const PREVIOUS_ATTEMPT_NAME = 'Smart OLT Correlator';
const WEBHOOK_RECIPIENT = 'smartolt-correlator';
const WEBHOOK_URL = 'https://alertzabsmartolt.onrender.com/webhook/zabbix';

const apply = process.argv.includes('--apply');
const apiUrl = String(process.env.ZABBIX_API_URL || '').trim();
let auth = String(process.env.ZABBIX_API_TOKEN || '').trim();
let requestId = 1;

if (!apiUrl) throw new Error('ZABBIX_API_URL is required.');

async function rpc(method, params, includeAuth = true) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method,
          params,
          auth: includeAuth ? auth : null,
          id: requestId++
        })
      });
      const body = await response.json();
      if (body.error) {
        const error = new Error(`${method}: ${body.error.message} - ${body.error.data || ''}`.trim());
        error.retryable = false;
        throw error;
      }
      return body.result;
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt === 3) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

function normalizeMedia(media) {
  return {
    mediatypeid: String(media.mediatypeid),
    sendto: Array.isArray(media.sendto) ? media.sendto : [String(media.sendto)],
    active: Number(media.active || 0),
    severity: Number(media.severity || 63),
    period: media.period || '1-7,00:00-24:00'
  };
}

// The existing Zabbix action already sends both PROBLEM and OK events through
// media type 16. Updating that webhook preserves every action operation and
// makes Zabbix deliver its payload to this service before Telegram is used.
const webhookScript = `
try {
  var params = JSON.parse(value);
  var request = new HttpRequest();
  request.addHeader('Content-Type: application/json');

  var payload = {
    event_id: params.EventId,
    event_name: params.EventName || params.Subject || 'Evento de Zabbix',
    trigger_description: params.Message || '',
    host_name: params.HostName || '',
    event_severity: params.Severity || 'Average',
    event_status: String(params.EventValue) === '0' ? 'OK' : 'PROBLEM',
    event_date: params.EventDate || '',
    event_time: params.EventTime || ''
  };

  var response = request.post(params.Url, JSON.stringify(payload));
  var status = request.getStatus();
  if (status < 200 || status >= 300) {
    throw 'API Smart OLT returned HTTP ' + status + ': ' + response;
  }
  return response;
}
catch (error) {
  throw 'Smart OLT webhook delivery failed: ' + error;
}
`.trim();

if (!auth) {
  auth = await rpc('user.login', {
    username: String(process.env.ZABBIX_API_USER || 'Admin').trim(),
    password: String(process.env.ZABBIX_API_PASSWORD || '')
  }, false);
}

const [mediaTypes, actions, users] = await Promise.all([
  rpc('mediatype.get', {
    mediatypeids: [ZABBIX_MEDIA_TYPE_ID],
    output: ['mediatypeid', 'name', 'type', 'status']
  }),
  rpc('action.get', {
    actionids: [ACTION_ID],
    output: ['actionid', 'name'],
    selectOperations: 'extend',
    selectRecoveryOperations: 'extend'
  }),
  rpc('user.get', {
    userids: [ADMIN_USER_ID],
    output: ['userid', 'username'],
    selectMedias: ['mediaid', 'mediatypeid', 'sendto', 'active', 'severity', 'period']
  })
]);

const mediaType = mediaTypes[0];
const action = actions[0];
const user = users[0];
if (!mediaType || !action || !user) {
  throw new Error('Expected Zabbix media type, action, or administrator user was not found.');
}
if (String(mediaType.type) !== '4') {
  throw new Error(`Media type ${ZABBIX_MEDIA_TYPE_ID} is not a Webhook and was left unchanged.`);
}

const sendsProblem = (action.operations || []).some((operation) =>
  String(operation.operationtype) === '0' &&
  String(operation.opmessage?.mediatypeid) === ZABBIX_MEDIA_TYPE_ID &&
  (operation.opmessage_usr || []).some((entry) => String(entry.userid) === ADMIN_USER_ID)
);
const sendsRecovery = (action.recovery_operations || []).some((operation) =>
  String(operation.operationtype) === '0' &&
  String(operation.opmessage?.mediatypeid) === ZABBIX_MEDIA_TYPE_ID &&
  (operation.opmessage_usr || []).some((entry) => String(entry.userid) === ADMIN_USER_ID)
);
if (!sendsProblem || !sendsRecovery) {
  throw new Error('The expected Zabbix problem/recovery operations are not configured for media type 16. No change was made.');
}

const plan = {
  mode: apply ? 'apply' : 'dry-run',
  action: action.name,
  administrator: user.username,
  mediaTypeId: ZABBIX_MEDIA_TYPE_ID,
  mediaType: ROUTER_NAME,
  notifications: ['problem', 'recovery'],
  destination: WEBHOOK_URL
};

if (!apply) {
  console.log(JSON.stringify(plan, null, 2));
} else {
  // Update the existing media type first. The action remains untouched, so
  // problem and recovery delivery cannot drift out of sync.
  await rpc('mediatype.update', {
    mediatypeid: ZABBIX_MEDIA_TYPE_ID,
    name: ROUTER_NAME,
    type: 4,
    status: 0,
    maxattempts: 3,
    attempt_interval: '10s',
    description: 'Envía eventos de Zabbix a AlertZabSmartOLT para corroboración con Smart OLT y entrega por Telegram.',
    script: webhookScript,
    parameters: [
      { name: 'Url', value: WEBHOOK_URL },
      { name: 'EventId', value: '{EVENT.ID}' },
      { name: 'EventName', value: '{EVENT.NAME}' },
      { name: 'EventValue', value: '{EVENT.VALUE}' },
      { name: 'EventDate', value: '{EVENT.DATE}' },
      { name: 'EventTime', value: '{EVENT.TIME}' },
      { name: 'HostName', value: '{HOST.NAME}' },
      { name: 'Severity', value: '{EVENT.SEVERITY}' },
      { name: 'Subject', value: '{ALERT.SUBJECT}' },
      { name: 'Message', value: '{ALERT.MESSAGE}' }
    ]
  });

  // The previous failed migration created a standby media type. It is not
  // used by the action, so remove it only from this user's media list.
  const allTypes = await rpc('mediatype.get', {
    output: ['mediatypeid', 'name'],
    filter: { name: [PREVIOUS_ATTEMPT_NAME] }
  });
  const standbyIds = new Set(allTypes.map((item) => String(item.mediatypeid)));
  const retainedMedia = (user.medias || [])
    .filter((media) => String(media.mediatypeid) !== ZABBIX_MEDIA_TYPE_ID && !standbyIds.has(String(media.mediatypeid)))
    .map(normalizeMedia);
  retainedMedia.push({
    mediatypeid: ZABBIX_MEDIA_TYPE_ID,
    sendto: [WEBHOOK_RECIPIENT],
    active: 0,
    severity: 63,
    period: '1-7,00:00-24:00'
  });
  await rpc('user.update', { userid: ADMIN_USER_ID, medias: retainedMedia });

  console.log(JSON.stringify({
    ...plan,
    result: 'Zabbix now sends problem and recovery events to AlertZabSmartOLT.'
  }, null, 2));
}
