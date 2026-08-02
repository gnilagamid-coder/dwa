const { connectLambda, getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const id = event.queryStringParameters?.id;
  if (!id) return { statusCode: 400, body: 'missing id' };

  connectLambda(event);
  const store = getStore('images');
  const result = await store.getWithMetadata(id, { type: 'text' });
  if (!result) return { statusCode: 404, body: 'not found' };

  return {
    statusCode: 200,
    headers: {
      'Content-Type': result.metadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    body: result.data,
    isBase64Encoded: true,
  };
};
