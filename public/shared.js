// Общий модуль для витрины и админки — иконки, форматирование и движок тем
// в одном месте, чтобы не держать одинаковый код в двух html-файлах.

const PLACEHOLDER_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
const STAR_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2l2.9 6.6 7.1.7-5.4 4.7 1.6 7-6.2-3.7L5.8 21l1.6-7L2 9.3l7.1-.7L12 2z"/></svg>';
const EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const SEND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16z"/></svg>';
const EDIT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.9 17.9A10.4 10.4 0 0 1 12 19c-7 0-11-7-11-7a19 19 0 0 1 5.1-5.9M9.9 4.2A10.4 10.4 0 0 1 12 5c7 0 11 7 11 7a19 19 0 0 1-2.2 3.2M1 1l22 22"/></svg>';

// ---------- темы ----------
// Каждый пресет — законченная система, а не просто набор цветов: вместе с
// палитрой едут шрифт, скругления, толщина рамок и режим капслока.
const THEME_PRESETS = {
  brutalist: {
    label: 'Бруталист',
    bg: '#0d0d0d', surface: '#161616', surface2: '#202020',
    text: '#f2efe6', muted: '#8a8880', accent: '#e8341c', accent2: '#f2c94c',
    radius: 0, borderWidth: 1, fontDisplay: 'Oswald', uppercase: true,
  },
  constructivist: {
    label: 'Конструктивизм',
    bg: '#f2ece1', surface: '#ffffff', surface2: '#e6ded0',
    text: '#101010', muted: '#6b6558', accent: '#d81e05', accent2: '#111111',
    radius: 0, borderWidth: 2, fontDisplay: 'Archivo Black', uppercase: true,
  },
  bauhaus: {
    label: 'Баухаус',
    bg: '#faf7f0', surface: '#ffffff', surface2: '#ece7dc',
    text: '#141414', muted: '#7a746a', accent: '#1953d8', accent2: '#f5c400',
    radius: 0, borderWidth: 2, fontDisplay: 'Archivo Black', uppercase: true,
  },
  neon: {
    label: 'Неон',
    bg: '#07070c', surface: '#101020', surface2: '#191932',
    text: '#eef0ff', muted: '#8a8ab5', accent: '#00f5c8', accent2: '#ff2e9a',
    radius: 2, borderWidth: 1, fontDisplay: 'Oswald', uppercase: true,
  },
  swiss: {
    label: 'Швейцарский',
    bg: '#ffffff', surface: '#ffffff', surface2: '#f0f0f0',
    text: '#000000', muted: '#767676', accent: '#ff0000', accent2: '#000000',
    radius: 0, borderWidth: 1, fontDisplay: 'Inter', uppercase: false,
  },
  mono: {
    label: 'Моно',
    bg: '#000000', surface: '#0b0b0b', surface2: '#171717',
    text: '#ffffff', muted: '#8f8f8f', accent: '#ffffff', accent2: '#c8c8c8',
    radius: 0, borderWidth: 1, fontDisplay: 'Oswald', uppercase: true,
  },
  soft: {
    label: 'Мягкий',
    bg: '#12121a', surface: '#1b1b26', surface2: '#252533',
    text: '#f4f4f8', muted: '#9a9ab0', accent: '#7b5cff', accent2: '#4ad4a0',
    radius: 16, borderWidth: 0, fontDisplay: 'Inter', uppercase: false,
  },
  acid: {
    label: 'Кислота',
    bg: '#0a0f00', surface: '#131a05', surface2: '#1d270a',
    text: '#eaffc7', muted: '#8fa06a', accent: '#c6ff00', accent2: '#ff4d00',
    radius: 0, borderWidth: 2, fontDisplay: 'Archivo Black', uppercase: true,
  },
};

const FONT_STACKS = {
  'Oswald': "'Oswald',sans-serif",
  'Archivo Black': "'Archivo Black',sans-serif",
  'Inter': "'Inter',-apple-system,sans-serif",
  'Space Grotesk': "'Space Grotesk',sans-serif",
  'system': "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
};

const DENSITY = { compact: 0.8, normal: 1, roomy: 1.25 };

// Собирает итоговую палитру: пресет как база, ручные поля из настроек — сверху.
function resolveTheme(theme) {
  const t = theme || {};
  const preset = THEME_PRESETS[t.preset] || THEME_PRESETS.brutalist;
  const pick = key => (t[key] ? t[key] : preset[key]);
  const numOr = (v, fb) => (v !== null && v !== undefined && v !== '' ? Number(v) : fb);
  return {
    bg: pick('bg'), surface: pick('surface'), surface2: pick('surface2'),
    text: pick('text'), muted: pick('muted'), accent: pick('accent'), accent2: pick('accent2'),
    radius: numOr(t.radius, preset.radius),
    borderWidth: numOr(t.borderWidth, preset.borderWidth),
    fontDisplay: t.fontDisplay || preset.fontDisplay,
    uppercase: t.uppercase != null ? !!t.uppercase : preset.uppercase,
    fontScale: Number(t.fontScale) || 100,
    density: t.density || 'normal',
  };
}

// Применяет тему через CSS-переменные. И витрина, и превью в админке зовут
// именно эту функцию — поэтому превью не может разойтись с реальностью.
function applyTheme(theme, rootEl) {
  const el = rootEl || document.documentElement;
  const r = resolveTheme(theme);
  const set = (k, v) => el.style.setProperty(k, v);
  set('--bg', r.bg); set('--surface', r.surface); set('--surface-2', r.surface2);
  set('--text', r.text); set('--muted', r.muted);
  set('--accent', r.accent); set('--accent-2', r.accent2); set('--heart', r.accent);
  set('--radius', r.radius + 'px');
  set('--bw', r.borderWidth + 'px');
  set('--font-display', FONT_STACKS[r.fontDisplay] || FONT_STACKS.system);
  set('--fs', (r.fontScale / 100).toFixed(2));
  set('--gap', (DENSITY[r.density] || 1).toFixed(2));
  set('--caps', r.uppercase ? 'uppercase' : 'none');
  loadFont(r.fontDisplay);
  return r;
}

// Подгружаем только выбранный шрифт, а не все восемь сразу.
function loadFont(name) {
  if (!name || name === 'system') return;
  const id = 'font-' + name.replace(/\s+/g, '-');
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}:wght@400;500;600;700&display=swap`;
  document.head.appendChild(link);
}

// ---------- формат ----------
let CURRENCY = { symbol: '₽', position: 'after', locale: 'ru-RU' };
function setCurrency(c) { CURRENCY = { ...CURRENCY, ...c }; }
const fmt = n => {
  const v = Number(n).toLocaleString(CURRENCY.locale);
  return CURRENCY.position === 'before' ? `${CURRENCY.symbol}${v}` : `${v} ${CURRENCY.symbol}`;
};

// Экранирование перед вставкой в innerHTML: названия товаров приходят из
// админки и вполне могут содержать кавычки, < и &.
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

// подстановка {переменных} в шаблоны сообщений из настроек
function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

// принимает и "@username", и "username", и уже готовую полную ссылку —
// возвращает рабочий URL. Так в админке проще: не нужно помнить формат https://t.me/...
function normalizeLink(input){
  const v = (input || '').trim();
  if(!v) return '';
  if(/^https?:\/\//i.test(v)) return v;
  if(v.startsWith('@')) return `https://t.me/${v.slice(1)}`;
  if(/^[a-zA-Z0-9_]{5,}$/.test(v)) return `https://t.me/${v}`; // голый юзернейм без @ и без https
  return v; // что-то нестандартное (wa.me/79991234567 и т.п.) — не трогаем
}

// простой debounce — используется для живого поиска, чтобы не дёргать рендер на каждый символ
function debounce(fn, wait){
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
