const { connectLambda, getStore } = require('@netlify/blobs');

function json(statusCode, data) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

exports.handler = async (event) => {
  if (event.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return json(401, { error: 'unauthorized' });
  }

  connectLambda(event);
  const store = getStore('shop');

  if (event.httpMethod === 'GET') {
    const settings = (await store.get('settings', { type: 'json' })) || {};
    return json(200, settings);
  }

  if (event.httpMethod === 'PUT') {
    const body = JSON.parse(event.body || '{}');
    const current = (await store.get('settings', { type: 'json' })) || {};

    const next = {
      shopName: String(body.shopName ?? current.shopName ?? 'MY SHOP').slice(0, 40),
      shopIcon: String(body.shopIcon ?? current.shopIcon ?? '🛒').slice(0, 4),
      logoImage: String(body.logoImage ?? current.logoImage ?? ''),
      buyUrl: String(body.buyUrl ?? current.buyUrl ?? '').slice(0, 300),
      socialLinks: Array.isArray(body.socialLinks ?? current.socialLinks)
        ? (body.socialLinks ?? current.socialLinks).slice(0, 10).map(l => ({
            label: String(l.label || '').slice(0, 30),
            url: String(l.url || '').slice(0, 300),
          }))
        : [],
      supportUrl: String(body.supportUrl ?? current.supportUrl ?? '').slice(0, 300),
      channelId: String(body.channelId ?? current.channelId ?? '').trim().slice(0, 60),
      miniAppLink: String(body.miniAppLink ?? current.miniAppLink ?? '').trim().slice(0, 200),
      orderChatId: String(body.orderChatId ?? current.orderChatId ?? '').trim().slice(0, 60),
      checkout: {
        askPhone: !!(body.checkout?.askPhone ?? current.checkout?.askPhone),
        askContact: !!(body.checkout?.askContact ?? current.checkout?.askContact),
        askEmail: !!(body.checkout?.askEmail ?? current.checkout?.askEmail),
        paymentMethods: Array.isArray(body.checkout?.paymentMethods ?? current.checkout?.paymentMethods)
          ? (body.checkout?.paymentMethods ?? current.checkout?.paymentMethods).slice(0, 10).map(s => String(s).slice(0, 30))
          : [],
        deliveryMethods: Array.isArray(body.checkout?.deliveryMethods ?? current.checkout?.deliveryMethods)
          ? (body.checkout?.deliveryMethods ?? current.checkout?.deliveryMethods).slice(0, 10).map(s => String(s).slice(0, 30))
          : [],
      },
    };
    await store.setJSON('settings', next);
    return json(200, next);
  }

  return json(405, { error: 'method not allowed' });
};
