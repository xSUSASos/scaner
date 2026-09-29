/**
 * Простой статический сервер для проверки на компьютере: npm run serve
 * (PORT=9000 npm run serve — другой порт). Без зависимостей, только node:http.
 *
 * Сервис-воркер и камера работают только на https или localhost — поэтому
 * открывайте http://localhost:8787, а не IP-адрес. Для iPhone в той же сети
 * нужен https (например, туннель) — по http Safari не даст камеру и SW.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm', // иначе WebAssembly.instantiateStreaming откажется
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.map': 'application/json; charset=utf-8',
  // .gz отдаём как есть, БЕЗ Content-Encoding: tesseract.js распаковывает модели
  // сам; с заголовком браузер распаковал бы их раньше, и проверка gzip сломалась бы.
  '.gz': 'application/octet-stream',
};

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');

  let path;
  try {
    // decodeURIComponent: кириллица и пробелы в URL приходят как %D0%BE...
    path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, 400, 'Bad Request');
  }
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(ROOT, path));
  // Защита от «../../» — файл обязан лежать внутри ROOT.
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return send(res, 403, 'Forbidden');
  if (file.includes(`${sep}node_modules${sep}`)) return send(res, 404, 'Not Found');

  let info;
  try {
    info = await stat(file);
  } catch {
    return send(res, 404, 'Not Found');
  }
  if (info.isDirectory()) {
    res.writeHead(301, { Location: `${req.url.split('?')[0]}/` });
    return res.end();
  }

  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-store', // при разработке всегда свежие файлы
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Сканер: http://localhost:${PORT}/  (папка ${ROOT})`);
});
