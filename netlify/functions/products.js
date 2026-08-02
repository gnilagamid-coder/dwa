const { connectLambda, getStore } = require('@netlify/blobs');

// Каталог стартует пустым — это шаблон под конкретного продавца,
// он сам добавит свои товары через /admin.html.
const DEFAULTS = [];

exports.handler = async (event) => {
  connectLambda(event);
  const store = getStore('shop');

  let products = await store.get('products', { type: 'json' });
  if (!products) {
    products = DEFAULTS;
    await store.setJSON('products', products);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(products),
  };
};
