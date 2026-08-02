const { connectLambda, getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;

function json(statusCode, data) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad json' }); }

  const tgUser = validateInitData(body.initData || '');
  if (!tgUser) return json(401, { error: 'invalid initData' });

  connectLambda(event);
  const store = getStore('shop');
  const [products, settings] = await Promise.all([
    store.get('products', { type: 'json' }),
    store.get('settings', { type: 'json' }),
  ]);

  // цены и названия берём из базы, а не от клиента — так их нельзя подделать
  const items = (body.items || []).map(i => {
    const p = (products || []).find(x => x.id === Number(i.id));
    if (!p) return null;
    const qty = Math.max(1, Number(i.qty) || 1);
    return { name: p.name, price: p.price, qty };
  }).filter(Boolean);

  if (!items.length) return json(400, { error: 'корзина пуста' });

  const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const c = body.customer || {};

  const lines = [];
  lines.push('🛒 Новый заказ!');
  lines.push('');
  lines.push(`👤 Клиент: ${c.name || tgUser.first_name || 'Без имени'}`);
  if (c.phone) lines.push(`📱 Телефон: ${c.phone}`);
  if (c.contact) lines.push(`🔗 Профиль: ${c.contact}`);
  if (c.email) lines.push(`✉️ Email: ${c.email}`);
  if (c.address) lines.push(`📍 Адрес: ${c.address}`);
  if (c.delivery) lines.push(`🚚 Доставка: ${c.delivery}`);
  if (c.payment) lines.push(`💳 Оплата: ${c.payment}`);
  lines.push('');
  lines.push('📦 Товары:');
  items.forEach(i => {
    lines.push(`• ${i.name} × ${i.qty} = ${(i.price * i.qty).toLocaleString('ru-RU')} ₽`);
  });
  lines.push('');
  lines.push(`💰 Итого: ${total.toLocaleString('ru-RU')} ₽`);
  lines.push('');
  lines.push(`🕒 Дата: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`);
  if (tgUser.username) lines.push(`💬 Telegram: @${tgUser.username}`);

  const orderText = lines.join('\n');

  if (settings?.orderChatId) {
    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: settings.orderChatId, text: orderText }),
      });
    } catch (e) {
      // не блокируем ответ покупателю, даже если уведомление менеджеру не ушло
    }
  }

  return json(200, { ok: true, orderText });
};
