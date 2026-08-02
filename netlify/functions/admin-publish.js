const { connectLambda, getStore } = require('@netlify/blobs');

function json(statusCode, data) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

exports.handler = async (event) => {
  if (event.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return json(401, { error: 'unauthorized' });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const body = JSON.parse(event.body || '{}');
  const productId = Number(body.productId);

  connectLambda(event);
  const store = getStore('shop');
  const [products, settings] = await Promise.all([
    store.get('products', { type: 'json' }),
    store.get('settings', { type: 'json' }),
  ]);

  const product = (products || []).find(p => p.id === productId);
  if (!product) return json(404, { error: 'товар не найден' });

  if (!settings?.channelId) {
    return json(400, { error: 'Сначала укажи канал в настройках (карточка «Канал»)' });
  }
  if (!settings?.miniAppLink) {
    return json(400, { error: 'Сначала укажи ссылку мини-аппа в настройках (карточка «Канал»)' });
  }

  const deepLink = settings.miniAppLink + (settings.miniAppLink.includes('?') ? '&' : '?') + 'startapp=' + product.id;
  const priceStr = Number(product.price).toLocaleString('ru-RU') + ' ₽';
  const caption = [
    product.name,
    product.description || '',
    '',
    `Цена: ${priceStr}`,
  ].filter(Boolean).join('\n').slice(0, 1024); // лимит Telegram на подпись к фото

  const replyMarkup = {
    inline_keyboard: [[{ text: '🛍 Открыть в приложении', url: deepLink }]],
  };

  const host = event.headers['x-forwarded-host'] || event.headers.host;
  const payload = {
    chat_id: settings.channelId,
    reply_markup: replyMarkup,
  };

  let method;
  if (product.images?.[0]) {
    method = 'sendPhoto';
    payload.photo = `https://${host}/api/image?id=${product.images[0]}`;
    payload.caption = caption;
  } else {
    method = 'sendMessage';
    payload.text = caption;
  }

  const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const tgData = await tgRes.json();

  if (!tgData.ok) {
    // самые частые причины: бот не добавлен в канал / не админ канала / неверный @username
    return json(502, { error: tgData.description || 'Telegram отклонил публикацию' });
  }

  return json(200, { ok: true });
};
