import assert from 'assert';

process.env.NODE_ENV = 'test';
process.env.TELEGRAM_BOT_TOKEN = '123456:test_token';
process.env.TELEGRAM_ADDITIONAL_CHAT_IDS = '-5141632299';

const requests = [];
let failAdditionalChat = false;

globalThis.fetch = async (url, options = {}) => {
  assert.ok(String(url).includes('/sendMessage'));
  const payload = JSON.parse(options.body);
  requests.push(payload);

  if (failAdditionalChat && String(payload.chat_id) === '-5141632299') {
    return {
      ok: false,
      status: 403,
      json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: test failure' })
    };
  }

  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: requests.length, chat: { id: payload.chat_id } } })
  };
};

const { sendNotification } = await import('./services/telegram.js');

const protectedSerial = 'HWTC13824C9E';
const firstResult = await sendNotification(
  '8953554158',
  `Alerta detallada de telecomunicaciones para Cliente Prueba ${protectedSerial}`,
  {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Diagnóstico', url: `https://t.me/test_bot?start=diag_${protectedSerial}` },
        { text: 'Mapa', url: 'https://maps.google.com/?q=-2.9,-78.9' }
      ]]
    }
  }
);
assert.equal(firstResult.delivered, 2);
assert.equal(firstResult.total, 2);
assert.deepEqual(
  requests.map((request) => String(request.chat_id)).sort(),
  ['-5141632299', '8953554158'].sort()
);
requests.slice(0, 2).forEach((request) => {
  assert.ok(!request.text.includes(protectedSerial), 'Operational notifications must redact device serials');
  assert.ok(request.text.includes('[identificador protegido]'));
  assert.ok(request.text.includes('telecomunicaciones'), 'Ordinary long words must not be mistaken for serials');
  assert.equal(request.reply_markup.inline_keyboard[0].length, 1, 'Buttons containing a serial must be removed');
  assert.equal(request.reply_markup.inline_keyboard[0][0].text, 'Mapa');
});

const beforeDeduplicatedDestinations = requests.length;
const deduplicatedResult = await sendNotification('-5141632299', 'Destino sin duplicar');
assert.equal(deduplicatedResult.total, 1);
assert.equal(requests.length, beforeDeduplicatedDestinations + 1);

failAdditionalChat = true;
const partialResult = await sendNotification('8953554158', 'Entrega parcial de prueba');
assert.equal(partialResult.delivered, 1);
assert.equal(partialResult.total, 2);

console.log('Telegram primary + additional chat delivery: PASS');
