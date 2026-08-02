const { validateInitData } = require('./_telegram');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'method not allowed' };

  let payload;
  try { payload = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'bad json' }; }

  const user = validateInitData(payload.initData || '');
  if (!user) return { statusCode: 401, body: 'invalid initData' };

  console.log('Новый заказ от', user.id, payload.order);
  // тут: сохранить в БД, уведомить админа и т.д.

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
