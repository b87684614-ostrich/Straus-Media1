/* =====================================================================
   StrausTube — демонстрационный видеохостинг, работающий целиком в браузере.
   Данные (аккаунты, видео, комментарии) хранятся локально: localStorage + IndexedDB.
   На сервер ничего не отправляется. Внешних библиотек нет.
   ===================================================================== */
'use strict';

(function () {

  /* ------------------------------------------------------------------
     1. Утилиты
     ------------------------------------------------------------------ */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function uid(prefix) {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return (prefix || 'id') + '-' + window.crypto.randomUUID();
    }
    const bytes = new Uint8Array(12);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' +
      Array.prototype.map.call(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  function plural(n, one, few, many) {
    const abs = Math.abs(n) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) return many;
    if (last > 1 && last < 5) return few;
    if (last === 1) return one;
    return many;
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1).replace('.', ',') + ' млн';
    if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1).replace('.', ',') + ' тыс.';
    return String(n);
  }

  function viewsText(n) { n = Number(n) || 0; return fmtNum(n) + ' ' + plural(n, 'просмотр', 'просмотра', 'просмотров'); }
  function videosText(n) { n = Number(n) || 0; return fmtNum(n) + ' ' + plural(n, 'видео', 'видео', 'видео'); }
  function commentsText(n) { n = Number(n) || 0; return fmtNum(n) + ' ' + plural(n, 'комментарий', 'комментария', 'комментариев'); }

  function fmtDate(ts) {
    try {
      return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (e) { return ''; }
  }

  function timeAgo(ts) {
    const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (sec < 60) return sec + ' ' + plural(sec, 'секунду', 'секунды', 'секунд') + ' назад';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + ' ' + plural(min, 'минуту', 'минуты', 'минут') + ' назад';
    const hours = Math.floor(min / 60);
    if (hours < 24) return hours + ' ' + plural(hours, 'час', 'часа', 'часов') + ' назад';
    const days = Math.floor(hours / 24);
    if (days < 7) return days + ' ' + plural(days, 'день', 'дня', 'дней') + ' назад';
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return weeks + ' ' + plural(weeks, 'неделю', 'недели', 'недель') + ' назад';
    const months = Math.floor(days / 30);
    if (months < 12) return months + ' ' + plural(months, 'месяц', 'месяца', 'месяцев') + ' назад';
    const years = Math.floor(days / 365);
    return years + ' ' + plural(years, 'год', 'года', 'лет') + ' назад';
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = v => String(v).padStart(2, '0');
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  function parseDuration(str) {
    if (!str) return 0;
    const parts = String(str).trim().split(':').map(p => parseInt(p, 10));
    if (parts.some(isNaN)) return 0;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }

  function isHttpUrl(str) {
    try {
      const u = new URL(str);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) { return false; }
  }

  /* Разбор ссылки на YouTube: поддерживаем watch?v=, youtu.be/<id>, /embed/<id>, /shorts/<id> */
  function parseYouTubeId(input) {
    if (!input) return null;
    const raw = String(input).trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
    let url;
    try { url = new URL(raw); } catch (e) { return null; }
    if (!/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i.test(url.hostname)) return null;
    if (url.hostname.toLowerCase() === 'youtu.be') {
      const id = url.pathname.slice(1);
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    const v = url.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const m = url.pathname.match(/\/(embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
    return m ? m[2] : null;
  }

  /* ------------------------------------------------------------------
     2. Локальное хранилище
     ------------------------------------------------------------------ */
  const KEY = {
    users: 'straustube.users.v1',
    videos: 'straustube.videos.v1',
    comments: 'straustube.comments.v1',
    session: 'straustube.session.v1',
    theme: 'straustube.theme.v1',
    notice: 'straustube.notice.v1',
    seeded: 'straustube.seeded.v1'
  };

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { toast('Не удалось сохранить данные: хранилище переполнено', 'err'); }
  }

  /* ---- IndexedDB для файлов видео (Blob) ---- */
  const DB_NAME = 'straustube-media';
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB недоступен')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idbPut(key, blob) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(blob, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readonly');
      const req = tx.objectStore('files').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbDelete(key) {
    try {
      const db = await openDb();
      return new Promise((resolve) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (e) { return false; }
  }

  /* ---- состояние приложения (в памяти) ---- */
  const state = {
    users: read(KEY.users, []),
    videos: read(KEY.videos, []),
    comments: read(KEY.comments, []),
    session: read(KEY.session, null),   // {as: userId|null, admin: bool, ret: string|null}
    ride: null,                         // временный «вход под другим профилем» из админ-панели
    viewed: new Set()                   // просмотры за текущую сессию (защита от накрутки)
  };

  /* Гарантирует, что объект сессии существует и корректен.
     Нужен после сброса данных: панель владельца не должна ломаться из-за «пустой» сессии. */
  function ensureSession() {
    if (!state.session || typeof state.session !== 'object') state.session = { as: null, admin: false };
    if (typeof state.session.admin !== 'boolean') state.session.admin = false;
    if (typeof state.session.as !== 'string' && state.session.as !== null) state.session.as = null;
    return state.session;
  }

  function persistUsers() { write(KEY.users, state.users); }
  function persistVideos() { write(KEY.videos, state.videos); }
  function persistComments() { write(KEY.comments, state.comments); }
  function persistSession() { write(KEY.session, state.session); }

  function getUser(id) { return state.users.find(u => u.id === id) || null; }
  function findUserByName(name) {
    const lower = String(name).trim().toLowerCase();
    return state.users.find(u => u.name.toLowerCase() === lower) || null;
  }
  function getVideo(id) { return state.videos.find(v => v.id === id) || null; }
  function currentUser() {
    if (state.ride) return getUser(state.ride) || null;
    return state.session && state.session.as ? getUser(state.session.as) : null;
  }
  function isAdminActive() { return !!(state.session && state.session.admin); }

  function myVideos(userId) {
    return state.videos.filter(v => v.channelId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  function commentsOf(videoId) {
    return state.comments.filter(c => c.videoId === videoId).sort((a, b) => b.createdAt - a.createdAt);
  }

  /* ------------------------------------------------------------------
     3. Аватары и обложки-заглушки (генеративный inline SVG)
     ------------------------------------------------------------------ */
  const PALETTE = ['#e53935', '#d81b60', '#8e24aa', '#5e35b1', '#3949ab', '#1e88e5',
    '#00897b', '#43a047', '#f4511e', '#6d4c41', '#546e7a', '#c2185b'];

  function svgUri(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function makeAvatar(color, letter, dark) {
    const c1 = color || PALETTE[0];
    const bg = dark ? '#121212' : c1;
    const glyph = esc(String(letter || '?').slice(0, 1).toUpperCase());
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + bg + '"/>' +
      '<stop offset="1" stop-color="' + (dark ? '#2c2c2c' : shade(c1, -28)) + '"/>' +
      '</linearGradient></defs>' +
      '<rect width="96" height="96" fill="url(#g)"/>' +
      '<text x="48" y="50" text-anchor="middle" dominant-baseline="central" ' +
      'font-family="system-ui,Segoe UI,Roboto,Arial,sans-serif" font-size="44" font-weight="700" fill="#ffffff">' +
      glyph + '</text></svg>';
    return svgUri(svg);
  }

  function shade(hex, percent) {
    const n = parseInt(hex.replace('#', ''), 16);
    const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
    const r = clamp(((n >> 16) & 255) + percent * 2.55);
    const g = clamp(((n >> 8) & 255) + percent * 2.55);
    const b = clamp((n & 255) + percent * 2.55);
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }

  function defaultAvatars() {
    const letters = ['S', 'T', 'A', 'K', 'M', 'L', 'D', 'Я'];
    return PALETTE.map((c, i) => ({ id: 'av' + i, url: makeAvatar(c, letters[i % letters.length], i % 2 === 1) }));
  }

  function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h;
  }

  const THUMB_THEMES = [
    ['#2b0a14', '#ff4d6d'], ['#0a1d2b', '#3ea6ff'], ['#101f10', '#5ddc7f'],
    ['#241033', '#b07cff'], ['#2b1c05', '#ffb84d'], ['#062a2a', '#46d6d6']
  ];

  function placeholderThumb(seed) {
    const theme = THUMB_THEMES[hashString(seed) % THUMB_THEMES.length];
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" role="img">' +
      '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + theme[0] + '"/>' +
      '<stop offset="1" stop-color="#0d0d0d"/></linearGradient></defs>' +
      '<rect width="640" height="360" fill="url(#bg)"/>' +
      '<g opacity="0.16" fill="' + theme[1] + '">' +
      '<circle cx="90" cy="70" r="120"/><circle cx="600" cy="330" r="150"/></g>' +
      '<circle cx="320" cy="168" r="52" fill="rgba(0,0,0,0.45)" stroke="' + theme[1] + '" stroke-width="3"/>' +
      '<path d="M305 143l42 25-42 25z" fill="' + theme[1] + '"/>' +
      '<text x="320" y="300" text-anchor="middle" font-family="system-ui,Segoe UI,Roboto,Arial,sans-serif" ' +
      'font-size="26" font-weight="700" fill="rgba(255,255,255,0.65)">StrausTube</text></svg>';
    return svgUri(svg);
  }

  function thumbInfo(video) {
    if (video.source === 'youtube' && video.youtubeId) {
      return { kind: 'youtube', src: 'https://i.ytimg.com/vi/' + video.youtubeId + '/hqdefault.jpg' };
    }
    if (video.thumbUrl && isHttpUrl(video.thumbUrl)) {
      return { kind: 'url', src: video.thumbUrl, fallback: placeholderThumb(video.id) };
    }
    return { kind: 'placeholder', src: placeholderThumb(video.id) };
  }

  function avatarFor(user) {
    if (!user) return makeAvatar('#555', '?', true);
    if (user.avatar && String(user.avatar).indexOf('data:image/') === 0) return user.avatar;
    if (user.avatar && isHttpUrl(user.avatar)) return user.avatar;
    return makeAvatar(PALETTE[hashString(user.name || user.id) % PALETTE.length], user.name || '?');
  }

  function avatarImg(user, cls) {
    const src = avatarFor(user);
    const alt = user ? ('Аватар канала ' + user.name) : 'Аватар';
    return '<img class="av ' + (cls || '') + '" src="' + esc(src) + '" alt="' + esc(alt) +
      '" data-fb="' + esc(makeAvatar('#555', '?', true)) + '">';
  }

  /* ------------------------------------------------------------------
     4. Пароли (PBKDF2-SHA-256, Web Crypto). Само демо — локальное, но хешируем честно.
     ------------------------------------------------------------------ */
  const PBKDF2_ITER = 120000;

  function toHex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }

  function weakHashHex(text) {
    /* Резервный вариант для старых браузеров без Web Crypto: простая FNV-подобная свёртка.
       Используется ТОЛЬКО когда crypto.subtle недоступен, и помечается в записи. */
    let h1 = 0x811c9dc5, h2 = 0x1000193;
    const salt = 'straustube-demo';
    const data = salt + '|' + text + '|' + salt;
    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i);
      h1 = (h1 ^ c) >>> 0; h1 = (h1 * 16777619) >>> 0;
      h2 = (h2 + c * (i + 1)) >>> 0; h2 = ((h2 << 5) | (h2 >>> 27)) >>> 0;
    }
    return 'w1$' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  async function hashPassword(password) {
    const subtle = window.crypto && window.crypto.subtle;
    if (!subtle) return weakHashHex(password);
    const enc = new TextEncoder();
    const salt = new Uint8Array(16);
    if (window.crypto.getRandomValues) window.crypto.getRandomValues(salt); else for (let i = 0; i < 16; i++) salt[i] = i;
    const key = await subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' }, key, 256);
    return 'p1$' + PBKDF2_ITER + '$' + toHex(salt) + '$' + toHex(bits);
  }

  async function verifyPassword(password, record) {
    if (!record) return false;
    if (record.startsWith('w1$')) return weakHashHex(password) === record;
    const parts = record.split('$');
    if (parts.length !== 4) return false;
    const subtle = window.crypto && window.crypto.subtle;
    if (!subtle) return false;
    const iterations = parseInt(parts[1], 10);
    const salt = new Uint8Array(parts[2].match(/../g).map(h => parseInt(h, 16)));
    const enc = new TextEncoder();
    const key = await subtle.importKey('raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
    return toHex(bits) === parts[3];
  }

  /* ------------------------------------------------------------------
     5. Уведомления
     ------------------------------------------------------------------ */
  function toast(message, type) {
    const host = $('#toasts');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' toast--' + type : '');
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.classList.add('toast--out'), 2600);
    setTimeout(() => el.remove(), 3100);
  }

  /* ------------------------------------------------------------------
     6. Демонстрационные данные при первом запуске
     ------------------------------------------------------------------ */
  const CATEGORIES = ['Все', 'Музыка', 'Фильмы', 'Игры', 'Наука', 'Юмор', 'Космос', 'Обучение', 'Путешествия', 'Разное'];

  function seedDemoData() {
    if (read(KEY.seeded, false)) return;
    const now = Date.now();
    const day = 86400000;

    const users = [
      { id: 'u-straus', name: 'Straus', avatar: makeAvatar('#e53935', 'S'), password: null, isAdmin: false, createdAt: now - 40 * day, demo: true },
      { id: 'u-mila', name: 'Mila_K', avatar: makeAvatar('#8e24aa', 'M'), password: null, isAdmin: false, createdAt: now - 120 * day, demo: true },
      { id: 'u-kosmos', name: 'КосмоКот', avatar: makeAvatar('#1e88e5', 'К'), password: null, isAdmin: false, createdAt: now - 200 * day, demo: true },
      { id: 'u-lofi', name: 'Lo-Fi Человек', avatar: makeAvatar('#00897b', 'L'), password: null, isAdmin: false, createdAt: now - 300 * day, demo: true },
      { id: 'u-admin', name: 'Администратор', avatar: makeAvatar('#7f0d1b', 'А', true), password: null, isAdmin: true, createdAt: now - 400 * day, demo: true }
    ];

    const videos = [
      { id: 'v-yt1', title: 'Rick Astley — Never Gonna Give You Up (официальный клип)', channelId: 'u-lofi', category: 'Музыка', source: 'youtube', youtubeId: 'dQw4w9WgXcQ', duration: 213, views: 182400, likes: ['u-straus', 'u-mila'], createdAt: now - 9 * day, description: 'Классика интернета. Видео воспроизводится через встроенный плеер YouTube (youtube-nocookie).' },
      { id: 'v-yt2', title: 'Я в зоопарке — одно из самых первых видео в истории видеохостингов', channelId: 'u-mila', category: 'Разное', source: 'youtube', youtubeId: 'jNQXAC9IVRw', duration: 19, views: 95400, likes: ['u-kosmos'], createdAt: now - 21 * day, description: 'Короткая историческая запись из 2005 года.' },
      { id: 'v-yt3', title: 'Big Buck Bunny — короткометражный мультфильм (Blender, лицензия CC-BY)', channelId: 'u-straus', category: 'Фильмы', source: 'youtube', youtubeId: 'aqz-KE-bpKQ', duration: 635, views: 41230, likes: ['u-mila', 'u-kosmos', 'u-lofi'], createdAt: now - 4 * day, description: 'Открытый мультфильм студии Blender. Хороший тестовый ролик: заметно, как работает плеер и статистика.' },
      { id: 'v-yt4', title: 'Sintel — короткометражка Blender Foundation', channelId: 'u-straus', category: 'Фильмы', source: 'youtube', youtubeId: 'eRsGyueVLvQ', duration: 888, views: 28760, likes: ['u-mila'], createdAt: now - 12 * day, description: 'Фэнтезийная короткометражка с открытой лицензией.' },
      { id: 'v-yt5', title: 'Коста-Рика в 4K — пляжи, джунгли и туканы', channelId: 'u-kosmos', category: 'Путешествия', source: 'youtube', youtubeId: 'LXb3EKWsInQ', duration: 254, views: 15900, likes: ['u-straus'], createdAt: now - 30 * day, description: 'Спокойный видовой ролик в высоком разрешении.' },
      { id: 'v-yt6', title: 'Tears of Steel — фантастика с визуальными эффектами (Blender)', channelId: 'u-mila', category: 'Фильмы', source: 'youtube', youtubeId: 'R6MlUcmOul8', duration: 734, views: 9870, likes: [], createdAt: now - 45 * day, description: 'Короткометражка, снятая на открытом ПО.' },
      { id: 'v-own1', title: 'Как я собрал локальный видеохостинг за один вечер', channelId: 'u-straus', category: 'Обучение', source: 'placeholder', duration: 412, views: 3420, likes: ['u-mila', 'u-kosmos'], createdAt: now - 2 * day, description: 'Разбираю, как устроено демонстрационное приложение: интерфейс, хранение данных в браузере и работа с плеером.' },
      { id: 'v-own2', title: 'Утренний влог: кофе, дождь и код', channelId: 'u-straus', category: 'Разное', source: 'placeholder', duration: 254, views: 1120, likes: ['u-lofi'], createdAt: now - 6 * day, description: 'Немного о повседневном: ритуалы, планирование и почему важно выключать уведомления.' },
      { id: 'v-own3', title: 'Черновик: идеи новых сценариев', channelId: 'u-straus', category: 'Разное', source: 'placeholder', duration: 96, views: 12, likes: [], visibility: 'private', createdAt: now - 1 * day, description: 'Личная заметка, видна только владельцу канала.' },
      { id: 'v-own4', title: 'Стрим: рисуем аватарки прямо в SVG', channelId: 'u-kosmos', category: 'Игры', source: 'placeholder', duration: 3605, views: 2210, likes: ['u-straus'], createdAt: now - 8 * day, description: 'Генерируем аватары векторами — без картинок и внешних библиотек.' }
    ];

    const comments = [
      { id: 'c1', videoId: 'v-yt3', authorId: 'u-mila', text: 'Отличный тестовый ролик: сразу видно, как плеер держит длинное видео.', createdAt: now - 3 * day },
      { id: 'c2', videoId: 'v-yt3', authorId: 'u-kosmos', text: 'Анимация до сих пор выглядит приятно.', createdAt: now - 2 * day },
      { id: 'c3', videoId: 'v-own1', authorId: 'u-lofi', text: 'Полезно! А можно так же сделать плейлисты?', createdAt: now - 1 * day },
      { id: 'c4', videoId: 'v-yt1', authorId: 'u-straus', text: 'Никогда не подведу тебя... классика.', createdAt: now - 8 * day }
    ];

    state.users = users;
    state.videos = videos;
    state.comments = comments;
    persistUsers(); persistVideos(); persistComments();
    write(KEY.seeded, true);
  }

  function resetDemoData() {
    localStorage.removeItem(KEY.users);
    localStorage.removeItem(KEY.videos);
    localStorage.removeItem(KEY.comments);
    localStorage.removeItem(KEY.seeded);
    localStorage.removeItem(KEY.session);
    const keepAdmin = !!(state.session && state.session.admin);
    state.users = []; state.videos = []; state.comments = [];
    state.session = { as: null, admin: keepAdmin };
    state.ride = null;
    seedDemoData();
    persistSession();
    render();
    toast('Демонстрационные данные восстановлены', 'ok');
  }

  /* ------------------------------------------------------------------
     7. Тема и каркас интерфейса
     ------------------------------------------------------------------ */
  const THEME_ICON = {
    dark: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9c0-.46-.03-.92-.1-1.36A6.5 6.5 0 0 1 12 3z" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    light: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>'
  };

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    write(KEY.theme, theme);
    const btn = $('#themeBtn');
    if (btn) btn.innerHTML = THEME_ICON[theme] || THEME_ICON.dark;
  }

  function navIcon(name) {
    const icons = {
      home: '<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
      channel: '<circle cx="12" cy="9" r="3.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M5 20c1.4-3.6 3.9-5.2 7-5.2s5.6 1.6 7 5.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
      studio: '<rect x="3.5" y="5" width="17" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10 9.5 15 12l-5 2.5z" fill="currentColor"/>',
      upload: '<path d="M12 16V5m0 0L7.5 9.5M12 5l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.5 15.5V18a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
      clock: '<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
      heart: '<path d="M12 20s-7-4.4-7-9.2A4 4 0 0 1 12 8.4a4 4 0 0 1 7-2.6c0 4.8-7 9.2-7 9.2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
      info: '<circle cx="12" cy="12" r="8.3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 11v5.5M12 7.8v.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'
    };
    return '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' + (icons[name] || icons.home) + '</svg>';
  }

  function renderSidebar() {
    const me = currentUser();
    const items = [
      { href: '#/', name: 'Главная', icon: 'home', route: 'home' },
      { href: '#/search?q=', name: 'Поиск', icon: 'clock', route: 'search' },
      { href: me ? '#/channel/' + me.id : '#/login', name: 'Ваш канал', icon: 'channel', route: 'channel' },
      { href: '#/studio', name: 'Моя студия', icon: 'studio', route: 'studio' },
      { href: '#/upload', name: 'Загрузить видео', icon: 'upload', route: 'upload' }
    ];
    const channels = state.users.filter(u => u.id !== (me && me.id) && myVideos(u.id).some(v => v.visibility !== 'private')).slice(0, 6);
    let html = items.map(i => '<a href="' + i.href + '" data-nav="' + i.route + '">' + navIcon(i.icon) + '<span>' + esc(i.name) + '</span></a>').join('');
    if (channels.length) {
      html += '<div class="sidebar__group">Каналы</div>';
      html += channels.map(u => '<a href="#/channel/' + esc(u.id) + '" data-nav="channel:' + esc(u.id) + '">' +
        avatarImg(u, 'av--sm') + '<span>' + esc(u.name) + '</span></a>').join('');
    }
    html += '<div class="sidebar__group">Ещё</div>';
    html += '<a href="#/about" data-nav="about">' + navIcon('info') + '<span>О проекте</span></a>';
    $('#sidebarNav').innerHTML = html;
  }

  function renderAccountArea() {
    const host = $('#accountArea');
    const me = currentUser();
    const theme = read(KEY.theme, 'dark');
    if (!me) {
      host.innerHTML =
        '<button class="btn btn--ghost btn--sm" id="themeBtn" type="button" aria-label="Сменить тему">' + (THEME_ICON[theme] || THEME_ICON.dark) + '</button>' +
        '<a class="btn btn--ghost btn--sm" href="#/login">Войти</a>';
      bindTheme();
      return;
    }
    const riding = !!state.ride;
    host.innerHTML =
      '<button class="btn btn--ghost btn--sm" id="themeBtn" type="button" aria-label="Сменить тему">' + (THEME_ICON[theme] || THEME_ICON.dark) + '</button>' +
      '<div class="account">' +
      '  <button class="account__btn" id="accountBtn" type="button" aria-haspopup="menu" aria-expanded="false">' +
      avatarImg(me, 'av--sm') +
      '<span>' + esc(me.name) + '</span>' +
      (riding ? '<span class="badge">режим входа</span>' : '') +
      '</button>' +
      '</div>';
    bindTheme();
    const btn = $('#accountBtn');
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openAccountMenu(me, btn);
    });
  }

  function openAccountMenu(me, anchor) {
    closeAccountMenu();
    const menu = document.createElement('div');
    menu.className = 'account__menu';
    menu.id = 'accountMenu';
    menu.setAttribute('role', 'menu');
    const rides = state.ride ? '<div class="account__item cursor-default" ><b>Вход выполнен из панели</b></div>' : '';
    menu.innerHTML =
      '<div class="account__head">' + avatarImg(me, '') +
      '<div><b>' + esc(me.name) + '</b><span>' + videosText(myVideos(me.id).length) + ' на канале</span></div></div>' +
      rides +
      '<a class="account__item" role="menuitem" href="#/channel/' + esc(me.id) + '">Мой канал</a>' +
      '<a class="account__item" role="menuitem" href="#/studio">Моя студия</a>' +
      '<button class="account__item" type="button" id="editProfileBtn" role="menuitem">Редактировать профиль</button>' +
      '<button class="account__item" type="button" id="switchAccBtn" role="menuitem">Сменить аккаунт</button>' +
      (isAdminActive() ? '<button class="account__item" type="button" id="adminOpenBtn" role="menuitem">Панель управления</button>' : '') +
      '<div class="account__sep"></div>' +
      '<button class="account__item" type="button" id="logoutBtn" role="menuitem">Выйти</button>';
    anchor.parentNode.appendChild(menu);
    menu.addEventListener('click', ev => ev.stopPropagation());

    $('#editProfileBtn', menu).addEventListener('click', () => { closeAccountMenu(); openProfileEditor(me); });
    $('#switchAccBtn', menu).addEventListener('click', () => { closeAccountMenu(); openAccountSwitcher(); });
    $('#logoutBtn', menu).addEventListener('click', () => {
      closeAccountMenu();
      if (state.ride) { state.ride = null; toast('Режим прямого входа отключён'); renderChrome(); render(); return; }
      ensureSession();
      state.session.as = null;
      persistSession();
      renderChrome(); render();
      toast('Вы вышли из аккаунта');
    });
    const adminBtn = $('#adminOpenBtn', menu);
    if (adminBtn) adminBtn.addEventListener('click', () => { closeAccountMenu(); openAdminPanel(); });

    setTimeout(() => document.addEventListener('click', closeAccountMenu, { once: true }), 0);
  }

  function closeAccountMenu() {
    const m = $('#accountMenu');
    if (m) m.remove();
  }

  function bindTheme() {
    const btn = $('#themeBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const next = (read(KEY.theme, 'dark') === 'dark') ? 'light' : 'dark';
      applyTheme(next);
    });
  }

  function renderChrome() {
    renderAccountArea();
    renderSidebar();
    const nav = $('#sidebarNav');
    if (nav) {
      $$('a[data-nav]', nav).forEach(a => a.classList.remove('active'));
      const active = $('a[data-nav="' + lastRoute.name + (lastRoute.param ? ':' + lastRoute.param : '') + '"]', nav);
      if (active) active.classList.add('active');
    }
  }

  /* ------------------------------------------------------------------
     8. Роутер
     ------------------------------------------------------------------ */
  const lastRoute = { name: 'home', param: null, params: new URLSearchParams('') };

  function parseRoute() {
    const raw = String(location.hash || '').replace(/^#\/?/, '');
    const qIndex = raw.indexOf('?');
    const pathPart = qIndex === -1 ? raw : raw.slice(0, qIndex);
    const queryPart = qIndex === -1 ? '' : raw.slice(qIndex + 1);
    const segs = pathPart.split('/').filter(Boolean);
    return {
      name: segs[0] || 'home',
      param: segs[1] ? decodeURIComponent(segs[1]) : null,
      params: new URLSearchParams(queryPart)
    };
  }

  function go(hash) { location.hash = hash; }

  function render() {
    const route = parseRoute();
    lastRoute.name = route.name;
    lastRoute.param = route.param;
    lastRoute.params = route.params;

    /* Освобождаем blob-ссылки предыдущей страницы (видео из памяти браузера) */
    if (state.mediaUrls && state.mediaUrls.length) {
      state.mediaUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) { /* noop */ } });
      state.mediaUrls = [];
    }

    const view = $('#view');
    view.innerHTML = '';
    let html = '';

    switch (route.name) {
      case 'home': html = viewHome(); break;
      case 'search': html = viewSearch(route.params.get('q') || ''); break;
      case 'watch': html = viewWatch(route.param); break;
      case 'channel': html = viewChannel(route.param); break;
      case 'studio': html = viewStudio(); break;
      case 'upload': html = viewUpload(); break;
      case 'login': html = viewLogin(route.params.get('next')); break;
      case 'about': html = viewAbout(); break;
      case 'privacy': html = viewPrivacy(); break;
      default: html = viewNotFound(); break;
    }

    view.innerHTML = html;
    hydrateImages(view);
    wireView(route, view);
    renderChrome();
    document.body.classList.remove('nav-open');
    window.scrollTo(0, 0);
    if (state.ui && state.ui.searchValue !== null) {
      const si = $('#searchInput');
      if (si && document.activeElement !== si) si.value = state.ui.searchValue;
    }
  }

  /* Подстановка заглушки, если внешняя картинка не загрузилась */
  function hydrateImages(root) {
    $$('img[data-fb]', root || document).forEach(img => {
      if (img.dataset.bound === '1') return;
      img.dataset.bound = '1';
      img.addEventListener('error', () => {
        const fb = img.getAttribute('data-fb');
        if (fb && img.src !== fb) img.src = fb;
      });
      if (img.complete && img.naturalWidth === 0) {
        const fb = img.getAttribute('data-fb');
        if (fb) img.src = fb;
      }
    });
  }

  /* ------------------------------------------------------------------
     9. Карточка видео
     ------------------------------------------------------------------ */
  function publicVideos() {
    return state.videos.filter(v => v.visibility !== 'private');
  }

  function recommended(limit) {
    const now = Date.now();
    const scored = publicVideos().map(v => {
      const likes = Array.isArray(v.likes) ? v.likes.length : 0;
      const ageHours = Math.max(1, (now - v.createdAt) / 3600000);
      const score = (Number(v.views) || 0) + likes * 25 + 400 / Math.pow(ageHours, 0.28);
      return { v, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit || scored.length).map(s => s.v);
  }

  function videoCard(video, opts) {
    opts = opts || {};
    const channel = getUser(video.channelId);
    const thumb = thumbInfo(video);
    const likes = Array.isArray(video.likes) ? video.likes.length : 0;
    const badge = video.visibility === 'private' ? '<span class="vcard__vis">Приватное</span>' : '';
    const dur = video.duration ? '<span class="vcard__dur">' + esc(fmtDur(video.duration)) + '</span>' : '';
    const side = opts.hideChannel
      ? '<div class="vcard__meta">' +
        '<h3 class="vcard__title">' + esc(video.title) + '</h3>' +
        '<p class="vcard__sub">' + esc(viewsText(video.views)) + (likes ? ' &middot; ' + esc(fmtNum(likes) + ' ' + plural(likes, 'лайк', 'лайка', 'лайков')) : '') + '</p>' +
        '<p class="vcard__sub">' + esc(timeAgo(video.createdAt)) + '</p>' +
        '</div>'
      : '<div class="vcard__meta">' +
        '<h3 class="vcard__title">' + esc(video.title) + '</h3>' +
        '<p class="vcard__sub">' + esc(channel ? channel.name : 'Неизвестный канал') + '</p>' +
        '<p class="vcard__sub">' + esc(viewsText(video.views)) + ' &middot; ' + esc(timeAgo(video.createdAt)) + '</p>' +
        '</div>';

    return '<a class="vcard" href="#/watch/' + esc(video.id) + '" title="' + esc(video.title) + '">' +
      '<div class="vcard__thumb">' + badge +
      '<img src="' + esc(thumb.src) + '" data-fb="' + esc(thumb.fallback || placeholderThumb(video.id)) + '" alt="' + esc('Обложка: ' + video.title) + '">' +
      dur + '</div>' +
      '<div class="vcard__body">' + (opts.hideChannel ? '' : avatarImg(channel, '')) + side + '</div>' +
      '</a>';
  }

  /* ------------------------------------------------------------------
     10. Главная, поиск, статические страницы
     ------------------------------------------------------------------ */
  const ui = { category: 'Все', searchValue: '' };
  state.ui = ui;

  function viewHome() {
    const list = recommended();
    const filtered = ui.category === 'Все' ? list : list.filter(v => v.category === ui.category);
    const chips = CATEGORIES.map(c =>
      '<button class="chip' + (c === ui.category ? ' active' : '') + '" type="button" data-cat="' + esc(c) + '">' + esc(c) + '</button>').join('');

    if (!filtered.length) {
      return '<div class="chips">' + chips + '</div>' + emptyState(
        'Здесь пока нет видео',
        'Загрузите своё первое видео — оно появится в ленте. Всё останется на этом устройстве.'
      );
    }
    return '<div class="chips">' + chips + '</div>' +
      '<div class="grid">' + filtered.map(v => videoCard(v)).join('') + '</div>';
  }

  function viewSearch(query) {
    ui.searchValue = query;
    const q = String(query || '').trim().toLowerCase();
    if (!q) {
      return '<h1>Поиск</h1><p class="muted">Введите запрос в строке поиска сверху — найдём видео и каналы.</p>';
    }
    const videos = publicVideos().filter(v =>
      String(v.title).toLowerCase().includes(q) || String(v.description || '').toLowerCase().includes(q));
    const channels = state.users.filter(u => u.name.toLowerCase().includes(q));
    let html = '<h1>Результаты поиска: ' + esc(query) + '</h1>';
    if (channels.length) {
      html += '<h2>Каналы</h2><div class="stack narrow-sm" >' + channels.map(u =>
        '<a class="switch-item" href="#/channel/' + esc(u.id) + '">' + avatarImg(u, '') +
        '<span><b>' + esc(u.name) + '</b><br><span class="tiny">' + esc(videosText(myVideos(u.id).filter(v => v.visibility !== 'private').length)) + '</span></span></a>'
      ).join('') + '</div>';
    }
    html += '<h2 class="m-t-24">Видео</h2>';
    html += videos.length
      ? '<div class="grid">' + videos.map(v => videoCard(v)).join('') + '</div>'
      : '<p class="muted">Видео по этому запросу не найдено.</p>';
    return html;
  }

  function emptyState(title, text, actionHtml) {
    return '<div class="empty">' +
      '<svg viewBox="0 0 24 24" width="54" height="54" aria-hidden="true"><rect x="2.5" y="5" width="19" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 9.5 15 12l-4.5 2.5z" fill="currentColor"/></svg>' +
      '<h2>' + esc(title) + '</h2><p class="muted">' + esc(text) + '</p>' + (actionHtml || '') + '</div>';
  }

  function viewNotFound() {
    return '<div class="empty"><h2>Страница не найдена</h2>' +
      '<p class="muted">Возможно, ссылка устарела или видео было удалено.</p>' +
      '<p><a class="btn btn--primary" href="#/">На главную</a></p></div>';
  }

  function viewAbout() {
    return '<div class="narrow">' +
      '<h1>О проекте StrausTube</h1>' +
      '<p>StrausTube — демонстрационный видеохостинг. Это учебный интерфейс, который показывает, как может выглядеть платформа для публикации видео: лента, страницы каналов, плеер, комментарии и инструменты автора.</p>' +
      '<h2>Как хранятся данные</h2>' +
      '<p>Все данные — аккаунты, видео, комментарии — сохраняются <b>только в вашем браузере</b> (localStorage и IndexedDB) на этом устройстве. Сервер их не получает и не хранит: у проекта нет базы данных, аналитики, рекламы и внешних скриптов.</p>' +
      '<ul class="muted"><li>Пароли сохраняются в виде необратимого хеша (PBKDF2-SHA-256, Web Crypto API).</li>' +
      '<li>Очистка данных сайта в браузере полностью удаляет все аккаунты и видео.</li>' +
      '<li>Ссылки на внешние видео воспроизводятся через официальные встраиваемые плееры (например, youtube-nocookie).</li></ul>' +
      '<h2>Что нужно знать</h2>' +
      '<p>Пожалуйста, не используйте настоящие пароли: демонстрационный профиль не защищён серверной проверкой. Если вы публикуете ссылки на видео, убедитесь, что у вас есть право их распространять.</p>' +
      '<h2>Обратная связь</h2>' +
      '<p class="muted">Это самостоятельный учебный проект. Технические замечания и пожелания можно оставить в комментариях к любому видео.</p>' +
      '<div class="card"><b>Коротко для проверяющих сервисов:</b>' +
      '<p class="muted m-t-half" >Сайт не запрашивает платёжные данные, не устанавливает программы, не скачивает файлы и не перенаправляет на сторонние ресурсы. Все формы работают локально в браузере, сетевые запросы — только к официальному плееру и превью YouTube для видео, которые добавил сам пользователь.</p></div>' +
      '</div>';
  }

  function viewPrivacy() {
    return '<div class="narrow">' +
      '<h1>Конфиденциальность</h1>' +
      '<p>StrausTube не собирает персональные данные. Ниже — что именно происходит на этой странице.</p>' +
      '<h2>Какие данные хранятся и где</h2>' +
      '<ul class="muted">' +
      '<li><b>Аккаунты:</b> никнейм, аватар и хеш пароля — в localStorage вашего браузера.</li>' +
      '<li><b>Видео:</b> названия, описания, обложки; загруженные вами файлы — в IndexedDB вашего браузера.</li>' +
      '<li><b>Комментарии и лайки:</b> также в localStorage.</li></ul>' +
      '<h2>Сетевые запросы</h2>' +
      '<p class="muted">Единственные внешние обращения возникают, если вы сами добавили видео по ссылке: браузер загружает превью и встраиваемый плеер YouTube. При открытии чужого ролика YouTube получает технические данные (например, IP-адрес) как обычно при просмотре — это описано в правилах самого YouTube. У проекта нет своих серверов, аналитики и рекламных скриптов.</p>' +
      '<h2>Удаление данных</h2>' +
      '<p class="muted">Аккаунт удаляется в настройках профиля. Полностью очистить всё можно кнопкой «Восстановить демо-данные» в студии или через очистку данных сайта в браузере.</p>' +
      '</div>';
  }

  /* ------------------------------------------------------------------
     11. Страница просмотра видео
     ------------------------------------------------------------------ */
  function canEditVideo(video) {
    const me = currentUser();
    if (!me) return false;
    return me.id === video.channelId || isAdminActive();
  }

  function playerHtml(video) {
    if (video.source === 'youtube' && video.youtubeId) {
      return '<iframe src="https://www.youtube-nocookie.com/embed/' + esc(video.youtubeId) + '?rel=0" ' +
        'title="' + esc(video.title) + '" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" ' +
        'allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" ' +
        'allowfullscreen></iframe>';
    }
    if (video.source === 'url' && video.fileUrl && isHttpUrl(video.fileUrl)) {
      return '<video controls preload="metadata" src="' + esc(video.fileUrl) + '"></video>';
    }
    if (video.source === 'upload') {
      return '<div class="player__fallback" data-media="' + esc(video.id) + '">Загружаем видеофайл из памяти браузера…</div>';
    }
    return '<div class="player__fallback">' +
      '<div><b>Демонстрационное видео</b><p class="muted-note">' +
      'Файл не приложен: карточка создана внутри приложения. Владелец канала может добавить ссылку ' +
      'или файл через «Изменить».</p></div></div>';
  }

  function viewWatch(id) {
    const video = getVideo(id);
    if (!video) return viewNotFound();
    const canEdit = canEditVideo(video);
    if (video.visibility === 'private' && !canEdit) {
      return '<div class="empty"><h2>Видео недоступно</h2>' +
        '<p class="muted">Это приватная запись: её видит только владелец канала.</p>' +
        '<p><a class="btn" href="#/">На главную</a></p></div>';
    }

    if (!state.viewed.has(video.id)) {
      state.viewed.add(video.id);
      video.views = (Number(video.views) || 0) + 1;
      persistVideos();
    }

    const channel = getUser(video.channelId);
    const likes = Array.isArray(video.likes) ? video.likes : [];
    const me = currentUser();
    const liked = !!(me && likes.indexOf(me.id) !== -1);
    const channelVideos = myVideos(video.channelId).filter(v => v.visibility !== 'private' || canEditVideo(v));
    const nextUp = recommended(12).filter(v => v.id !== video.id).slice(0, 8);
    const commentList = commentsOf(video.id);

    const adminBar = isAdminActive()
      ? '<div class="admin-social m-b-14" ><b>Режим администратора активен.</b> ' +
        'Доступно редактирование и удаление любых записей, а также удаление комментариев.<br>' +
        '<button class="btn btn--sm m-t-10" type="button" id="adminEditVideo" >Изменить это видео</button> ' +
        '<button class="btn btn--sm btn--danger m-t-10" type="button" id="adminDeleteVideo" >Удалить это видео</button></div>'
      : '';

    const commentForm = me
      ? '<form class="row comment-form" id="commentForm" >' +
        avatarImg(me, '') +
        '<div class="grow"><textarea class="textarea" id="commentText" maxlength="1000" rows="2" ' +
        'placeholder="Введите комментарий (хранится локально, виден всем в этом браузере)"></textarea>' +
        '<div class="row m-t-8" ><span class="spacer"></span>' +
        '<button class="btn btn--ghost" type="reset">Отмена</button>' +
        '<button class="btn btn--primary" type="submit">Отправить</button></div></div></form>'
      : '<div class="card m-b-22" ><b>Войдите, чтобы оставить комментарий</b>' +
        '<p class="tiny m-b-08" >Аккаунты хранятся только в этом браузере.</p>' +
        '<a class="btn btn--primary btn--sm" href="#/login?next=' + encodeURIComponent('#/watch/' + video.id) + '">Войти</a></div>';

    return '<div class="watch">' +
      '<div>' +
      adminBar +
      '<div class="player">' + playerHtml(video) + '</div>' +
      '<h1 class="watch__title">' + esc(video.title) + '</h1>' +
      '<div class="watch__row">' +
      '<span class="watch__stats" id="viewCount">' + esc(viewsText(video.views)) + '</span>' +
      '<span class="watch__stats">&middot;</span>' +
      '<span class="watch__stats" id="whenText">' + esc(timeAgo(video.createdAt)) + '</span>' +
      '<span class="spacer"></span>' +
      '<div class="pill-group">' +
      '<button class="pill' + (liked ? ' on' : '') + '" type="button" id="likeBtn" aria-pressed="' + (liked ? 'true' : 'false') + '">' +
      '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M7 10.5 11 3.8c.5-.8 1.7-.5 1.9.4l.5 3.1h4.3c1.2 0 2 1.1 1.7 2.2l-1.6 6.3c-.2.8-.9 1.3-1.7 1.3H7z" fill="' + (liked ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 10.5H4.6v8.4H7z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
      '<span id="likeLabel">' + esc(fmtNum(likes.length) + ' ' + plural(likes.length, 'лайк', 'лайка', 'лайков')) + '</span></button>' +
      '<button class="pill" type="button" id="shareBtn">' +
      '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M9 12.5 15 8.7M9 12.5l6 3.8" stroke="currentColor" stroke-width="1.7" fill="none"/><circle cx="7" cy="12.5" r="2.6" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="16.5" cy="7" r="2.6" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="16.5" cy="18" r="2.6" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>' +
      '<span>Поделиться</span></button>' +
      (canEdit ? '<button class="pill" type="button" id="editVideoBtn">Изменить</button>' +
        '<button class="pill" type="button" id="deleteVideoBtn">Удалить</button>' : '') +
      '</div></div>' +

      '<div class="chanline">' +
      avatarImg(channel, '') +
      '<div class="chanline__text"><b>' + esc(channel ? channel.name : 'Неизвестный канал') + '</b>' +
      '<span>' + esc(channel ? videosText(channelVideos.length) : '') + '</span></div>' +
      '<span class="spacer"></span>' +
      (channel ? '<a class="btn btn--sm" href="#/channel/' + esc(channel.id) + '">Перейти на канал</a>' : '') +
      '</div>' +

      '<div class="desc">' + esc(video.description || 'Описание не добавлено.') +
      '<div class="tiny m-t-10" >Категория: ' + esc(video.category || 'Разное') +
      (video.visibility === 'private' ? ' &middot; Приватное видео' : '') +
      ' &middot; Источник: ' + esc(video.source === 'youtube' ? 'встроенный плеер YouTube' : (video.source === 'upload' ? 'файл из памяти браузера' : (video.source === 'url' ? 'прямая ссылка' : 'демонстрационная карточка'))) +
      '</div></div>' +

      '<section class="comments">' +
      '<h3>' + esc(commentsText(commentList.length)) + '</h3>' +
      commentForm +
      '<div id="commentList">' + commentList.map(c => commentHtml(c)).join('') + '</div>' +
      '</section>' +
      '</div>' +

      '<aside class="reco">' +
      '<h3>Дальше по теме</h3>' +
      nextUp.map(v => videoCard(v)).join('') +
      '</aside>' +
      '</div>';
  }

  function commentHtml(c) {
    const author = getUser(c.authorId);
    const me = currentUser();
    const canDelete = !!(me && (me.id === c.authorId || isAdminActive()));
    return '<div class="comment" data-comment="' + esc(c.id) + '">' +
      avatarImg(author, '') +
      '<div class="comment__body">' +
      '<div class="comment__head">' + esc(author ? author.name : 'Удалённый пользователь') +
      '<span>' + esc(timeAgo(c.createdAt)) + '</span></div>' +
      '<p class="comment__text">' + esc(c.text) + '</p>' +
      (canDelete ? '<div class="comment__tools"><button class="link-btn" type="button" data-del-comment="' + esc(c.id) + '">Удалить</button></div>' : '') +
      '</div></div>';
  }

  async function hydrateLocalMedia(root, videoId) {
    const holder = $('[data-media="' + videoId + '"]', root);
    if (!holder) return;
    try {
      const blob = await idbGet(videoId);
      if (!blob) {
        holder.innerHTML = '<div><b>Файл не найден на этом устройстве</b>' +
          '<p class="muted-note">Видеофайлы хранятся в памяти браузера. ' +
          'Похоже, файл был удалён или открыт в другом браузере. Владелец канала может загрузить его заново.</p></div>';
        return;
      }
      const url = URL.createObjectURL(blob);
      state.mediaUrls.push(url);
      holder.outerHTML = '<video controls autoplay preload="metadata" src="' + esc(url) + '"></video>';
    } catch (e) {
      holder.textContent = 'Не удалось открыть видеофайл: ' + e.message;
    }
  }

  /* ------------------------------------------------------------------
     12. Страница канала
     ------------------------------------------------------------------ */
  function viewChannel(id) {
    const user = getUser(id);
    if (!user) {
      return '<div class="empty"><h2>Канал не найден</h2>' +
        '<p class="muted">Возможно, пользователь удалил профиль.</p>' +
        '<p><a class="btn btn--primary" href="#/">На главную</a></p></div>';
    }
    const me = currentUser();
    const own = !!(me && me.id === user.id);
    const tab = (lastRoute.params.get('tab') === 'about') ? 'about' : 'videos';
    const all = myVideos(user.id);
    const visible = all.filter(v => v.visibility !== 'private' || own || isAdminActive());
    const totalViews = visible.reduce((acc, v) => acc + (Number(v.views) || 0), 0);

    const tabs =
      '<div class="tabs">' +
      '<a class="tab' + (tab === 'videos' ? ' active' : '') + '" href="#/channel/' + esc(user.id) + '">Видео</a>' +
      '<a class="tab' + (tab === 'about' ? ' active' : '') + '" href="#/channel/' + esc(user.id) + '?tab=about">О канале</a>' +
      '</div>';

    let body;
    if (tab === 'about') {
      body = '<div class="narrow-md">' +
        '<div class="card">' +
        '<h2 class="m-t-0">О канале</h2>' +
        '<p><b>' + esc(user.name) + '</b> — канал в демонстрационном видеохостинге StrausTube.</p>' +
        '<p class="muted">Видео на канале: ' + esc(videosText(visible.length)) + '<br>' +
        'Суммарные просмотры: ' + esc(fmtNum(totalViews)) + '<br>' +
        'Профиль создан: ' + esc(fmtDate(user.createdAt)) + '</p>' +
        (me && me.id === user.id ? '<p class="tiny">Это ваш канал. Имя и аватар меняются в разделе «Редактировать профиль».</p>' : '') +
        '</div></div>';
    } else {
      body = visible.length
        ? '<div class="grid">' + visible.map(v => videoCard(v)).join('') + '</div>'
        : emptyState('На канале пока нет видео',
          own ? 'Загрузите первое видео — оно появится здесь и в общей ленте.' : 'Автор ещё ничего не опубликовал.',
          own ? '<a class="btn btn--primary" href="#/upload">Загрузить видео</a>' : '');
    }

    return '<div class="banner"></div>' +
      '<div class="channel-head">' +
      avatarImg(user, 'av--xl') +
      '<div class="channel-head__info">' +
      '<h1>' + esc(user.name) + (user.isAdmin && isAdminActive() ? ' <span class="badge">служебный</span>' : '') + '</h1>' +
      '<div class="channel-head__sub">@' + esc(user.name.toLowerCase().replace(/\s+/g, '')) + ' &middot; ' +
      esc(videosText(visible.length)) + ' &middot; ' + esc(fmtNum(totalViews)) + ' просмотров</div>' +
      '<p class="tiny m-t-half" >' + esc(String(user.name).slice(0, 1).toUpperCase() + ' о канале: демонстрационный профиль, данные хранятся локально.') + '</p>' +
      '</div>' +
      '<span class="spacer"></span>' +
      (own
        ? '<div class="row"><button class="btn" type="button" id="editProfileBtn2">Настроить профиль</button>' +
          '<a class="btn btn--primary" href="#/upload">Загрузить видео</a></div>'
        : '') +
      '</div>' +
      tabs + body;
  }

  /* ------------------------------------------------------------------
     13. Студия автора
     ------------------------------------------------------------------ */
  function viewStudio() {
    const me = currentUser();
    if (!me) {
      return '<div class="empty"><h2>Нужен вход</h2>' +
        '<p class="muted">Студия доступна только авторизованным пользователям.</p>' +
        '<p><a class="btn btn--primary" href="#/login">Войти или зарегистрироваться</a></p></div>';
    }
    const mine = myVideos(me.id);
    const totalViews = mine.reduce((a, v) => a + (Number(v.views) || 0), 0);
    const totalLikes = mine.reduce((a, v) => a + (Array.isArray(v.likes) ? v.likes.length : 0), 0);
    const myIds = mine.map(v => v.id);
    const totalComments = state.comments.filter(c => myIds.indexOf(c.videoId) !== -1).length;

    const rows = mine.length ? mine.map(v => {
      const thumb = thumbInfo(v);
      const likes = Array.isArray(v.likes) ? v.likes.length : 0;
      const com = commentsOf(v.id).length;
      return '<tr>' +
        '<td><img class="thumb-mini" src="' + esc(thumb.src) + '" data-fb="' + esc(thumb.fallback || placeholderThumb(v.id)) + '" alt=""></td>' +
        '<td><a href="#/watch/' + esc(v.id) + '"><b>' + esc(v.title) + '</b></a>' +
        '<div class="tiny">' + esc(v.category || 'Разное') + ' &middot; ' +
        (v.visibility === 'private' ? '<span class="text-warn">приватное</span>' : 'публичное') + '</div></td>' +
        '<td>' + esc(fmtNum(v.views)) + '</td>' +
        '<td>' + esc(fmtNum(likes)) + '</td>' +
        '<td>' + esc(fmtNum(com)) + '</td>' +
        '<td class="tiny">' + esc(fmtDate(v.createdAt)) + '</td>' +
        '<td><div class="row">' +
        '<a class="btn btn--sm" href="#/watch/' + esc(v.id) + '">Открыть</a>' +
        '<button class="btn btn--sm" type="button" data-edit="' + esc(v.id) + '">Изменить</button>' +
        '<button class="btn btn--sm btn--danger" type="button" data-del="' + esc(v.id) + '">Удалить</button>' +
        '</div></td></tr>';
    }).join('') : '';

    return '<div class="section-head"><div><h1>Моя студия</h1>' +
      '<p class="tiny">Управление вашим каналом. Данные хранятся только в этом браузере.</p></div>' +
      '<span class="spacer"></span><a class="btn btn--primary" href="#/upload">Загрузить видео</a></div>' +

      '<div class="studio-grid">' +
      '<div class="stat"><span>Видео на канале</span><b>' + esc(String(mine.length)) + '</b></div>' +
      '<div class="stat"><span>Просмотры</span><b>' + esc(fmtNum(totalViews)) + '</b></div>' +
      '<div class="stat"><span>Лайки</span><b>' + esc(fmtNum(totalLikes)) + '</b></div>' +
      '<div class="stat"><span>Комментарии</span><b>' + esc(fmtNum(totalComments)) + '</b></div>' +
      '</div>' +

      '<h2 class="m-t-28">Ваши видео</h2>' +
      (mine.length
        ? '<div class="scroll-x"><table class="table"><thead><tr>' +
          '<th>Обложка</th><th>Название</th><th>Просмотры</th><th>Лайки</th><th>Комментарии</th><th>Дата</th><th>Действия</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        : emptyState('Видео пока нет', 'Загрузите первое видео — оно появится в общей ленте и на странице канала.',
          '<a class="btn btn--primary" href="#/upload">Загрузить видео</a>')) +

      '<div class="card m-t-28" >' +
      '<h3 class="m-t-0">Служебные действия</h3>' +
      '<p class="tiny">Эти кнопки работают только в вашем браузере и помогают вернуть демонстрационное состояние.</p>' +
      '<div class="row row--wrap">' +
      '<button class="btn" type="button" id="editProfileBtn3">Редактировать профиль</button>' +
      '<button class="btn" type="button" id="changeAvatarBtn">Сменить аватар по ссылке</button>' +
      '<button class="btn" type="button" id="exportBtn">Выгрузить мои данные (JSON)</button>' +
      '<button class="btn btn--danger" type="button" id="resetDemoBtn">Восстановить демо-данные</button>' +
      '</div></div>';
  }

  /* ------------------------------------------------------------------
     14. Загрузка видео
     ------------------------------------------------------------------ */
  function viewUpload() {
    const me = currentUser();
    if (!me) {
      return '<div class="empty"><h2>Нужен вход</h2>' +
        '<p class="muted">Чтобы загрузить видео, войдите в аккаунт или зарегистрируйтесь.</p>' +
        '<p><a class="btn btn--primary" href="#/login?next=' + encodeURIComponent('#/upload') + '">Войти</a> ' +
        '<a class="btn" href="#/">Смотреть без входа</a></p></div>';
    }
    const cats = CATEGORIES.filter(c => c !== 'Все');
    return '<div class="section-head"><h1>Загрузка видео</h1></div>' +
      '<div class="upload-grid">' +
      '<form class="card" id="uploadForm" autocomplete="off">' +
      '<label class="field"><span>Название *</span>' +
      '<input class="input" id="upTitle" maxlength="120" required placeholder="Например: Обзор новых возможностей StrausTube"></label>' +

      '<label class="field"><span>Описание</span>' +
      '<textarea class="textarea" id="upDesc" maxlength="4000" placeholder="О чём это видео? Описание увидят зрители ниже плеера."></textarea></label>' +

      '<div class="row row--wrap gap-14" >' +
      '<label class="field grow grow-180" ><span>Категория</span>' +
      '<select class="select" id="upCategory">' + cats.map(c => '<option>' + esc(c) + '</option>').join('') + '</select></label>' +
      '<label class="field grow grow-150" ><span>Длительность (мм:сс)</span>' +
      '<input class="input" id="upDuration" placeholder="3:45" inputmode="numeric"></label>' +
      '</div>' +

      '<div class="field"><span>Источник видео</span>' +
      '<div class="pill-group" id="sourceGroup">' +
      '<label class="pill"><input type="radio" name="source" value="youtube" checked> Ссылка YouTube</label>' +
      '<label class="pill"><input type="radio" name="source" value="url"> Прямая ссылка</label>' +
      '<label class="pill"><input type="radio" name="source" value="file"> Файл с устройства</label>' +
      '<label class="pill"><input type="radio" name="source" value="placeholder"> Без плеера</label>' +
      '</div></div>' +

      '<div id="srcYoutube">' +
      '<label class="field"><span>Ссылка на видео YouTube</span>' +
      '<input class="input" id="upYoutube" placeholder="https://www.youtube.com/watch?v=..."></label>' +
      '<div id="ytPreview" class="tiny"></div></div>' +

      '<div id="srcUrl" hidden>' +
      '<label class="field"><span>Прямая ссылка на видеофайл (MP4/WebM)</span>' +
      '<input class="input" id="upUrl" placeholder="https://example.com/video.mp4"></label></div>' +

      '<div id="srcFile" hidden>' +
      '<label class="field"><span>Файл с устройства</span>' +
      '<input class="input" type="file" id="upFile" accept="video/mp4,video/webm,video/ogg,video/quicktime,video/*"></label>' +
      '<p class="hint">Файл сохраняется в памяти браузера (IndexedDB) и никуда не отправляется. Файлы больше ~200 МБ могут не сохраниться.</p></div>' +

      '<div id="srcThumb">' +
      '<label class="field"><span>Ссылка на обложку (необязательно)</span>' +
      '<input class="input" id="upThumb" placeholder="https://.../preview.jpg"></label>' +
      '<p class="hint">Если оставить пустым, обложка будет сгенерирована автоматически.</p></div>' +

      '<label class="row m-check" ><input type="checkbox" id="upPrivate"> ' +
      '<span>Приватное видео (видно только вам)</span></label>' +

      '<div id="uploadError" class="error" hidden></div>' +
      '<div class="row"><span class="spacer"></span>' +
      '<button class="btn btn--primary" type="submit" id="uploadSubmit">Опубликовать</button></div>' +
      '</form>' +

      '<div class="stack">' +
      '<div class="card"><h3 class="m-t-0">Предпросмотр карточки</h3>' +
      '<div class="preview-thumb" id="thumbPreview"><img src="' + esc(placeholderThumb('preview')) + '" alt="Предпросмотр обложки"></div>' +
      '<p class="tiny m-t-10"  id="previewTitle">Название появится здесь</p></div>' +
      '<div class="card"><h3 class="m-t-0">Как это работает</h3>' +
      '<ul class="muted tiny list-tight" >' +
      '<li>Видео и данные хранятся только в вашем браузере.</li>' +
      '<li>Для ссылок YouTube используется официальный встраиваемый плеер.</li>' +
      '<li>Прямая ссылка должна указывать на файл MP4/WebM, который разрешено воспроизводить.</li>' +
      '<li>Убедитесь, что у вас есть права на публикуемое видео.</li>' +
      '</ul></div>' +
      '</div>' +
      '</div>';
  }

  /* ------------------------------------------------------------------
     15. Вход и регистрация
     ------------------------------------------------------------------ */
  function viewLogin(nextHash) {
    const next = nextHash || '#/';
    const avatars = defaultAvatars();
    const me = currentUser();
    const guestNote = me ? '<p class="tiny text-center" >Вы уже вошли как <b>' + esc(me.name) + '</b>. ' +
      '<a href="#/">Продолжить</a></p>' : '';
    return '<div class="auth-wrap"><div class="auth">' +
      '<h1>StrausTube</h1>' +
      '<p class="auth__sub">Демонстрационный аккаунт: всё хранится только в этом браузере</p>' +
      '<div class="tabs-switch" role="tablist">' +
      '<button type="button" class="active" data-auth-tab="login" role="tab">Вход</button>' +
      '<button type="button" data-auth-tab="register" role="tab">Регистрация</button>' +
      '</div>' +

      '<form id="loginForm" autocomplete="on">' +
      '<label class="field"><span>Никнейм</span>' +
      '<input class="input" id="loginName" name="username" autocomplete="username" maxlength="24" required></label>' +
      '<label class="field"><span>Пароль</span>' +
      '<input class="input" type="password" id="loginPass" name="password" autocomplete="current-password" maxlength="72" required></label>' +
      '<div id="loginError" class="error" hidden></div>' +
      '<button class="btn btn--primary btn-wide" type="submit" >Войти</button>' +
      '</form>' +

      '<form id="registerForm" hidden autocomplete="on">' +
      '<label class="field"><span>Никнейм *</span>' +
      '<input class="input" id="regName" name="new-username" autocomplete="username" maxlength="24" required placeholder="2–24 символа"></label>' +
      '<label class="field"><span>Пароль *</span>' +
      '<input class="input" type="password" id="regPass" name="new-password" autocomplete="new-password" maxlength="72" required placeholder="Не менее 6 символов"></label>' +
      '<label class="field"><span>Повторите пароль *</span>' +
      '<input class="input" type="password" id="regPass2" name="confirm-password" autocomplete="new-password" maxlength="72" required></label>' +
      '<div class="field"><span>Аватар</span><div class="avatars" id="regAvatars">' +
      avatars.map((a, i) => '<button type="button" data-av="' + esc(a.url) + '"' + (i === 0 ? ' class="sel"' : '') + '>' +
        '<img class="av" src="' + esc(a.url) + '" alt="Вариант аватара ' + (i + 1) + '"></button>').join('') +
      '</div></div>' +
      '<div id="regError" class="error" hidden></div>' +
      '<button class="btn btn--primary btn-wide" type="submit" >Создать аккаунт</button>' +
      '</form>' +

      '<div class="priv-note">Пароль превращается в необратимый хеш (PBKDF2-SHA-256) и остаётся на этом устройстве. ' +
      'Пожалуйста, не используйте свои реальные пароли: проект демонстрационный.</div>' +
      guestNote +
      '<p class="tiny text-center m-t-14" ><a href="#/">Смотреть без входа</a></p>' +
      '</div></div>' +
      '<input type="hidden" id="authNext" value="' + esc(next) + '">';
  }

  /* ------------------------------------------------------------------
     16. Модальные окна и диалоги
     ------------------------------------------------------------------ */
  let modalEscHandler = null;

  function openModal(opts) {
    closeModal();
    const host = $('#modals');
    host.innerHTML = '<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-label="' + esc(opts.title) + '">' +
      '<div class="modal__head"><h3>' + esc(opts.title) + '</h3>' +
      '<button class="icon-btn" type="button" id="modalClose" aria-label="Закрыть">&times;</button></div>' +
      (opts.body || '') +
      (opts.footer ? '<div class="row modal__footer" >' + opts.footer + '</div>' : '') +
      '</div></div>';
    const back = $('.modal-back', host);
    back.addEventListener('mousedown', ev => { if (ev.target === back) closeModal(); });
    $('#modalClose', host).addEventListener('click', closeModal);
    modalEscHandler = ev => { if (ev.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', modalEscHandler);
    const box = $('.modal', host);
    if (opts.onMount) opts.onMount(box);
    return box;
  }

  function closeModal() {
    $('#modals').innerHTML = '';
    if (modalEscHandler) { document.removeEventListener('keydown', modalEscHandler); modalEscHandler = null; }
  }

  function confirmModal(title, bodyHtml, confirmLabel, onConfirm) {
    openModal({
      title,
      body: bodyHtml,
      footer: '<button class="btn" type="button" id="cfCancel">Отмена</button>' +
        '<button class="btn btn--danger" type="button" id="cfOk">' + esc(confirmLabel) + '</button>',
      onMount(box) {
        $('#cfCancel', box).addEventListener('click', closeModal);
        $('#cfOk', box).addEventListener('click', () => { closeModal(); onConfirm(); });
      }
    });
  }

  /* ------------------------------------------------------------------
     17. Профиль, смена аккаунта, экспорт
     ------------------------------------------------------------------ */
  const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]{1,23}$/u;

  function validName(name) {
    let re = NAME_RE;
    try { re.test('а'); } catch (e) { re = /^[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9 _.\-]{1,23}$/; }
    return re.test(name);
  }

  function resizeImageToDataUrl(file, size) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Файл не похож на изображение'));
        img.onload = () => {
          const side = Math.min(img.width, img.height);
          const canvas = document.createElement('canvas');
          canvas.width = size; canvas.height = size;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
          try { resolve(canvas.toDataURL('image/jpeg', 0.85)); }
          catch (e) { reject(new Error('Не удалось обработать изображение')); }
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  function openProfileEditor(user) {
    if (!user) return;
    let draftAvatar = user.avatar || avatarFor(user);
    const avatars = defaultAvatars();

    openModal({
      title: 'Редактировать профиль',
      body:
        '<div class="row m-b-14" ><img class="av av--lg" id="peAvatarImg" src="' + esc(draftAvatar) + '" alt="Текущий аватар">' +
        '<div><b>' + esc(user.name) + '</b><div class="tiny">Профиль хранится в этом браузере</div></div></div>' +
        '<div class="field"><span>Готовые аватары</span><div class="avatars" id="peAvatars">' +
        avatars.map(a => '<button type="button" data-av="' + esc(a.url) + '">' + '<img class="av" src="' + esc(a.url) + '" alt="Аватар"></button>').join('') +
        '</div></div>' +
        '<label class="field"><span>Аватар по ссылке</span><input class="input" id="peAvatarUrl" placeholder="https://example.com/avatar.jpg"></label>' +
        '<label class="field"><span>Или файл с устройства (обрежем в квадрат)</span><input class="input" type="file" id="peAvatarFile" accept="image/*"></label>' +
        '<div class="divider"></div>' +
        '<label class="field"><span>Никнейм</span><input class="input" id="peName" maxlength="24" value="' + esc(user.name) + '"></label>' +
        '<div class="error" id="peError" hidden></div>' +
        '<div class="warn-box">Удаление аккаунта необратимо: вместе с ним исчезнут ваши видео, комментарии и лайки.</div>' +
        '<button class="btn btn--danger btn--sm" type="button" id="peDelete">Удалить аккаунт</button>',
      footer: '<button class="btn" type="button" id="peCancel">Отмена</button>' +
        '<button class="btn btn--primary" type="button" id="peSave">Сохранить</button>',
      onMount(box) {
        const img = $('#peAvatarImg', box);
        const err = $('#peError', box);
        const showError = msg => { err.textContent = msg; err.hidden = false; };
        const clearError = () => { err.hidden = true; };

        $$('#peAvatars button', box).forEach(btn => btn.addEventListener('click', () => {
          draftAvatar = btn.getAttribute('data-av');
          img.src = draftAvatar;
          $$('#peAvatars button', box).forEach(b => b.classList.remove('sel'));
          btn.classList.add('sel');
        }));

        $('#peAvatarUrl', box).addEventListener('change', ev => {
          const val = ev.target.value.trim();
          if (!val) return;
          if (!isHttpUrl(val)) { showError('Ссылка должна начинаться с http:// или https://'); return; }
          clearError();
          draftAvatar = val;
          img.src = val;
        });

        $('#peAvatarFile', box).addEventListener('change', async ev => {
          const file = ev.target.files && ev.target.files[0];
          if (!file) return;
          if (!/^image\//.test(file.type)) { showError('Выберите файл изображения'); return; }
          try {
            draftAvatar = await resizeImageToDataUrl(file, 176);
            img.src = draftAvatar;
            clearError();
          } catch (e) { showError(e.message); }
        });

        $('#peCancel', box).addEventListener('click', closeModal);

        $('#peSave', box).addEventListener('click', () => {
          const name = $('#peName', box).value.trim();
          if (!validName(name)) { showError('Никнейм: 2–24 символа, буквы, цифры, пробел, точка, дефис или подчёркивание'); return; }
          const clash = findUserByName(name);
          if (clash && clash.id !== user.id) { showError('Такой никнейм уже занят в этом браузере'); return; }
          user.name = name;
          user.avatar = draftAvatar;
          persistUsers();
          closeModal();
          renderChrome();
          render();
          toast('Профиль обновлён', 'ok');
        });

        $('#peDelete', box).addEventListener('click', () => {
          if (user.isAdmin) { showError('Служебный профиль администратора удалить нельзя'); return; }
          openModal({
            title: 'Удаление аккаунта',
            body: '<p>Это действие необратимо. Введите никнейм <b>' + esc(user.name) + '</b>, чтобы подтвердить.</p>' +
              '<label class="field"><span>Никнейм</span><input class="input" id="daName"></label>' +
              '<div class="error" id="daError" hidden></div>',
            footer: '<button class="btn" type="button" id="daCancel">Отмена</button>' +
              '<button class="btn btn--danger" type="button" id="daOk">Удалить навсегда</button>',
            onMount(box2) {
              $('#daCancel', box2).addEventListener('click', closeModal);
              $('#daOk', box2).addEventListener('click', () => {
                const typed = $('#daName', box2).value.trim();
                if (typed.toLowerCase() !== user.name.toLowerCase()) {
                  const e2 = $('#daError', box2); e2.textContent = 'Никнейм не совпадает'; e2.hidden = false;
                  return;
                }
                deleteUserCascade(user.id);
                closeModal();
                if (currentUser() && currentUser().id === user.id) logoutLocal();
                renderChrome(); render();
                toast('Аккаунт удалён', 'ok');
              });
            }
          });
        });
      }
    });
  }

  async function deleteUserCascade(userId) {
    const victims = state.videos.filter(v => v.channelId === userId);
    for (const v of victims) {
      if (v.source === 'upload') await idbDelete(v.id);
      state.comments = state.comments.filter(c => c.videoId !== v.id);
    }
    state.videos = state.videos.filter(v => v.channelId !== userId);
    state.comments = state.comments.filter(c => c.authorId !== userId);
    state.videos.forEach(v => {
      if (Array.isArray(v.likes)) v.likes = v.likes.filter(id => id !== userId);
    });
    state.users = state.users.filter(u => u.id !== userId);
    persistUsers(); persistVideos(); persistComments();
    ensureSession();
    if (state.session.as === userId) { state.session.as = null; persistSession(); }
    if (state.ride === userId) state.ride = null;
  }

  function logoutLocal() {
    state.ride = null;
    ensureSession();
    state.session.as = null;
    persistSession();
  }

  function openAccountSwitcher() {
    const me = currentUser();
    const list = state.users.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    openModal({
      title: 'Смена аккаунта',
      body: '<p class="tiny">Список профилей в этом браузере. Профили без пароля — демонстрационные, вход в них свободный.</p>' +
        '<div class="switch-list">' + list.map(u =>
        '<button class="switch-item" type="button" data-user="' + esc(u.id) + '">' + avatarImg(u, '') +
        '<span class="grow"><b>' + esc(u.name) + '</b>' +
        (u.id === (me && me.id) ? ' <span class="tiny">(текущий)</span>' : '') +
        '<br><span class="tiny">' + (u.password ? 'защищён паролем' : 'демо-профиль без пароля') +
        (u.isAdmin ? ' &middot; служебный' : '') + '</span></span>' +
        '<span class="btn btn--sm">Войти</span></button>').join('') + '</div>' +
        '<div id="swBlock" hidden class="m-t-14">' +
        '<label class="field"><span>Пароль профиля</span><input class="input" type="password" id="swPass"></label>' +
        '<div class="error" id="swError" hidden></div></div>',
      footer: '<a class="btn" href="#/login" id="swNew">Создать новый аккаунт</a>',
      onMount(box) {
        let pending = null;
        $('#swNew', box).addEventListener('click', closeModal);
        $$('[data-user]', box).forEach(btn => btn.addEventListener('click', async () => {
          const user = getUser(btn.getAttribute('data-user'));
          if (!user) return;
          ensureSession();
          if (!user.password) {
            state.ride = null;
            state.session.as = user.id;
            persistSession();
            closeModal(); renderChrome(); render();
            toast('Вы вошли как ' + user.name, 'ok');
            return;
          }
          pending = user;
          const block = $('#swBlock', box);
          block.hidden = false;
          $('#swPass', box).value = '';
          $('#swPass', box).focus();
          $('#swError', box).hidden = true;
        }));
        $('#swPass', box).addEventListener('keydown', async ev => {
          if (ev.key !== 'Enter') return;
          if (!pending) return;
          const ok = await verifyPassword($('#swPass', box).value, pending.password);
          if (!ok) {
            const e = $('#swError', box); e.textContent = 'Неверный пароль'; e.hidden = false;
            return;
          }
          ensureSession();
          state.ride = null;
          state.session.as = pending.id;
          persistSession();
          closeModal(); renderChrome(); render();
          toast('Вы вошли как ' + pending.name, 'ok');
        });
      }
    });
  }

  function exportMyData() {
    const me = currentUser();
    if (!me) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      note: 'Локальная выгрузка данных демонстрационного профиля StrausTube',
      user: { id: me.id, name: me.name, createdAt: me.createdAt },
      videos: state.videos.filter(v => v.channelId === me.id),
      comments: state.comments.filter(c => c.authorId === me.id)
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'straustube-' + me.name.replace(/[^\w.-]/g, '_') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Файл выгружен', 'ok');
  }

  /* ------------------------------------------------------------------
     18. Работа с видео: создание, правка, удаление, комментарии
     ------------------------------------------------------------------ */
  function openVideoEditor(video, isNew) {
    const me = currentUser();
    if (!me) return;
    const cats = CATEGORIES.filter(c => c !== 'Все');
    const src = video ? video.source : 'placeholder';

    openModal({
      title: isNew ? 'Новое видео' : 'Изменить видео',
      body:
        '<label class="field"><span>Название *</span><input class="input" id="veTitle" maxlength="120" value="' + esc(video ? video.title : '') + '"></label>' +
        '<label class="field"><span>Описание</span><textarea class="textarea" id="veDesc" maxlength="4000">' + esc(video ? (video.description || '') : '') + '</textarea></label>' +
        '<div class="row row--wrap gap-12" >' +
        '<label class="field grow grow-160" ><span>Категория</span><select class="select" id="veCat">' +
        cats.map(c => '<option' + (video && video.category === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></label>' +
        '<label class="field grow grow-160" ><span>Длительность (мм:сс)</span><input class="input" id="veDur" value="' + esc(video && video.duration ? fmtDur(video.duration) : '') + '" placeholder="3:45"></label>' +
        '</div>' +
        '<label class="field"><span>Ссылка на YouTube (если это встроенное видео)</span>' +
        '<input class="input" id="veYoutube" value="' + esc(video && video.source === 'youtube' && video.youtubeId ? 'https://www.youtube.com/watch?v=' + video.youtubeId : '') + '" placeholder="оставьте пустым, если ссылки нет"></label>' +
        '<label class="field"><span>Прямая ссылка на файл MP4/WebM</span>' +
        '<input class="input" id="veUrl" value="' + esc(video && video.source === 'url' ? (video.fileUrl || '') : '') + '" placeholder="https://example.com/video.mp4"></label>' +
        '<label class="field"><span>Ссылка на обложку</span>' +
        '<input class="input" id="veThumb" value="' + esc(video && video.thumbUrl ? video.thumbUrl : '') + '" placeholder="оставьте пустым для автообложки"></label>' +
        '<label class="row"><input type="checkbox" id="vePrivate"' + (video && video.visibility === 'private' ? ' checked' : '') + '><span>Приватное видео</span></label>' +
        '<div class="error" id="veError" hidden></div>' +
        (isNew ? '<p class="hint">Источник определится автоматически: ссылка YouTube, прямая ссылка на файл или карточка без плеера.</p>' : ''),
      footer: '<button class="btn" type="button" id="veCancel">Отмена</button>' +
        '<button class="btn btn--primary" type="button" id="veSave">Сохранить</button>',
      onMount(box) {
        $('#veCancel', box).addEventListener('click', closeModal);
        $('#veSave', box).addEventListener('click', () => {
          const err = $('#veError', box);
          const title = $('#veTitle', box).value.trim();
          if (title.length < 2) { err.textContent = 'Название должно быть не короче 2 символов'; err.hidden = false; return; }
          const ytRaw = $('#veYoutube', box).value.trim();
          const urlRaw = $('#veUrl', box).value.trim();
          const thumbRaw = $('#veThumb', box).value.trim();
          if (urlRaw && !isHttpUrl(urlRaw)) { err.textContent = 'Прямая ссылка должна начинаться с http:// или https://'; err.hidden = false; return; }
          if (thumbRaw && !isHttpUrl(thumbRaw)) { err.textContent = 'Ссылка на обложку должна начинаться с http:// или https://'; err.hidden = false; return; }

          const target = video || {
            id: uid('v'), channelId: me.id, views: 0, likes: [], createdAt: Date.now()
          };
          const ytId = parseYouTubeId(ytRaw);
          target.title = title;
          target.description = $('#veDesc', box).value.trim();
          target.category = $('#veCat', box).value;
          target.visibility = $('#vePrivate', box).checked ? 'private' : 'public';
          if (thumbRaw) target.thumbUrl = thumbRaw; else delete target.thumbUrl;
          const dur = parseDuration($('#veDur', box).value);
          if (dur) target.duration = dur;

          if (ytId) {
            target.source = 'youtube';
            target.youtubeId = ytId;
            delete target.fileUrl;
          } else if (urlRaw) {
            target.source = 'url';
            target.fileUrl = urlRaw;
            delete target.youtubeId;
          } else if (target.source === 'youtube') {
            target.source = 'placeholder';
            delete target.youtubeId;
          }

          if (isNew) state.videos.unshift(target);
          persistVideos();
          closeModal();
          toast(isNew ? 'Видео опубликовано' : 'Изменения сохранены', 'ok');
          if (isNew) go('#/watch/' + target.id); else render();
        });
      }
    });
  }

  function deleteVideo(video, afterText) {
    const com = commentsOf(video.id).length;
    confirmModal('Удалить видео?',
      '<p><b>' + esc(video.title) + '</b></p>' +
      '<p class="muted">Вместе с видео исчезнут ' + esc(commentsText(com)) + ' и лайки. Если видео загружено файлом, файл будет удалён из памяти браузера.</p>',
      'Удалить',
      async () => {
        if (video.source === 'upload') await idbDelete(video.id);
        state.videos = state.videos.filter(v => v.id !== video.id);
        state.comments = state.comments.filter(c => c.videoId !== video.id);
        persistVideos(); persistComments();
        toast(afterText || 'Видео удалено', 'ok');
        if (parseRoute().name === 'watch' && parseRoute().param === video.id) go('#/'); else render();
      });
  }

  async function toggleLike(video) {
    const me = currentUser();
    if (!me) { toast('Войдите, чтобы ставить лайки', 'err'); return false; }
    if (!Array.isArray(video.likes)) video.likes = [];
    const idx = video.likes.indexOf(me.id);
    if (idx === -1) video.likes.push(me.id); else video.likes.splice(idx, 1);
    persistVideos();
    return idx === -1;
  }

  async function addComment(videoId, text) {
    const me = currentUser();
    if (!me) return false;
    const clean = String(text || '').trim();
    if (!clean) return false;
    state.comments.push({ id: uid('c'), videoId, authorId: me.id, text: clean.slice(0, 1000), createdAt: Date.now() });
    persistComments();
    return true;
  }

  /* ------------------------------------------------------------------
     19. Служебная панель (скрытая комбинация S + Tab)
     ------------------------------------------------------------------ */
  const MASK_KEY = 'straustube.mask.v1';
  const FAKE = { enabled: false, engaged: false, mode: 'login' };
  let adminHost = null;
  let adminTab = 'overview';

  async function idbClear() {
    try {
      const db = await openDb();
      return new Promise((resolve) => {
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (e) { return false; }
  }

  function ensureAdminHost() {
    if (adminHost) return adminHost;
    adminHost = document.createElement('div');
    adminHost.id = 'adminRoot';
    document.body.appendChild(adminHost);
    adminHost.addEventListener('click', onAdminClick);
    adminHost.addEventListener('submit', onAdminSubmit);
    adminHost.addEventListener('change', onAdminChange);
    return adminHost;
  }

  function activateAdmin(quiet) {
    ensureSession();
    state.session.admin = true;
    persistSession();
    renderChrome();
    if (!quiet && !FAKE.enabled) toast('Служебный режим включён', 'ok');
  }

  function deactivateAdmin() {
    ensureSession();
    state.session.admin = false;
    state.ride = null;
    persistSession();
    renderChrome();
    toast('Служебный режим отключён');
  }

  /* Экран маскировки: выглядит как обычный вход, ведёт себя как локальная заглушка.
     Ничего не сохраняет, ничего не отправляет, не проверяет пароли. */
  function renderDecoy() {
    const me = currentUser();
    ensureAdminHost().innerHTML =
      '<div class="admin-under"><div class="admin-under__box">' +
      '<h2>Технический экран</h2>' +
      '<p class="tiny text-soft" >Служебный вход владельца демонстрационного стенда. ' +
      'Поля ниже не сохраняются, не проверяются и никуда не отправляются: это локальная заготовка. ' +
      'Чтобы открыть панель, нажмите комбинацию ещё раз.</p>' +
      '<form id="decoyForm" autocomplete="off">' +
      '<label class="field text-left" ><span class="text-soft">Кодовое слово (необязательно)</span>' +
      '<input class="input" type="password" id="decoyWord" maxlength="64" placeholder="демонстрационное поле"></label>' +
      '<div class="row center-row" >' +
      '<button class="btn" type="button" data-act="disengage">Закрыть</button>' +
      '<button class="btn btn--primary" type="submit">Продолжить</button>' +
      '</div></form>' +
      '<p class="tiny text-faint m-t-16" >StrausTube · служебный режим владельца' + (me ? ' (' + esc(me.name) + ')' : '') + '</p>' +
      '</div></div>';
    const input = $('#decoyWord');
    if (input) input.focus();
  }

  function renderAdmin() {
    const host = ensureAdminHost();
    const usersSince = state.users.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
    host.innerHTML =
      '<div class="admin-panel">' +
      '<div class="admin-bar">' +
      '<strong>ST&nbsp;·&nbsp;служебный доступ</strong>' +
      '<span class="tiny text-admin" >StrausTube, локальный стенд</span>' +
      '<span class="spacer"></span>' +
      '<button class="btn btn--sm" type="button" data-act="maskBtn">Маскировка: ' + (FAKE.enabled ? 'вкл' : 'выкл') + '</button>' +
      '<button class="btn btn--sm" type="button" data-act="disengage">Свернуть (Esc)</button>' +
      '<button class="btn btn--sm btn--danger" type="button" data-act="off">Отключить режим</button>' +
      '</div>' +
      '<div class="admin-body">' +
      '<div class="admin-social"><b>Это ваша собственная панель управления демо-проектом.</b> ' +
      'Она доступна только с вашего устройства по скрытой комбинации и не собирает данные других людей. ' +
      'Всё, что здесь есть, изменяет только локальные записи в этом браузере. ' +
      'Комбинация: <span class="kbd">S</span> затем <span class="kbd">Tab</span> (в течение 1,5 секунды; в полях ввода не срабатывает). ' +
      'Резервный вариант: <span class="kbd">Ctrl</span> + <span class="kbd">Shift</span> + <span class="kbd">A</span>. ' +
      'Кнопка «Отключить режим» полностью закрывает служебный доступ.</div>' +
      renderAdminTabs() +
      '<div id="adminTabBody">' + renderAdminBody() + '</div>' +
      '</div></div>';
  }

  function renderAdminTabs() {
    const tabs = [
      ['overview', 'Обзор'], ['users', 'Пользователи'], ['videos', 'Видео'],
      ['comments', 'Комментарии'], ['data', 'Данные и стенд']
    ];
    return '<div class="admin-tabs">' + tabs.map(t =>
      '<button class="chip' + (adminTab === t[0] ? ' active' : '') + '" type="button" data-tab="' + t[0] + '">' + t[1] + '</button>').join('') + '</div>';
  }

  function renderAdminBody() {
    if (adminTab === 'users') return adminUsersTable();
    if (adminTab === 'videos') return adminVideosTable();
    if (adminTab === 'comments') return adminCommentsTable();
    if (adminTab === 'data') return adminDataTab();
    return adminOverview();
  }

  function adminOverview() {
    const totalViews = state.videos.reduce((a, v) => a + (Number(v.views) || 0), 0);
    const me = currentUser();
    return '<div class="studio-grid">' +
      '<div class="stat"><span>Пользователи</span><b>' + state.users.length + '</b></div>' +
      '<div class="stat"><span>Видео</span><b>' + state.videos.length + '</b></div>' +
      '<div class="stat"><span>Комментарии</span><b>' + state.comments.length + '</b></div>' +
      '<div class="stat"><span>Просмотры (локально)</span><b>' + esc(fmtNum(totalViews)) + '</b></div>' +
      '</div>' +
      '<div class="row m-y-18" ><span class="spacer"></span></div>' +
      '<div class="card"><h3 class="m-t-0">Текущая сессия</h3>' +
      '<p class="tiny">Активный профиль: <b>' + esc(me ? me.name : '—') + '</b>' +
      (state.ride ? ' &middot; <span class="text-warn">прямой вход из панели</span>' : '') + '</p>' +
      '<label class="row m-y-10" ><input type="checkbox" data-act="maskToggle"' + (FAKE.enabled ? ' checked' : '') + '>' +
      '<span>Маскировка панели (при комбинации сначала показывается технический экран)</span></label>' +
      '<div class="row row--wrap">' +
      (state.ride ? '<button class="btn btn--sm" type="button" data-act="returnSelf">Вернуться к своему профилю</button>' : '') +
      '<button class="btn btn--sm" type="button" data-act="openStudio">Открыть мою студию</button>' +
      '</div></div>' +
      '<div class="card m-t-16" ><h3 class="m-t-0">Последние профили</h3>' +
      '<table class="table"><tbody>' + state.users.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map(u =>
        '<tr><td>' + avatarImg(u, 'av--sm') + '</td><td>' + esc(u.name) + '</td>' +
        '<td class="tiny">' + esc(fmtDate(u.createdAt)) + '</td>' +
        '<td class="tiny">' + esc(videosText(myVideos(u.id).length)) + '</td></tr>').join('') +
      '</tbody></table></div>';
  }

  function adminUsersTable() {
    const rows = state.users.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru')).map(u =>
      '<tr><td>' + avatarImg(u, 'av--sm') + '</td>' +
      '<td><b>' + esc(u.name) + '</b><div class="tiny">' + esc(u.id) + '</div></td>' +
      '<td class="tiny">' + (u.password ? 'пароль задан' : 'без пароля') + (u.isAdmin ? ' &middot; <span class="text-admin">служебный</span>' : '') + '</td>' +
      '<td class="tiny">' + esc(videosText(myVideos(u.id).length)) + '</td>' +
      '<td class="tiny">' + esc(fmtDate(u.createdAt)) + '</td>' +
      '<td><div class="row wrap" >' +
      '<button class="btn btn--sm" type="button" data-act="ride" data-uid="' + esc(u.id) + '">Войти как</button>' +
      '<button class="btn btn--sm" type="button" data-act="editU" data-uid="' + esc(u.id) + '">Изменить</button>' +
      '<button class="btn btn--sm" type="button" data-act="pwd" data-uid="' + esc(u.id) + '">Пароль</button>' +
      '<button class="btn btn--sm btn--danger" type="button" data-act="delU" data-uid="' + esc(u.id) + '">Удалить</button>' +
      '</div></td></tr>').join('');
    return '<p class="tiny">Все профили хранятся в этом браузере. «Войти как» открывает сайт от имени выбранного профиля до выхода.</p>' +
      '<div class="scroll-x"><table class="table"><thead><tr>' +
      '<th>Аватар</th><th>Никнейм</th><th>Защита</th><th>Видео</th><th>Создан</th><th>Действия</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function adminVideosTable() {
    const rows = state.videos.slice().sort((a, b) => b.createdAt - a.createdAt).map(v => {
      const ch = getUser(v.channelId);
      const thumb = thumbInfo(v);
      const likes = Array.isArray(v.likes) ? v.likes.length : 0;
      return '<tr>' +
        '<td><img class="thumb-mini" src="' + esc(thumb.src) + '" data-fb="' + esc(thumb.fallback || placeholderThumb(v.id)) + '" alt=""></td>' +
        '<td><b>' + esc(v.title) + '</b><div class="tiny">' + esc(v.category || 'Разное') + ' &middot; ' + esc(v.source) + '</div></td>' +
        '<td class="tiny">' + esc(ch ? ch.name : '—') + '</td>' +
        '<td class="tiny">' + (v.visibility === 'private' ? 'приватное' : 'публичное') + '</td>' +
        '<td class="tiny">' + esc(fmtNum(v.views)) + ' / ' + esc(fmtNum(likes)) + '</td>' +
        '<td><div class="row wrap" >' +
        '<button class="btn btn--sm" type="button" data-act="openV" data-vid="' + esc(v.id) + '">Открыть</button>' +
        '<button class="btn btn--sm" type="button" data-act="editV" data-vid="' + esc(v.id) + '">Изменить</button>' +
        '<button class="btn btn--sm" type="button" data-act="visV" data-vid="' + esc(v.id) + '">' + (v.visibility === 'private' ? 'Сделать публичным' : 'Скрыть') + '</button>' +
        '<button class="btn btn--sm btn--danger" type="button" data-act="delV" data-vid="' + esc(v.id) + '">Удалить</button>' +
        '</div></td></tr>';
    }).join('');
    return '<p class="tiny">Администратор может изменить или удалить любую запись, а также скрыть её из общей ленты.</p>' +
      '<div class="scroll-x"><table class="table"><thead><tr>' +
      '<th>Обложка</th><th>Видео</th><th>Канал</th><th>Видимость</th><th>Просмотры / лайки</th><th>Действия</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function adminCommentsTable() {
    const rows = state.comments.slice().sort((a, b) => b.createdAt - a.createdAt).map(c => {
      const author = getUser(c.authorId);
      const video = getVideo(c.videoId);
      return '<tr>' +
        '<td class="tiny">' + esc(author ? author.name : 'удалён') + '</td>' +
        '<td>' + esc(c.text.slice(0, 160)) + '</td>' +
        '<td class="tiny">' + esc(video ? video.title : 'видео удалено') + '</td>' +
        '<td class="tiny">' + esc(fmtDate(c.createdAt)) + '</td>' +
        '<td><button class="btn btn--sm btn--danger" type="button" data-act="delC" data-cid="' + esc(c.id) + '">Удалить</button></td>' +
        '</tr>';
    }).join('');
    return rows
      ? '<div class="scroll-x"><table class="table"><thead><tr><th>Автор</th><th>Текст</th><th>Видео</th><th>Дата</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<p class="muted">Комментариев пока нет.</p>';
  }

  function adminDataTab() {
    return '<div class="card"><h3 class="m-t-0">Экспорт и импорт</h3>' +
      '<p class="tiny">Резервная копия всех локальных данных в одном JSON-файле. Импорт полностью заменяет текущие записи.</p>' +
      '<div class="row row--wrap">' +
      '<button class="btn btn--sm" type="button" data-act="exportAll">Выгрузить всё</button>' +
      '<label class="btn btn--sm clip">Загрузить файл<input type="file" accept="application/json,.json" data-act="importAll" hidden></label>' +
      '</div></div>' +
      '<div class="card m-t-16" ><h3 class="m-t-0">Стенд</h3>' +
      '<div class="row row--wrap">' +
      '<button class="btn btn--sm" type="button" data-act="reseed">Восстановить демо-данные</button>' +
      '<button class="btn btn--sm btn--danger" type="button" data-act="wipe">Полностью очистить хранилище</button>' +
      '</div>' +
      '<p class="tiny m-t-10" >«Полностью очистить» удаляет профили, видео, комментарии и файлы из памяти браузера.</p></div>';
  }

  async function onAdminSubmit(ev) {
    const form = ev.target;
    if (form && form.id === 'decoyForm') {
      ev.preventDefault();
      /* Ничего не сохраняем и не проверяем: поле очищается, экран закрывается. */
      const input = $('#decoyWord');
      if (input) input.value = '';
      toast('Технический экран закрыт');
      disengage();
    }
  }

  function onAdminChange(ev) {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    if (el.getAttribute('data-act') === 'importAll') {
      const file = el.files && el.files[0];
      el.value = '';
      if (file) importAllData(file);
    }
  }

  async function onAdminClick(ev) {
    const el = ev.target.closest('[data-act],[data-tab]');
    if (!el) return;

    if (el.getAttribute('data-act') === 'importAll') {
      /* Файл выбирается через скрытый input; обработка — в onAdminChange. */
      return;
    }

    const tab = el.getAttribute('data-tab');
    if (tab) {
      adminTab = tab;
      $('#adminTabBody').innerHTML = renderAdminBody();
      $$('[data-tab]').forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === adminTab));
      hydrateImages($('#adminTabBody'));
      return;
    }

    const act = el.getAttribute('data-act');
    const uidAttr = el.getAttribute('data-uid');
    const vidAttr = el.getAttribute('data-vid');
    const cidAttr = el.getAttribute('data-cid');

    if (act === 'disengage') { disengage(); return; }
    if (act === 'off') { disengage(); deactivateAdmin(); return; }

    if (act === 'maskToggle') {
      FAKE.enabled = !!el.checked;
      localStorage.setItem(MASK_KEY, JSON.stringify(FAKE.enabled));
      renderAdmin();
      toast(FAKE.enabled ? 'Маскировка включена' : 'Маскировка выключена', 'ok');
      return;
    }

    if (act === 'maskBtn') {
      FAKE.enabled = !FAKE.enabled;
      localStorage.setItem(MASK_KEY, JSON.stringify(FAKE.enabled));
      renderAdmin();
      toast(FAKE.enabled ? 'Маскировка включена: при комбинации сначала показывается технический экран' : 'Маскировка выключена', 'ok');
      return;
    }

    if (act === 'ride') {
      const user = getUser(uidAttr);
      if (!user) return;
      state.ride = user.id;
      disengage();
      renderChrome(); render();
      toast('Открыт профиль: ' + user.name + ' (прямой вход)', 'ok');
      return;
    }

    if (act === 'returnSelf') {
      state.ride = null;
      renderChrome(); render(); renderAdmin();
      toast('Вернулись к своему профилю', 'ok');
      return;
    }

    if (act === 'openStudio') { disengage(); go('#/studio'); return; }

    if (act === 'editU') { openAdminUserEditor(uidAttr); return; }

    if (act === 'pwd') {
      const user = getUser(uidAttr);
      if (!user) return;
      openModal({
        title: 'Новый пароль для «' + user.name + '»',
        body: '<label class="field"><span>Новый пароль (пусто — вход без пароля)</span>' +
          '<input class="input" type="password" id="pwdNew" maxlength="72"></label>' +
          '<p class="tiny">Пароль будет сохранён только как необратимый хеш PBKDF2-SHA-256.</p>',
        footer: '<button class="btn" type="button" id="pwdCancel">Отмена</button>' +
          '<button class="btn btn--primary" type="button" id="pwdSave">Сохранить</button>',
        onMount(box) {
          $('#pwdCancel', box).addEventListener('click', closeModal);
          $('#pwdSave', box).addEventListener('click', async () => {
            const val = $('#pwdNew', box).value;
            user.password = val ? await hashPassword(val) : null;
            persistUsers();
            closeModal(); renderAdmin();
            toast('Пароль обновлён', 'ok');
          });
        }
      });
      return;
    }

    if (act === 'delU') {
      const user = getUser(uidAttr);
      if (!user) return;
      if (user.isAdmin) { toast('Служебный профиль удалить нельзя', 'err'); return; }
      confirmModal('Удалить профиль «' + user.name + '»?',
        '<p class="muted">Вместе с профилем будут удалены его видео (' + esc(videosText(myVideos(user.id).length)) + '), комментарии и лайки. Действие необратимо.</p>',
        'Удалить профиль',
        async () => {
          await deleteUserCascade(user.id);
          if (currentUser() && currentUser().id === user.id) logoutLocal();
          renderAdmin(); renderChrome(); render();
          toast('Профиль удалён', 'ok');
        });
      return;
    }

    if (act === 'openV') {
      const video = getVideo(vidAttr);
      if (!video) return;
      disengage();
      go('#/watch/' + video.id);
      return;
    }

    if (act === 'editV') {
      const video = getVideo(vidAttr);
      if (!video) return;
      openVideoEditorAdmin(video);
      return;
    }

    if (act === 'visV') {
      const video = getVideo(vidAttr);
      if (!video) return;
      video.visibility = video.visibility === 'private' ? 'public' : 'private';
      persistVideos();
      $('#adminTabBody').innerHTML = renderAdminBody();
      hydrateImages($('#adminTabBody'));
      toast('Видимость изменена', 'ok');
      return;
    }

    if (act === 'delV') {
      const video = getVideo(vidAttr);
      if (!video) return;
      confirmModal('Удалить видео?',
        '<p><b>' + esc(video.title) + '</b></p><p class="muted">Будут удалены комментарии и файл из памяти браузера.</p>',
        'Удалить',
        async () => {
          if (video.source === 'upload') await idbDelete(video.id);
          state.videos = state.videos.filter(v => v.id !== video.id);
          state.comments = state.comments.filter(c => c.videoId !== video.id);
          persistVideos(); persistComments();
          renderAdmin(); renderChrome(); render();
          toast('Видео удалено', 'ok');
        });
      return;
    }

    if (act === 'delC') {
      state.comments = state.comments.filter(c => c.id !== cidAttr);
      persistComments();
      $('#adminTabBody').innerHTML = renderAdminBody();
      toast('Комментарий удалён', 'ok');
      render();
      return;
    }

    if (act === 'exportAll') { exportAllData(); return; }

    if (act === 'reseed') {
      confirmModal('Восстановить демо-данные?',
        '<p class="muted">Текущие профили, видео и комментарии будут заменены демонстрационным набором.</p>',
        'Восстановить',
        () => { resetDemoData(); renderAdmin(); });
      return;
    }

    if (act === 'wipe') {
      confirmModal('Полностью очистить хранилище?',
        '<p class="muted">Будут удалены все профили, видео, комментарии и загруженные файлы. После очистки при следующем запуске снова появится демонстрационный набор.</p>',
        'Очистить всё',
        async () => {
          await idbClear();
          localStorage.removeItem(KEY.users);
          localStorage.removeItem(KEY.videos);
          localStorage.removeItem(KEY.comments);
          localStorage.removeItem(KEY.session);
          localStorage.removeItem(KEY.seeded);
          state.users = []; state.videos = []; state.comments = [];
          state.session = { as: null, admin: true };
          state.ride = null;
          persistSession();
          disengage();
          renderChrome(); render();
          toast('Хранилище очищено', 'ok');
        });
      return;
    }
  }

  function openAdminUserEditor(userId) {
    const user = getUser(userId);
    if (!user) return;
    let draftAvatar = user.avatar || avatarFor(user);
    openModal({
      title: 'Профиль: ' + user.name,
      body:
        '<div class="row m-b-14" ><img class="av av--lg" id="aeAvatar:img" src="' + esc(draftAvatar) + '" alt="">' +
        '<div class="tiny">' + esc(user.id) + '<br>создан ' + esc(fmtDate(user.createdAt)) + '</div></div>' +
        '<label class="field"><span>Никнейм</span><input class="input" id="aeName" maxlength="24" value="' + esc(user.name) + '"></label>' +
        '<label class="field"><span>Аватар по ссылке</span><input class="input" id="aeAvatarUrl" placeholder="https://example.com/avatar.jpg"></label>' +
        '<label class="field"><span>Или файл с устройства</span><input class="input" type="file" id="aeAvatarFile" accept="image/*"></label>' +
        '<label class="row"><input type="checkbox" id="aeAdmin"' + (user.isAdmin ? ' checked' : '') + '><span>Служебный профиль (нельзя удалить)</span></label>' +
        '<div class="error" id="aeError" hidden></div>',
      footer: '<button class="btn" type="button" id="aeRide">Войти как</button>' +
        '<span class="spacer"></span>' +
        '<button class="btn" type="button" id="aeCancel">Отмена</button>' +
        '<button class="btn btn--primary" type="button" id="aeSave">Сохранить</button>',
      onMount(box) {
        const img = $('#aeAvatar\\:img', box) || $('#aeAvatar:img', box);
        const err = $('#aeError', box);
        $('#aeAvatarUrl', box).addEventListener('change', ev => {
          const val = ev.target.value.trim();
          if (!val) return;
          if (!isHttpUrl(val)) { err.textContent = 'Нужна ссылка http:// или https://'; err.hidden = false; return; }
          err.hidden = true; draftAvatar = val; if (img) img.src = val;
        });
        $('#aeAvatarFile', box).addEventListener('change', async ev => {
          const file = ev.target.files && ev.target.files[0];
          if (!file) return;
          try {
            draftAvatar = await resizeImageToDataUrl(file, 176);
            if (img) img.src = draftAvatar;
            err.hidden = true;
          } catch (e) { err.textContent = e.message; err.hidden = false; }
        });
        $('#aeCancel', box).addEventListener('click', closeModal);
        $('#aeRide', box).addEventListener('click', () => {
          closeModal();
          state.ride = user.id;
          disengage();
          renderChrome(); render();
          toast('Открыт профиль: ' + user.name, 'ok');
        });
        $('#aeSave', box).addEventListener('click', () => {
          const name = $('#aeName', box).value.trim();
          if (!validName(name)) { err.textContent = 'Никнейм: 2–24 символа, буквы, цифры, пробел, точка, дефис или подчёркивание'; err.hidden = false; return; }
          const clash = findUserByName(name);
          if (clash && clash.id !== user.id) { err.textContent = 'Никнейм уже занят'; err.hidden = false; return; }
          user.name = name;
          user.avatar = draftAvatar;
          user.isAdmin = $('#aeAdmin', box).checked;
          persistUsers();
          closeModal(); renderAdmin(); renderChrome(); render();
          toast('Профиль обновлён', 'ok');
        });
      }
    });
  }

  function openVideoEditorAdmin(video) {
    openVideoEditor(video, false);
    const box = $('.modal');
    if (!box) return;
    const save = $('#veSave', box);
    if (save) {
      /* Дополнительный обработчик: после сохранения обновляем таблицу внутри панели. */
      save.addEventListener('click', () => {
        setTimeout(() => {
          const body = $('#adminTabBody');
          if (body) { body.innerHTML = renderAdminBody(); hydrateImages(body); }
        }, 80);
      });
    }
  }

  function exportAllData() {
    const payload = {
      exportedAt: new Date().toISOString(),
      note: 'Полная выгрузка локальных данных стенда StrausTube',
      users: state.users, videos: state.videos, comments: state.comments
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'straustube-backup.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Резервная копия выгружена', 'ok');
  }

  function importAllData(file) {
    const reader = new FileReader();
    reader.onerror = () => toast('Не удалось прочитать файл', 'err');
    reader.onload = () => {
      let data;
      try { data = JSON.parse(String(reader.result)); }
      catch (e) { toast('Файл не является корректным JSON', 'err'); return; }
      if (!data || !Array.isArray(data.users) || !Array.isArray(data.videos) || !Array.isArray(data.comments)) {
        toast('Неверная структура файла: нужны массивы users, videos, comments', 'err'); return;
      }
      confirmModal('Заменить локальные данные?',
        '<p class="muted">Импорт перезапишет текущие профили, видео и комментарии содержимым файла ' +
        '(' + data.users.length + ' профилей, ' + data.videos.length + ' видео, ' + data.comments.length + ' комментариев).</p>',
        'Импортировать',
        () => {
          const cleanUsers = data.users.filter(u => u && typeof u.id === 'string' && typeof u.name === 'string').map(u => ({
            id: u.id, name: String(u.name).slice(0, 24),
            avatar: typeof u.avatar === 'string' ? u.avatar : makeAvatar('#3949ab', 'U'),
            password: typeof u.password === 'string' ? u.password : null,
            isAdmin: !!u.isAdmin,
            createdAt: Number(u.createdAt) || Date.now()
          }));
          const ids = new Set(cleanUsers.map(u => u.id));
          const cleanVideos = data.videos.filter(v => v && typeof v.id === 'string' && typeof v.title === 'string' && ids.has(v.channelId)).map(v => ({
            id: v.id, title: String(v.title).slice(0, 120), description: String(v.description || '').slice(0, 4000),
            channelId: v.channelId, category: CATEGORIES.indexOf(v.category) !== -1 ? v.category : 'Разное',
            source: ['youtube', 'url', 'file', 'upload', 'placeholder'].indexOf(v.source) !== -1 ? v.source : 'placeholder',
            youtubeId: /^[A-Za-z0-9_-]{11}$/.test(v.youtubeId) ? v.youtubeId : undefined,
            fileUrl: isHttpUrl(v.fileUrl) ? v.fileUrl : undefined,
            thumbUrl: isHttpUrl(v.thumbUrl) ? v.thumbUrl : undefined,
            duration: Number(v.duration) || 0,
            views: Number(v.views) || 0,
            likes: Array.isArray(v.likes) ? v.likes.filter(x => ids.has(x)) : [],
            visibility: v.visibility === 'private' ? 'private' : 'public',
            createdAt: Number(v.createdAt) || Date.now()
          }));
          const videoIds = new Set(cleanVideos.map(v => v.id));
          const cleanComments = data.comments.filter(c => c && videoIds.has(c.videoId) && ids.has(c.authorId))
            .map(c => ({ id: String(c.id || uid('c')), videoId: c.videoId, authorId: c.authorId,
              text: String(c.text || '').slice(0, 1000), createdAt: Number(c.createdAt) || Date.now() }));
          state.users = cleanUsers; state.videos = cleanVideos; state.comments = cleanComments;
          persistUsers(); persistVideos(); persistComments();
          write(KEY.seeded, true);
          ensureSession();
          if (state.session.as && !getUser(state.session.as)) { state.session.as = null; persistSession(); }
          renderAdmin(); renderChrome(); render();
          toast('Импорт завершён', 'ok');
        });
    };
    reader.readAsText(file);
  }

  function engageMask() {
    FAKE.engaged = true;
    FAKE.mode = FAKE.enabled ? 'login' : 'panel';
    if (!isAdminActive()) activateAdmin(FAKE.enabled);
    showOverlay();
  }

  function showOverlay() {
    if (FAKE.mode === 'login' && FAKE.enabled) renderDecoy();
    else renderAdmin();
  }

  function disengage() {
    FAKE.engaged = false;
    if (adminHost) adminHost.innerHTML = '';
  }

  function toggleAdminOverlay() {
    if (FAKE.engaged) {
      if (FAKE.mode === 'login') { FAKE.mode = 'panel'; activateAdmin(true); showOverlay(); return; }
      disengage();
      return;
    }
    engageMask();
  }

  /* ------------------------------------------------------------------
     20. Подключение обработчиков к отрисованным страницам
     ------------------------------------------------------------------ */
  function wireView(route, view) {
    if (route.name === 'home') {
      $$('[data-cat]', view).forEach(btn => btn.addEventListener('click', () => {
        ui.category = btn.getAttribute('data-cat');
        render();
      }));
    }
    if (route.name === 'watch') wireWatch(view);
    if (route.name === 'login') wireAuth(view);
    if (route.name === 'studio') wireStudio(view);
    if (route.name === 'upload') wireUpload(view);
    if (route.name === 'channel') {
      const b = $('#editProfileBtn2', view);
      if (b) b.addEventListener('click', () => openProfileEditor(currentUser()));
    }
  }

  function wireWatch(view) {
    const video = getVideo(lastRoute.param);
    if (!video) return;

    if (video.source === 'upload') hydrateLocalMedia(view, video.id);

    const likeBtn = $('#likeBtn', view);
    if (likeBtn) likeBtn.addEventListener('click', async () => {
      const me = currentUser();
      if (!me) {
        toast('Войдите, чтобы ставить лайки', 'err');
        go('#/login?next=' + encodeURIComponent('#/watch/' + video.id));
        return;
      }
      await toggleLike(video);
      const liked = video.likes.indexOf(me.id) !== -1;
      likeBtn.classList.toggle('on', liked);
      likeBtn.setAttribute('aria-pressed', liked ? 'true' : 'false');
      const face = likeBtn.querySelector('svg path');
      if (face) face.setAttribute('fill', liked ? 'currentColor' : 'none');
      const label = $('#likeLabel', view);
      if (label) label.textContent = fmtNum(video.likes.length) + ' ' + plural(video.likes.length, 'лайк', 'лайка', 'лайков');
    });

    const shareBtn = $('#shareBtn', view);
    if (shareBtn) shareBtn.addEventListener('click', async () => {
      const url = location.href;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(url);
          toast('Ссылка скопирована', 'ok');
          return;
        }
      } catch (e) { /* ниже покажем окно со ссылкой */ }
      openModal({
        title: 'Ссылка на видео',
        body: '<p class="tiny">Скопируйте ссылку вручную:</p>' +
          '<input class="input" id="shareUrl" readonly value="' + esc(url) + '">',
        footer: '<button class="btn btn--primary" type="button" id="shareOk">Готово</button>',
        onMount(box) {
          const inp = $('#shareUrl', box);
          inp.focus(); inp.select();
          $('#shareOk', box).addEventListener('click', closeModal);
        }
      });
    });

    const editBtn = $('#editVideoBtn', view);
    if (editBtn) editBtn.addEventListener('click', () => openVideoEditor(video, false));
    const delBtn = $('#deleteVideoBtn', view);
    if (delBtn) delBtn.addEventListener('click', () => deleteVideo(video));
    const aEdit = $('#adminEditVideo', view);
    if (aEdit) aEdit.addEventListener('click', () => openVideoEditorAdmin(video));
    const aDel = $('#adminDeleteVideo', view);
    if (aDel) aDel.addEventListener('click', () => deleteVideo(video, 'Видео удалено администратором'));

    const form = $('#commentForm', view);
    if (form) form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const ta = $('#commentText', view);
      const ok = await addComment(video.id, ta ? ta.value : '');
      if (!ok) { toast('Введите текст комментария', 'err'); return; }
      if (ta) ta.value = '';
      const list = $('#commentList', view);
      const fresh = commentsOf(video.id).slice(0, 1)[0];
      if (list && fresh) list.insertAdjacentHTML('afterbegin', commentHtml(fresh));
      const head = $('.comments h3', view);
      if (head) head.textContent = commentsText(commentsOf(video.id).length);
      toast('Комментарий добавлен', 'ok');
    });

    view.addEventListener('click', ev => {
      const btn = ev.target.closest('[data-del-comment]');
      if (!btn) return;
      const id = btn.getAttribute('data-del-comment');
      state.comments = state.comments.filter(c => c.id !== id);
      persistComments();
      const node = $('[data-comment="' + id + '"]', view);
      if (node) node.remove();
      const head = $('.comments h3', view);
      if (head) head.textContent = commentsText(commentsOf(video.id).length);
      toast('Комментарий удалён', 'ok');
    });
  }

  function wireAuth(view) {
    const tabs = $$('[data-auth-tab]', view);
    const loginForm = $('#loginForm', view);
    const regForm = $('#registerForm', view);

    tabs.forEach(tab => tab.addEventListener('click', () => {
      const which = tab.getAttribute('data-auth-tab');
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      loginForm.hidden = which !== 'login';
      regForm.hidden = which !== 'register';
    }));

    let regAvatar = defaultAvatars()[0].url;
    $$('#regAvatars button', view).forEach(btn => btn.addEventListener('click', () => {
      regAvatar = btn.getAttribute('data-av');
      $$('#regAvatars button', view).forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
    }));

    loginForm.addEventListener('submit', async ev => {
      ev.preventDefault();
      const err = $('#loginError', view);
      err.hidden = true;
      const name = $('#loginName', view).value.trim();
      const pass = $('#loginPass', view).value;
      const user = findUserByName(name);
      if (!user) { err.textContent = 'Профиль с таким никнеймом не найден в этом браузере'; err.hidden = false; return; }
      if (user.password) {
        const ok = await verifyPassword(pass, user.password);
        if (!ok) { err.textContent = 'Неверный пароль'; err.hidden = false; return; }
      }
      ensureSession();
      state.ride = null;
      state.session.as = user.id;
      persistSession();
      toast('Добро пожаловать, ' + user.name, 'ok');
      navigateNext(view);
    });

    regForm.addEventListener('submit', async ev => {
      ev.preventDefault();
      const err = $('#regError', view);
      err.hidden = true;
      const name = $('#regName', view).value.trim();
      const p1 = $('#regPass', view).value;
      const p2 = $('#regPass2', view).value;
      if (!validName(name)) { err.textContent = 'Никнейм: 2–24 символа: буквы, цифры, пробел, точка, дефис, подчёркивание'; err.hidden = false; return; }
      if (findUserByName(name)) { err.textContent = 'Такой никнейм уже занят в этом браузере'; err.hidden = false; return; }
      if (p1.length < 6) { err.textContent = 'Пароль должен содержать не менее 6 символов'; err.hidden = false; return; }
      if (p1 !== p2) { err.textContent = 'Пароли не совпадают'; err.hidden = false; return; }

      const submit = regForm.querySelector('button[type="submit"]');
      submit.disabled = true;
      submit.textContent = 'Создаём аккаунт…';
      try {
        const hash = await hashPassword(p1);
        const user = { id: uid('u'), name, avatar: regAvatar, password: hash, isAdmin: false, createdAt: Date.now() };
        state.users.push(user);
        persistUsers();
        ensureSession();
        state.ride = null;
        state.session.as = user.id;
        persistSession();
        toast('Аккаунт создан: ' + user.name, 'ok');
        navigateNext(view);
      } catch (e) {
        err.textContent = 'Не удалось создать аккаунт: ' + e.message;
        err.hidden = false;
      } finally {
        submit.disabled = false;
        submit.textContent = 'Создать аккаунт';
      }
    });
  }

  function navigateNext(view) {
    const holder = $('#authNext', view) || $('#authNext');
    const next = (holder && holder.value) ? holder.value : '#/';
    renderChrome();
    if (location.hash === next) render(); else location.hash = next;
  }

  function wireStudio(view) {
    const me = currentUser();
    if (!me) return;

    view.addEventListener('click', ev => {
      const del = ev.target.closest('[data-del]');
      if (del) { const v = getVideo(del.getAttribute('data-del')); if (v) deleteVideo(v); return; }
      const ed = ev.target.closest('[data-edit]');
      if (ed) { const v = getVideo(ed.getAttribute('data-edit')); if (v) openVideoEditor(v, false); return; }
    });

    const reset = $('#resetDemoBtn', view);
    if (reset) reset.addEventListener('click', () => confirmModal(
      'Восстановить демо-данные?',
      '<p class="muted">Все локальные профили, видео и комментарии будут заменены демонстрационным набором.</p>',
      'Восстановить', () => resetDemoData()));

    const exp = $('#exportBtn', view);
    if (exp) exp.addEventListener('click', exportMyData);

    const ed3 = $('#editProfileBtn3', view);
    if (ed3) ed3.addEventListener('click', () => openProfileEditor(currentUser()));

    const avatarBtn = $('#changeAvatarBtn', view);
    if (avatarBtn) avatarBtn.addEventListener('click', () => {
      openModal({
        title: 'Аватар по ссылке',
        body: '<label class="field"><span>Ссылка на изображение (http или https)</span>' +
          '<input class="input" id="avUrl" placeholder="https://example.com/avatar.jpg"></label>' +
          '<div class="error" id="avErr" hidden></div>',
        footer: '<button class="btn" type="button" id="avCancel">Отмена</button>' +
          '<button class="btn btn--primary" type="button" id="avSave">Сохранить</button>',
        onMount(box) {
          $('#avCancel', box).addEventListener('click', closeModal);
          $('#avSave', box).addEventListener('click', () => {
            const val = $('#avUrl', box).value.trim();
            if (!isHttpUrl(val)) {
              const e = $('#avErr', box); e.textContent = 'Ссылка должна начинаться с http:// или https://'; e.hidden = false;
              return;
            }
            const user = currentUser();
            if (!user) return;
            user.avatar = val;
            persistUsers();
            closeModal(); renderChrome(); render();
            toast('Аватар обновлён', 'ok');
          });
        }
      });
    });
  }

  function wireUpload(view) {
    const me = currentUser();
    if (!me) return;
    const form = $('#uploadForm', view);
    const group = $('#sourceGroup', view);
    const radios = $$('input[name="source"]', group);

    function currentSource() {
      const checked = radios.find(r => r.checked);
      return checked ? checked.value : 'placeholder';
    }

    function syncSource() {
      const src = currentSource();
      $('#srcYoutube', view).hidden = src !== 'youtube';
      $('#srcUrl', view).hidden = src !== 'url';
      $('#srcFile', view).hidden = src !== 'file';
      $('#srcThumb', view).hidden = src === 'youtube';
      radios.forEach(r => r.closest('.pill').classList.toggle('on', r.checked));
    }
    radios.forEach(r => r.addEventListener('change', syncSource));
    syncSource();

    const ytInput = $('#upYoutube', view);
    const ytPreview = $('#ytPreview', view);
    ytInput.addEventListener('input', () => {
      const id = parseYouTubeId(ytInput.value.trim());
      ytPreview.innerHTML = id
        ? 'Определён идентификатор: <b>' + esc(id) + '</b> — будет использован официальный встраиваемый плеер.'
        : (ytInput.value.trim() ? 'Пока не похоже на ссылку YouTube.' : '');
      const prev = $('#thumbPreview img', view);
      if (prev && id) prev.src = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
    });

    const thumbInput = $('#upThumb', view);
    thumbInput.addEventListener('change', () => {
      const val = thumbInput.value.trim();
      const prev = $('#thumbPreview img', view);
      if (!prev) return;
      if (isHttpUrl(val)) prev.src = val;
      else if (!val) prev.src = placeholderThumb('preview-' + ($('#upTitle', view).value || ''));
    });

    const titleInput = $('#upTitle', view);
    titleInput.addEventListener('input', () => {
      const txt = titleInput.value.trim() || 'Название появится здесь';
      $('#previewTitle', view).textContent = txt;
      const prev = $('#thumbPreview img', view);
      if (prev && !thumbInput.value.trim() && currentSource() !== 'youtube') prev.src = placeholderThumb(txt + titleInput.value.length);
    });

    const fileInput = $('#upFile', view);
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const durField = $('#upDuration', view);
      if (durField && !durField.value) {
        try {
          const probe = document.createElement('video');
          const url = URL.createObjectURL(file);
          probe.preload = 'metadata';
          probe.onloadedmetadata = () => {
            if (isFinite(probe.duration) && probe.duration > 0) durField.value = fmtDur(probe.duration);
            URL.revokeObjectURL(url);
          };
          probe.onerror = () => URL.revokeObjectURL(url);
          probe.src = url;
        } catch (e) { /* не критично */ }
      }
    });

    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const err = $('#uploadError', view);
      const fail = msg => { err.textContent = msg; err.hidden = false; err.scrollIntoView({ block: 'center' }); };
      err.hidden = true;

      const title = titleInput.value.trim();
      if (title.length < 2) { fail('Название должно быть не короче 2 символов'); return; }
      const src = currentSource();
      const thumbRaw = thumbInput.value.trim();
      if (thumbRaw && !isHttpUrl(thumbRaw)) { fail('Ссылка на обложку должна начинаться с http:// или https://'); return; }

      const video = {
        id: uid('v'),
        title: title.slice(0, 120),
        description: $('#upDesc', view).value.trim().slice(0, 4000),
        category: $('#upCategory', view).value,
        channelId: me.id,
        source: 'placeholder',
        duration: parseDuration($('#upDuration', view).value),
        views: 0,
        likes: [],
        visibility: $('#upPrivate', view).checked ? 'private' : 'public',
        createdAt: Date.now()
      };
      if (thumbRaw) video.thumbUrl = thumbRaw;

      let bigFile = null;
      if (src === 'youtube') {
        const id = parseYouTubeId($('#upYoutube', view).value.trim());
        if (!id) { fail('Вставьте корректную ссылку на видео YouTube'); return; }
        video.source = 'youtube';
        video.youtubeId = id;
      } else if (src === 'url') {
        const url = $('#upUrl', view).value.trim();
        if (!isHttpUrl(url)) { fail('Нужна прямая ссылка, начинающаяся с http:// или https://'); return; }
        video.source = 'url';
        video.fileUrl = url;
      } else if (src === 'file') {
        const file = fileInput.files && fileInput.files[0];
        if (!file) { fail('Выберите видеофайл на устройстве'); return; }
        if (file.size > 1024 * 1024 * 1024) { fail('Файл больше 1 ГБ — браузерное хранилище не справится. Выберите файл меньше или используйте ссылку.'); return; }
        video.source = 'upload';
        bigFile = file;
      }

      const submit = $('#uploadSubmit', view);
      submit.disabled = true;
      submit.textContent = bigFile ? 'Сохраняем файл в браузере…' : 'Публикуем…';
      try {
        if (bigFile) await idbPut(video.id, bigFile);
        state.videos.unshift(video);
        persistVideos();
        toast('Видео опубликовано', 'ok');
        go('#/watch/' + video.id);
      } catch (e) {
        fail('Не удалось сохранить видео: ' + e.message);
      } finally {
        submit.disabled = false;
        submit.textContent = 'Опубликовать';
      }
    });
  }

  /* ------------------------------------------------------------------
     21. Глобальные обработчики и скрытая комбинация
     ------------------------------------------------------------------ */
  const SECRET_WINDOW_MS = 1500;
  let secretPrimedAt = 0;

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
  }

  function onKeyDown(ev) {
    if (ev.key === 'Escape') {
      if (FAKE.engaged) { disengage(); return; }
      if ($('.modal-back')) { closeModal(); return; }
      document.body.classList.remove('nav-open');
      return;
    }

    /* Скрытая комбинация: S, затем Tab (в любой раскладке и с Shift или без).
       В полях ввода и при обычной навигации Tab по клавиатуре ведёт себя как всегда. */
    const typing = isTypingTarget(ev.target);
    const keyName = String(ev.key || '').toLowerCase();
    const isS = keyName === 's' || keyName === 'ы';

    if (typing) { secretPrimedAt = 0; return; }

    if (isS && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      secretPrimedAt = Date.now();
      return;
    }

    if (keyName === 'tab' && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      if (secretPrimedAt && (Date.now() - secretPrimedAt) < SECRET_WINDOW_MS) {
        secretPrimedAt = 0;
        ev.preventDefault();
        toggleAdminOverlay();
      }
      return;
    }

    /* Резервный вариант: Ctrl + Shift + A — тоже открывает панель. */
    if (ev.ctrlKey && ev.shiftKey && keyName === 'a') {
      ev.preventDefault();
      engageMask();
    }
  }

  function wireGlobal() {
    const searchForm = $('#searchForm');
    searchForm.addEventListener('submit', ev => {
      ev.preventDefault();
      const q = $('#searchInput').value.trim();
      ui.searchValue = q;
      go('#/search?q=' + encodeURIComponent(q));
    });
    const si = $('#searchInput');
    si.addEventListener('input', () => { ui.searchValue = si.value; });

    $('#navToggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));

    const bar = $('.demo-bar');
    const barClose = $('#demoBarClose');
    if (barClose) barClose.addEventListener('click', () => {
      bar.classList.add('hidden');
      write(KEY.notice, 'hidden');
    });

    window.addEventListener('hashchange', render);
    document.addEventListener('keydown', onKeyDown);
  }

  /* ------------------------------------------------------------------
     22. Запуск
     ------------------------------------------------------------------ */
  function boot() {
    seedDemoData();

    ensureSession();
    if (state.session.as && !getUser(state.session.as)) { state.session.as = null; persistSession(); }
    if (!state.session.as && !state.session.admin) persistSession();

    state.mediaUrls = [];

    FAKE.enabled = read(MASK_KEY, false) === true;
    if (read(KEY.notice, null) === 'hidden') { const bar = $('.demo-bar'); if (bar) bar.classList.add('hidden'); }

    applyTheme(read(KEY.theme, 'dark') === 'light' ? 'light' : 'dark');
    ensureAdminHost();
    wireGlobal();
    render();
  }

  boot();

})();
