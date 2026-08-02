// После деплоя один раз зарегистрируй вебхук:
// curl "https://api.telegram.org/bot<ТОКЕН>/setWebhook?url=https://<твой-сайт>.netlify.app/api/webhook"

const { BOT_TOKEN } = require('./_telegram');

exports.handler = async (event) => {
  let update;
  try { update = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'bad json' }; }

  const msg = update?.message;
  const data = msg?.web_app_data?.data;

  if (data && msg?.chat?.id) {
    try {
      const order = JSON.parse(data);
      const lines = (order.items || []).map(i => `• ${i.name} × ${i.qty}`).join('\n');
      const total = Number(order.total || 0).toLocaleString('ru-RU');
      const text = `Заказ принят ✅\n\n${lines}\n\nИтого: ${total} ₽\n\nМы скоро с вами свяжемся.`;

      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: msg.chat.id, text }),
      });
    } catch (e) {
      // не блокируем ответ Telegram даже если что-то пошло не так с отправкой подтверждения
    }
  }

  return { statusCode: 200, body: 'ok' };
};
