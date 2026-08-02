'use strict';
// Бот на long polling. Сознательно не webhook: вебхуку нужен публичный HTTPS
// с валидным сертификатом ДО первого запуска, а long polling работает сразу
// после `systemctl start` — даже пока домен ещё не приехал. Один процесс с
// веб-сервером, отдельный демон поднимать не нужно.

const crypto = require('node:crypto');
const store = require('./store');
const { tgApi, esc, BOT_TOKEN } = require('./telegram');

let offset = 0;
let running = false;

function settings() { return require('./settings').sanitize(store.read('settings', {})); }

function fill(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

function menuKeyboard(s) {
  const link = s.channel.miniAppLink;
  const rows = [];
  // web_app-кнопку Telegram принимает только с https-URL; t.me/bot/app —
  // это уже готовая ссылка на мини-апп, её кладём как обычный url
  if (link) rows.push([{ text: s.bot.buttonText, url: link }]);
  if (s.manager.supportUrl || s.manager.buyUrl) {
    const raw = s.manager.supportUrl || s.manager.buyUrl;
    rows.push([{ text: '💬 Написать менеджеру', url: normalize(raw) }]);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

function normalize(v) {
  const t = String(v || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith('@')) return 'https://t.me/' + t.slice(1);
  if (/^[a-zA-Z0-9_]{5,}$/.test(t)) return 'https://t.me/' + t;
  return t;
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;

  const s = settings();
  if (!s.bot.enabled) return;

  const chatId = msg.chat.id;
  const name = esc(msg.from && msg.from.first_name || 'друг');
  const text = String(msg.text || '').trim();

  // новый пользователь — опционально дёргаем менеджера
  const users = store.read('users', {});
  if (!users[chatId]) {
    users[chatId] = { id: chatId, username: msg.from && msg.from.username || '', name, firstSeen: Date.now() };
    store.write('users', users);
    if (s.notify.enabled && s.notify.onNewUser) {
      const who = msg.from && msg.from.username ? `@${esc(msg.from.username)}` : `<code>${chatId}</code>`;
      await notifyManagers(s, `👤 Новый пользователь бота: ${name} ${who}`);
    }
  }

  if (text === '/start' || text.startsWith('/start ')) {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: fill(s.bot.welcomeText, { name, shop: esc(s.brand.shopName) }),
      parse_mode: 'HTML',
      reply_markup: menuKeyboard(s),
    });
    return;
  }

  if (text === '/help' || text === '/support') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: fill(s.bot.helpText, { name, shop: esc(s.brand.shopName) }),
      parse_mode: 'HTML',
      reply_markup: menuKeyboard(s),
    });
    return;
  }

  if (text === '/shop' || text === '/menu' || text === '/catalog') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `🛍 ${esc(s.brand.shopName)}`,
      parse_mode: 'HTML',
      reply_markup: menuKeyboard(s),
    });
    return;
  }

  if (text === '/id') {
    await tgApi('sendMessage', { chat_id: chatId, text: `Ваш chat_id: <code>${chatId}</code>`, parse_mode: 'HTML' });
    return;
  }

  // всё остальное — пересылаем менеджеру как вопрос от клиента
  if (text && s.notify.enabled && s.notify.onInquiry) {
    const who = msg.from && msg.from.username ? `@${esc(msg.from.username)}` : `<code>${chatId}</code>`;
    await notifyManagers(s, `💬 Сообщение боту от ${name} ${who}:\n\n${esc(text)}`);
  }
}

async function notifyManagers(s, text) {
  for (const id of s.notify.chatIds) {
    await tgApi('sendMessage', {
      chat_id: id, text, parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: s.notify.silent,
    });
  }
}

async function poll() {
  while (running) {
    try {
      const res = await tgApi('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      if (res && res.ok) {
        for (const u of res.result) {
          offset = u.update_id + 1;
          try { await handleUpdate(u); } catch (e) { console.error('[bot] update failed:', e.message); }
        }
      } else if (res && /conflict/i.test(res.description || '')) {
        // где-то ещё запущен второй экземпляр или висит вебхук
        console.error('[bot]', res.description, '— снимаю вебхук и продолжаю');
        await tgApi('deleteWebhook', {});
        await sleep(5000);
      } else if (res && !res.ok) {
        console.error('[bot] getUpdates:', res.description);
        await sleep(5000);
      }
    } catch (e) {
      console.error('[bot] poll error:', e.message);
      await sleep(5000);
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Секрет вебхука выводим детерминированно из токенов, чтобы не заводить ещё одну
// переменную окружения: Telegram шлёт его в заголовке X-Telegram-Bot-Api-Secret-Token,
// и без этой проверки любой желающий мог бы слать боту поддельные апдейты POST-запросом.
function webhookSecret() {
  return crypto.createHash('sha256')
    .update(BOT_TOKEN + '|' + (process.env.ADMIN_TOKEN || ''))
    .digest('hex')
    .slice(0, 48);
}

const COMMANDS = [
  { command: 'start', description: 'Открыть магазин' },
  { command: 'shop', description: 'Каталог' },
  { command: 'support', description: 'Связаться с менеджером' },
  { command: 'id', description: 'Показать мой chat_id' },
];

async function start() {
  if (!BOT_TOKEN) {
    console.warn('[bot] BOT_TOKEN не задан — бот выключен, витрина работает без него');
    return;
  }
  const me = await tgApi('getMe', {});
  if (!me.ok) {
    console.error('[bot] не удалось авторизоваться:', me.description);
    return;
  }
  await tgApi('setMyCommands', { commands: COMMANDS });

  const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const wantWebhook = String(process.env.BOT_MODE || '').toLowerCase() === 'webhook';

  if (wantWebhook) {
    // Telegram принимает вебхук только на портах 443, 80, 88 и 8443 и только по HTTPS
    if (!/^https:\/\//i.test(publicUrl)) {
      console.error('[bot] BOT_MODE=webhook, но PUBLIC_URL не https — откатываюсь на long polling');
    } else {
      const url = `${publicUrl}/api/webhook`;
      const res = await tgApi('setWebhook', {
        url,
        secret_token: webhookSecret(),
        allowed_updates: ['message'],
        max_connections: 40,
      });
      if (res.ok) {
        console.log(`[bot] запущен как @${me.result.username}, режим: webhook → ${url}`);
        return; // апдейты придёт приносить HTTP-сервер, опрос не нужен
      }
      console.error('[bot] setWebhook не удался:', res.description, '— откатываюсь на long polling');
    }
  }

  console.log(`[bot] запущен как @${me.result.username}, режим: long polling`);
  // long polling и вебхук взаимоисключающи — снимаем вебхук, иначе getUpdates не работает
  await tgApi('deleteWebhook', { drop_pending_updates: false });
  running = true;
  poll();
}

function stop() { running = false; }

module.exports = { start, stop, notifyManagers, fill, normalize, handleUpdate, webhookSecret };
