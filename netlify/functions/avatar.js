const { validateInitData, tgApi, BOT_TOKEN } = require('./_telegram');

exports.handler = async (event) => {
  const user = validateInitData(event.queryStringParameters?.initData || '');
  if (!user) return { statusCode: 401, body: 'invalid initData' };

  const photos = await tgApi('getUserProfilePhotos', `user_id=${user.id}&limit=1`);
  const fileId = photos?.result?.photos?.[0]?.[0]?.file_id;
  if (!fileId) return { statusCode: 404, body: 'no photo' };

  const file = await tgApi('getFile', `file_id=${fileId}`);
  const filePath = file?.result?.file_path;
  if (!filePath) return { statusCode: 404, body: 'no file' };

  const imgRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
  const buf = Buffer.from(await imgRes.arrayBuffer());

  return {
    statusCode: 200,
    headers: {
      'Content-Type': imgRes.headers.get('content-type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=3600',
    },
    body: buf.toString('base64'),
    isBase64Encoded: true,
  };
};
