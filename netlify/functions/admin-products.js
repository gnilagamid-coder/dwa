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
  let products = (await store.get('products', { type: 'json' })) || [];

  if (event.httpMethod === 'GET') {
    return json(200, products);
  }

  if (event.httpMethod === 'POST') {
    const body = JSON.parse(event.body || '{}');
    const images = Array.isArray(body.images) ? body.images.filter(Boolean).slice(0, 6) : (body.image ? [body.image] : []);
    const thumbs = Array.isArray(body.thumbs) ? body.thumbs.filter(Boolean).slice(0, 6) : [];
    const product = {
      id: Date.now(),
      images, // до 6 id полноразмерных фото в сторе 'images', порядок = порядок в галерее
      thumbs, // те же фото, но сжатые — используются в сетке товаров на витрине
      name: String(body.name || '').slice(0, 80),
      description: String(body.description || '').slice(0, 300),
      category: String(body.category || '').trim().slice(0, 40),
      price: Number(body.price) || 0,
      stock: (body.stock === '' || body.stock === null || body.stock === undefined) ? null : Math.max(0, Number(body.stock) || 0),
      featured: !!body.featured,
    };
    products.push(product);
    await store.setJSON('products', products);
    return json(200, product);
  }

  if (event.httpMethod === 'PUT') {
    const body = JSON.parse(event.body || '{}');
    if (Array.isArray(body.images)) body.images = body.images.filter(Boolean).slice(0, 6);
    if (Array.isArray(body.thumbs)) body.thumbs = body.thumbs.filter(Boolean).slice(0, 6);
    products = products.map(p => (p.id === body.id ? { ...p, ...body } : p));
    await store.setJSON('products', products);
    return json(200, { ok: true });
  }

  if (event.httpMethod === 'DELETE') {
    const id = Number(event.queryStringParameters?.id);
    products = products.filter(p => p.id !== id);
    await store.setJSON('products', products);
    return json(200, { ok: true });
  }

  return json(405, { error: 'method not allowed' });
};
