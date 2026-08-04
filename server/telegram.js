'use strict';
// Тонкая обёртка над Bot API + проверка подписи initData.
// Никаких зависимостей: fetch и crypto есть в Node 18+ из коробки.

const crypto = require('node:crypto');
const dns = require('node:dns');

// Node 18+ по умолчанию ходит «Happy Eyeballs» и может предпочесть IPv6.
// Если у VPS есть IPv6-адрес, но он никуда не маршрутизируется (типовая история
// у дешёвых хостеров), каждый запрос к Telegram падает с невнятным `fetch failed`.
// Форсируем IPv4 — это самая частая причина обрыва связи с api.telegram.org.
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) { /* Node < 18.4 */ }

const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
// Позволяет увести трафик через свой прокси/зеркало Bot API, если провайдер
// или РКН режут api.telegram.org напрямую. Формат: https://хост (без /bot<token>).
const API_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');

// `fetch failed` сам по себе не говорит ничего — настоящая причина лежит в e.cause.
// Разворачиваем её в человеческий текст, иначе диагностировать блокировку невозможно.
function explainNetworkError(e) {
  const cause = e && e.cause ? e.cause : e;
  const code = cause && (cause.code || cause.errno);
  const hints = {
    ENOTFOUND: 'DNS не резолвит api.telegram.org — проверьте /etc/resolv.conf',
    EAI_AGAIN: 'DNS временно недоступен — проверьте /etc/resolv.conf',
    ECONNREFUSED: 'соединение отклонено — похоже на блокировку провайдером',
    ETIMEDOUT: 'таймаут соединения — трафик к Telegram режется, нужен прокси',
    ECONNRESET: 'соединение сброшено — типичный признак DPI-блокировки',
    UND_ERR_CONNECT_TIMEOUT: 'таймаут соединения — трафик к Telegram режется, нужен прокси',
    CERT_HAS_EXPIRED: 'просроченный корневой сертификат на сервере — обновите ca-certificates',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'подмена TLS-сертификата — трафик перехватывается',
  };
  const detail = hints[code] || (cause && cause.message) || 'причина неизвестна';
  return { code: code || 'UNKNOWN', message: `${detail}${code ? ` (${code})` : ''}` };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tgApi(method, payload, opts = {}) {
  if (!BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN не задан в .env' };

  const attempts = opts.retries === undefined ? 2 : opts.retries;
  let lastErr = null;

  for (let i = 0; i <= attempts; i++) {
    try {
      const res = await fetch(`${API_BASE}/bot${BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
        // без таймаута зависший коннект держал бы бота вечно
        signal: AbortSignal.timeout(opts.timeoutMs || 35000),
      });
      return await res.json();
    } catch (e) {
      lastErr = e;
      // сеть моргнула — пробуем ещё раз с нарастающей паузой
      if (i < attempts) await sleep(1000 * (i + 1));
    }
  }

  const { code, message } = explainNetworkError(lastErr);
  return { ok: false, description: `Нет связи с ${API_BASE}: ${message}`, network: true, code };
}

// Подпись initData — единственный способ доказать, что запрос действительно
// пришёл из Telegram от конкретного пользователя, а не подделан из curl.
function validateInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  // Сортировка строго по алфавиту (по кодовым единицам), как в эталонных примерах
  // документации: localeCompare зависит от локали и может дать другой порядок.
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
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

module.exports = { BOT_TOKEN, API_BASE, tgApi, validateInitData, esc, sendToAll, explainNetworkError };
