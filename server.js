/* StrausTube — минимальный статический сервер для Render.
   Без зависимостей. Отдаёт файлы из ./public и добавляет заголовки безопасности,
   чтобы браузер не считал приложение подозрительным. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

/* Content-Security-Policy:
   - скрипты и стили только свои (никаких внешних CDN и трекеров);
   - изображения/медиа: локальные, data:, blob: и https (ссылки, которые добавил сам пользователь);
   - фреймы: только официальные плееры YouTube;
   - никаких плагинов и отправки форм на сторонние адреса. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src https://www.youtube-nocookie.com https://www.youtube.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors *",
  "upgrade-insecure-requests"
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Robots-Tag': 'index, follow'
};

function send(res, status, headers, body) {
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, headers));
  if (body === undefined || body === null) res.end();
  else res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    JSON.stringify(obj));
}

function fileEtag(stat) {
  return '"' + stat.size.toString(16) + '-' + Math.round(stat.mtimeMs).toString(16) + '"';
}

/* Страховка на уровне сервера: если в CSS когда-нибудь появится @import
   на сторонний ресурс, он не уйдёт в браузер. В текущих файлах @import нет. */
function sanitizeCss(css) {
  /* Ищем только настоящие директивы в начале строки, чтобы не задеть текст в комментариях. */
  return css.replace(/^[ \t]*@import\b[^;]*;?/gim,
    '/* Подключение сторонних стилей заблокировано политикой безопасности StrausTube. */');
}

function serveFile(req, res, filePath, isHtml) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return serveIndex(req, res);
    const etag = fileEtag(stat);
    const cache = isHtml ? 'no-store' : 'public, max-age=300';
    if (req.headers['if-none-match'] === etag) {
      return send(res, 304, { ETag: etag, 'Cache-Control': cache });
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, ETag: etag, 'Cache-Control': cache };

    /* CSS отдаём через фильтр: сторонние @import не должны попасть в браузер. */
    if (type.indexOf('text/css') === 0) {
      fs.readFile(filePath, 'utf8', (readErr, css) => {
        if (readErr) return sendJson(res, 500, { error: 'Не удалось прочитать стили' });
        const clean = sanitizeCss(css);
        headers['Content-Length'] = Buffer.byteLength(clean);
        res.writeHead(200, Object.assign({}, SECURITY_HEADERS, headers));
        res.end(clean);
      });
      return;
    }

    headers['Content-Length'] = stat.size;
    res.writeHead(200, Object.assign({}, SECURITY_HEADERS, headers));
    fs.createReadStream(filePath).pipe(res);
  });
}

function serveIndex(req, res) {
  const index = path.join(PUBLIC_DIR, 'index.html');
  fs.stat(index, (err, stat) => {
    if (err) return send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'index.html не найден');
    const etag = fileEtag(stat);
    if (req.headers['if-none-match'] === etag) {
      return send(res, 304, { ETag: etag, 'Cache-Control': 'no-store' });
    }
    res.writeHead(200, Object.assign({}, SECURITY_HEADERS, {
      'Content-Type': 'text/html; charset=utf-8',
      ETag: etag,
      'Cache-Control': 'no-store'
    }));
    fs.createReadStream(index).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    return sendJson(res, 400, { error: 'Некорректный адрес' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Метод не поддерживается: приложение работает целиком в браузере' });
  }

  if (urlPath === '/healthz') return sendJson(res, 200, { status: 'ok', app: 'StrausTube' });
  if (urlPath === '/robots.txt') {
    return send(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' },
      'User-agent: *\nAllow: /\n');
  }

  /* Защита от обхода каталогов: итоговый путь обязан остаться внутри public */
  const relative = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Доступ запрещён' });

  fs.stat(target, (err, stat) => {
    if (!err && stat.isDirectory()) return serveFile(req, res, path.join(target, 'index.html'), true);
    if (!err && stat.isFile()) return serveFile(req, res, target, target.endsWith('.html'));
    /* Неизвестные пути — это либо клиентские маршруты SPA, либо 404 */
    if (path.extname(urlPath)) return sendJson(res, 404, { error: 'Файл не найден' });
    return serveIndex(req, res);
  });
});

server.listen(PORT, HOST, () => {
  const id = crypto.randomBytes(2).toString('hex');
  console.log('StrausTube запущен на http://' + HOST + ':' + PORT + ' (сеанс ' + id + ')');
});
