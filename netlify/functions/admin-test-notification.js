const { connectLambda, getStore } = require('@netlify/blobs');

const BOT_TOKEN = process.env.BOT_TOKEN;

function json(statusCode, data) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

exports.handler = async (event) => {
  if (event.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return json(401, { error: 'unauthorized' });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  connectLambda(event);
  const store = getStore('shop');
  const settings = await store.get('settings', { type: 'json' });

  if (!settings?.orderChatId) {
    return json(400, { error: 'Сначала укажи chat_id в настройках заказа' });
  }

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: settings.orderChatId, text: '🔔 Тестовое уведомление — если оно пришло, всё настроено верно.' }),
  });
  const data = await res.json();

  if (!data.ok) {
    // самые частые причины: пользователь ни разу не писал боту (Forbidden: bot can't
    // initiate conversation with a user), либо неверный chat_id
    return json(502, { error: data.description || 'Telegram отклонил отправку' });
  }

  return json(200, { ok: true });
};
