const { connectLambda, getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'method not allowed' };

  try {
    const body = JSON.parse(event.body || '{}');
    const id = String(Number(body.id));
    if (id === 'NaN') return { statusCode: 200, body: 'ok' };

    connectLambda(event);
    const store = getStore('views');
    const current = await store.get(id, { type: 'text' });
    const next = (parseInt(current, 10) || 0) + 1;
    await store.set(id, String(next));
  } catch (e) {
    // счётчик просмотров не критичен — молча игнорируем сбои
  }

  return { statusCode: 200, body: 'ok' };
};
