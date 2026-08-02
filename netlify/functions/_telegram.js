const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;

function validateInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  const authDate = Number(params.get('auth_date')) * 1000;
  if (Date.now() - authDate > 24 * 60 * 60 * 1000) return null;

  return JSON.parse(params.get('user'));
}

async function tgApi(method, qs = '') {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}?${qs}`);
  return res.json();
}

module.exports = { validateInitData, tgApi, BOT_TOKEN };
