'use strict';
// Весь бэкенд магазина в одном процессе: статика + JSON API + телеграм-бот.
// Зависимостей нет вообще — нужен только Node 18+.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Мини-загрузчик .env — чтобы `node server/index.js` работал и без systemd,
// который в проде подставляет переменные сам через EnvironmentFile.
(function loadEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* нет .env — значит переменные пришли из окружения */ }
})();

const store = require('./store');
const { sanitize } = require('./settings');
const { tgApi, validateInitData, esc, BOT_TOKEN } = require('./telegram');
const bot = require('./bot');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 8 * 1024 * 1024; // хватает на dataURL-картинку до ~6 МБ

if (!ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN не задан в .env — админка была бы открыта всем. Выхожу.');
  process.exit(1);
}

// ---------- утилиты ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
};

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

// Сравнение токена без утечки времени. Сравниваем именно sha256-дайджесты:
// timingSafeEqual требует равной длины буферов и бросает исключение при разной,
// а токен может быть любым — в том числе кириллицей, где длина в байтах ≠ длине строки.
const ADMIN_HASH = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
function tokenOk(req) {
  const given = String(req.headers['x-admin-token'] || '');
  const hash = crypto.createHash('sha256').update(given).digest();
  return crypto.timingSafeEqual(hash, ADMIN_HASH);
}

// простейший rate limit по IP — чтобы форму заказа нельзя было залить спамом
const hits = new Map();
function rateLimit(ip, max, windowMs) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > windowMs) { hits.set(ip, { start: now, n: 1 }); return true; }
  rec.n += 1;
  return rec.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > 600000) hits.delete(k); }, 600000).unref();

function getSettings() { return sanitize(store.read('settings', {})); }

// на витрину не отдаём то, что клиенту знать незачем
function publicSettings(s) {
  const { notify, ...rest } = s;
  return { ...rest, notifyEnabled: notify.enabled };
}

const money = (n, s) => {
  const v = Number(n).toLocaleString(s.advanced.locale || 'ru-RU');
  return s.commerce.currencyPosition === 'before' ? `${s.commerce.currency}${v}` : `${v} ${s.commerce.currency}`;
};

// ---------- статика ----------
async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }

  try {
    const stat = await fsp.stat(full);
    if (stat.isDirectory()) throw new Error('dir');
    const ext = path.extname(full).toLowerCase();
    // html не кэшируем — иначе после правки настроек клиент час видит старую витрину
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl, 'Content-Length': stat.size });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

// ---------- заказы ----------
function buildOrderText(s, items, c, tgUser) {
  const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const L = [];
  L.push('🛒 <b>Новый заказ</b>');
  L.push('');
  L.push(`👤 Клиент: ${esc(c.name || (tgUser && tgUser.first_name) || 'Без имени')}`);
  if (c.phone) L.push(`📱 Телефон: ${esc(c.phone)}`);
  if (c.contact) L.push(`🔗 Профиль: ${esc(c.contact)}`);
  if (c.email) L.push(`✉️ Email: ${esc(c.email)}`);
  if (c.address) L.push(`📍 Адрес: ${esc(c.address)}`);
  if (c.delivery) L.push(`🚚 Доставка: ${esc(c.delivery)}`);
  if (c.payment) L.push(`💳 Оплата: ${esc(c.payment)}`);
  if (c.comment) L.push(`📝 Комментарий: ${esc(c.comment)}`);
  L.push('');
  L.push('📦 <b>Товары:</b>');
  items.forEach(i => L.push(`• ${esc(i.name)} × ${i.qty} = ${money(i.price * i.qty, s)}`));
  L.push('');
  L.push(`💰 <b>Итого: ${money(total, s)}</b>`);
  L.push(`🕒 ${new Date().toLocaleString(s.advanced.locale, { timeZone: s.advanced.timezone })}`);
  if (s.notify.includeCustomerLink && tgUser) {
    L.push(tgUser.username ? `💬 <a href="https://t.me/${esc(tgUser.username)}">@${esc(tgUser.username)}</a>` : `💬 id: <code>${tgUser.id}</code>`);
  }
  return { text: L.join('\n'), total };
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

  // ===== публичное =====
  if (p === '/api/settings' && method === 'GET') {
    return json(res, 200, publicSettings(getSettings()));
  }

  if (p === '/api/products' && method === 'GET') {
    const s = getSettings();
    let list = store.read('products', []);
    if (s.catalog.hideSoldOut) list = list.filter(x => x.stock !== 0);
    return json(res, 200, list);
  }

  if (p === '/api/image' && method === 'GET') {
    const file = store.imagePath(url.searchParams.get('id'));
    if (!file) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const stat = await fsp.stat(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'image/jpeg',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': stat.size,
    });
    return fs.createReadStream(file).pipe(res);
  }

  if (p === '/api/avatar' && method === 'GET') {
    const user = validateInitData(url.searchParams.get('initData') || '');
    if (!user) { res.writeHead(401); return res.end('invalid initData'); }
    const photos = await tgApi('getUserProfilePhotos', { user_id: user.id, limit: 1 });
    const fileId = photos && photos.result && photos.result.photos && photos.result.photos[0] && photos.result.photos[0][0] && photos.result.photos[0][0].file_id;
    if (!fileId) { res.writeHead(404); return res.end('no photo'); }
    const file = await tgApi('getFile', { file_id: fileId });
    const fp = file && file.result && file.result.file_path;
    if (!fp) { res.writeHead(404); return res.end('no file'); }
    const img = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fp}`);
    const buf = Buffer.from(await img.arrayBuffer());
    res.writeHead(200, { 'Content-Type': img.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
    return res.end(buf);
  }

  // Приём апдейтов, когда включён BOT_MODE=webhook. Без сверки секрета этот
  // адрес был бы открытым приёмником: любой мог бы прислать поддельное сообщение
  // «от клиента» и дёрнуть менеджера. Секрет Telegram кладёт в заголовок сам.
  if (p === '/api/webhook' && method === 'POST') {
    const given = String(req.headers['x-telegram-bot-api-secret-token'] || '');
    const expected = bot.webhookSecret();
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    if (!crypto.timingSafeEqual(a, b)) {
      // 401 без тела: Telegram повторит запрос, но чужой не поймёт, что не так
      res.writeHead(401); return res.end();
    }
    let update;
    try { update = await readBody(req); } catch (e) { res.writeHead(200); return res.end('ok'); }
    // Отвечаем 200 сразу, обработку делаем следом: если ответить не-2XX или
    // затянуть, Telegram будет слать тот же апдейт повторно.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    bot.handleUpdate(update).catch(e => console.error('[webhook] update failed:', e.message));
    return;
  }

  if (p === '/api/track-view' && method === 'POST') {
    try {
      const body = await readBody(req);
      const id = String(Number(body.id));
      if (id !== 'NaN') {
        const views = store.read('views', {});
        views[id] = (views[id] || 0) + 1;
        store.write('views', views);
      }
    } catch (e) { /* счётчик не критичен */ }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/checkout' && method === 'POST') {
    if (!rateLimit(ip, 10, 60000)) return json(res, 429, { error: 'слишком много запросов, подождите минуту' });
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }

    const s = getSettings();
    const tgUser = validateInitData(body.initData || '');
    // без валидного initData принимаем заказ только если мини-апп открыт вне Telegram (тест),
    // но помечаем это в уведомлении — менеджер должен видеть разницу
    const products = store.read('products', []);

    const items = (body.items || []).map(i => {
      const prod = products.find(x => x.id === Number(i.id));
      if (!prod) return null;
      const qty = Math.max(1, Math.min(999, Number(i.qty) || 1));
      return { id: prod.id, name: prod.name, price: Number(prod.price) || 0, qty };
    }).filter(Boolean);

    if (!items.length) return json(res, 400, { error: 'корзина пуста' });

    const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
    if (s.commerce.minOrder && total < s.commerce.minOrder) {
      return json(res, 400, { error: `Минимальный заказ — ${money(s.commerce.minOrder, s)}` });
    }

    const c = body.customer || {};
    const built = buildOrderText(s, items, c, tgUser);
    let text = built.text;
    if (!tgUser) text += '\n\n⚠️ <i>Заказ оформлен вне Telegram — личность не подтверждена</i>';

    const order = {
      id: Date.now(),
      at: new Date().toISOString(),
      items, total, customer: c,
      user: tgUser ? { id: tgUser.id, username: tgUser.username || '', name: tgUser.first_name || '' } : null,
      status: 'new',
    };
    const orders = store.read('orders', []);
    orders.unshift(order);
    store.write('orders', orders.slice(0, 500));

    // списываем остатки, если они заданы
    let changed = false;
    for (const i of items) {
      const prod = products.find(x => x.id === i.id);
      if (prod && typeof prod.stock === 'number') { prod.stock = Math.max(0, prod.stock - i.qty); changed = true; }
    }
    if (changed) store.write('products', products);

    if (s.notify.enabled && s.notify.onOrder) {
      await bot.notifyManagers(s, text).catch(() => {});
    }
    // копия покупателю в чат с ботом
    if (s.bot.notifyCustomer && tgUser) {
      await tgApi('sendMessage', {
        chat_id: tgUser.id,
        text: bot.fill(s.bot.customerReceiptText, { order: built.text.replace(/<[^>]+>/g, ''), name: esc(tgUser.first_name || '') }),
        parse_mode: 'HTML',
      }).catch(() => {});
    }

    return json(res, 200, { ok: true, orderId: order.id, orderText: built.text.replace(/<[^>]+>/g, '') });
  }

  // «написал менеджеру» — фиксируем как лид, чтобы продавец видел интерес
  if (p === '/api/inquiry' && method === 'POST') {
    if (!rateLimit(ip, 20, 60000)) return json(res, 429, { error: 'too many requests' });
    let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
    const s = getSettings();
    const tgUser = validateInitData(body.initData || '');
    if (s.notify.enabled && s.notify.onInquiry) {
      const who = tgUser
        ? (tgUser.username ? `@${esc(tgUser.username)}` : `id <code>${tgUser.id}</code>`)
        : 'гость';
      const what = esc(String(body.subject || '').slice(0, 300));
      await bot.notifyManagers(s, `👀 <b>Интерес к товару</b>\n\n${what}\n\nОт: ${who}`).catch(() => {});
    }
    return json(res, 200, { ok: true });
  }

  // ===== админка =====
  if (p.startsWith('/api/admin/')) {
    if (!rateLimit('admin:' + ip, 60, 60000)) return json(res, 429, { error: 'too many requests' });
    if (!tokenOk(req)) return json(res, 401, { error: 'unauthorized' });

    if (p === '/api/admin/settings') {
      if (method === 'GET') return json(res, 200, getSettings());
      if (method === 'PUT') {
        let body; try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
        const next = sanitize(require('./settings').mergeDeep(store.read('settings', {}), body));
        store.write('settings', next);
        return json(res, 200, next);
      }
    }

    if (p === '/api/admin/products') {
      let products = store.read('products', []);

      if (method === 'GET') return json(res, 200, products);

      if (method === 'POST') {
        let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
        const product = normalizeProduct({ ...b, id: Date.now() });
        if (!product.name) return json(res, 400, { error: 'нужно название' });
        products.push(product);
        store.write('products', products);
        return json(res, 200, product);
      }

      if (method === 'PUT') {
        let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
        const idx = products.findIndex(x => x.id === Number(b.id));
        if (idx === -1) return json(res, 404, { error: 'не найден' });
        products[idx] = normalizeProduct({ ...products[idx], ...b, id: products[idx].id });
        store.write('products', products);
        return json(res, 200, products[idx]);
      }

      if (method === 'DELETE') {
        const id = Number(url.searchParams.get('id'));
        const victim = products.find(x => x.id === id);
        if (victim) {
          // чистим картинки, иначе диск постепенно забивается мусором
          for (const img of [...(victim.images || []), ...(victim.thumbs || [])]) await store.deleteImage(img);
        }
        store.write('products', products.filter(x => x.id !== id));
        return json(res, 200, { ok: true });
      }
    }

    // изменение порядка товаров в каталоге
    if (p === '/api/admin/reorder' && method === 'POST') {
      let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const order = (b.ids || []).map(Number);
      const products = store.read('products', []);
      const sorted = [...products].sort((a, z) => {
        const ia = order.indexOf(a.id), iz = order.indexOf(z.id);
        return (ia === -1 ? 1e9 : ia) - (iz === -1 ? 1e9 : iz);
      });
      store.write('products', sorted);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/admin/upload' && method === 'POST') {
      let b; try { b = await readBody(req); } catch (e) { return json(res, 413, { error: 'файл слишком большой' }); }
      const m = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(b.dataUrl || '');
      if (!m) return json(res, 400, { error: 'ожидается dataUrl вида data:image/...;base64,...' });
      const id = await store.saveImage(m[1], m[2]);
      return json(res, 200, { id });
    }

    if (p === '/api/admin/views' && method === 'GET') return json(res, 200, store.read('views', {}));

    if (p === '/api/admin/orders') {
      if (method === 'GET') return json(res, 200, store.read('orders', []));
      if (method === 'DELETE') { store.write('orders', []); return json(res, 200, { ok: true }); }
    }

    if (p === '/api/admin/stats' && method === 'GET') {
      const orders = store.read('orders', []);
      const products = store.read('products', []);
      const views = store.read('views', {});
      const revenue = orders.reduce((s2, o) => s2 + (o.total || 0), 0);
      return json(res, 200, {
        products: products.length,
        orders: orders.length,
        revenue,
        views: Object.values(views).reduce((a, b) => a + b, 0),
        users: Object.keys(store.read('users', {})).length,
        botConnected: !!BOT_TOKEN,
      });
    }

    if (p === '/api/admin/test-notification' && method === 'POST') {
      const s = getSettings();
      if (!s.notify.chatIds.length) return json(res, 400, { error: 'Сначала укажи хотя бы один chat_id получателя' });
      const results = [];
      for (const id of s.notify.chatIds) {
        const r = await tgApi('sendMessage', { chat_id: id, text: '🔔 Тестовое уведомление — всё настроено верно.' });
        results.push({ id, ok: !!r.ok, error: r.description || '' });
      }
      const bad = results.filter(r => !r.ok);
      if (bad.length) return json(res, 502, { error: bad.map(b => `${b.id}: ${b.error}`).join('; ') });
      return json(res, 200, { ok: true, sent: results.length });
    }

    if (p === '/api/admin/publish' && method === 'POST') {
      let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      const s = getSettings();
      const product = store.read('products', []).find(x => x.id === Number(b.productId));
      if (!product) return json(res, 404, { error: 'товар не найден' });
      if (!s.channel.channelId) return json(res, 400, { error: 'Укажи канал в разделе «Канал»' });
      if (!s.channel.miniAppLink) return json(res, 400, { error: 'Укажи ссылку мини-аппа в разделе «Канал»' });

      const link = s.channel.miniAppLink + (s.channel.miniAppLink.includes('?') ? '&' : '?') + 'startapp=' + product.id;
      const caption = bot.fill(s.channel.postTemplate, {
        name: product.name,
        description: product.description || '',
        price: s.commerce.priceHidden ? s.commerce.priceHiddenText : money(product.price, s),
        shop: s.brand.shopName,
        category: product.category || '',
      }).slice(0, 1024);

      const payload = { chat_id: s.channel.channelId, reply_markup: { inline_keyboard: [[{ text: s.channel.postButtonText, url: link }]] } };
      const publicBase = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
      let apiMethod = 'sendMessage';
      if (product.images && product.images[0] && publicBase) {
        apiMethod = 'sendPhoto';
        payload.photo = `${publicBase}/api/image?id=${product.images[0]}`;
        payload.caption = caption;
      } else {
        payload.text = caption;
      }
      const r = await tgApi(apiMethod, payload);
      if (!r.ok) return json(res, 502, { error: r.description || 'Telegram отклонил публикацию' });
      return json(res, 200, { ok: true });
    }

    // экспорт/импорт всей конфигурации — перенос магазина на другой сервер в один клик
    if (p === '/api/admin/export' && method === 'GET') {
      return json(res, 200, {
        settings: getSettings(),
        products: store.read('products', []),
        exportedAt: new Date().toISOString(),
      });
    }
    if (p === '/api/admin/import' && method === 'POST') {
      let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { error: 'bad json' }); }
      if (b.settings) store.write('settings', sanitize(b.settings));
      if (Array.isArray(b.products)) store.write('products', b.products.map(normalizeProduct));
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'unknown admin endpoint' });
  }

  return json(res, 404, { error: 'not found' });
}

function normalizeProduct(b) {
  const arr = (v, n) => (Array.isArray(v) ? v.filter(Boolean).slice(0, n) : []);
  return {
    id: Number(b.id) || Date.now(),
    name: String(b.name || '').trim().slice(0, 80),
    description: String(b.description || '').slice(0, 1000),
    category: String(b.category || '').trim().slice(0, 40),
    price: Math.max(0, Number(b.price) || 0),
    oldPrice: b.oldPrice === '' || b.oldPrice == null ? null : Math.max(0, Number(b.oldPrice) || 0),
    stock: (b.stock === '' || b.stock === null || b.stock === undefined) ? null : Math.max(0, Number(b.stock) || 0),
    featured: !!b.featured,
    hidden: !!b.hidden,
    badge: String(b.badge || '').slice(0, 16),
    images: arr(b.images, 8),
    thumbs: arr(b.thumbs, 8),
  };
}

// ---------- сервер ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error('[http]', req.method, url.pathname, e);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[web] http://${HOST}:${PORT}  (данные: ${store.DATA_DIR})`);
  bot.start();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { bot.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });
}
