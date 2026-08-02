const { connectLambda, getStore } = require('@netlify/blobs');

const DEFAULTS = {
  shopName: 'MY SHOP',
  shopIcon: '🛒',
  logoImage: '',       // id картинки-логотипа (загружается как товарное фото), пусто = используем shopIcon
  buyUrl: '',           // ссылка для быстрого "Написать о товаре" по одному товару
  socialLinks: [],       // [{label, url}] — любые соцсети/маркетплейсы, показываются в профиле
  supportUrl: '',
  channelId: '',
  miniAppLink: '',
  orderChatId: '',       // куда слать уведомления о новых заказах (личный чат/группа менеджера)
  checkout: {
    askPhone: false,
    askContact: false,
    askEmail: false,
    paymentMethods: [],
    deliveryMethods: [],
  },
};

exports.handler = async (event) => {
  connectLambda(event);
  const store = getStore('shop');

  let settings = await store.get('settings', { type: 'json' });
  if (!settings) {
    settings = DEFAULTS;
    await store.setJSON('settings', settings);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  };
};
