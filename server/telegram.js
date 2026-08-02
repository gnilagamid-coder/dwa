'use strict';
// Тонкая обёртка над Bot API + проверка подписи initData.
// Никаких зависимостей: fetch и crypto есть в Node 18+ из коробки.

const crypto = require('node:crypto');

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();

async function tgApi(method, payload) {
  if (!BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN не задан в .env' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, description: 'Нет связи с api.telegram.org: ' + e.message };
  }
}

// Подпись initData — единственный способ доказать, что запрос действительно
// пришёл из Telegram от конкретного пользователя, а не подделан из curl.
function validateInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // timingSafeEqual требует одинаковой длины — иначе бросает
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get('auth_date')) * 1000;
  if (!authDate || Date.now() - authDate > 24 * 60 * 60 * 1000) return null;

  try { return JSON.parse(params.get('user')); } catch (e) { return null; }
}

// Telegram ломается на «сыром» < и & в HTML-режиме, поэтому экранируем.
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendToAll(chatIds, text, opts = {}) {
  const results = [];
  for (const chatId of chatIds || []) {
    if (!chatId) continue;
    results.push(await tgApi('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: !!opts.silent,
      ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
    }));
  }
  return results;
}

module.exports = { BOT_TOKEN, tgApi, validateInitData, esc, sendToAll };
