const { connectLambda, getStore } = require('@netlify/blobs');

function json(statusCode, data) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

exports.handler = async (event) => {
  if (event.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return json(401, { error: 'unauthorized' });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  const body = JSON.parse(event.body || '{}');
  const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(body.dataUrl || '');
  if (!match) return json(400, { error: 'expected dataUrl: data:image/...;base64,...' });

  const [, contentType, base64] = match;
  // ограничение ~1.5MB после base64-декодирования, чтобы не упереться в лимит пейлоада функции
  if (base64.length > 2_000_000) return json(413, { error: 'image too large, resize before upload' });

  connectLambda(event);
  const store = getStore('images');
  const id = 'img_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  await store.set(id, base64, { metadata: { contentType } });

  return json(200, { id });
};
