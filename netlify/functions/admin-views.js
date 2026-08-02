const { connectLambda, getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'unauthorized' }) };
  }

  connectLambda(event);
  const store = getStore('views');
  const { blobs } = await store.list();

  const counts = {};
  await Promise.all(blobs.map(async (b) => {
    const val = await store.get(b.key, { type: 'text' });
    counts[b.key] = parseInt(val, 10) || 0;
  }));

  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(counts) };
};
