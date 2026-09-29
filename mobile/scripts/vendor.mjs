/**
 * Копирует браузерные сборки библиотек из node_modules в vendor/.
 *
 * Зачем: приложение работает без сборщика — браузер грузит файлы как есть,
 * а «голый» импорт вида `import 'pdf-lib'` без сборщика не работает. Поэтому
 * берём только самодостаточные файлы (без import из других пакетов) и кладём
 * их по фиксированным путям, на которые ссылается код.
 *
 * Заодно пишет:
 *   vendor/manifest.json — все файлы vendor/ с размерами и хешами;
 *   precache.json        — что сервис-воркер кладёт в кэш при установке.
 *
 * Запуск: npm run vendor (после npm install; в CI — тоже).
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NM = join(ROOT, 'node_modules');
const VENDOR = join(ROOT, 'vendor');

// [откуда (от node_modules), куда (от vendor/), класть ли в кэш при установке SW]
// precache=false — файлы Tesseract: они нужны только для распознавания текста,
// SW кэширует их при первом использовании, а не заставляет качать ~16 МБ сразу.
const FILES = [
  ['@techstark/opencv-js/dist/opencv.js', 'opencv/opencv.js', true],

  ['tesseract.js/dist/tesseract.esm.min.js', 'tesseract/tesseract.esm.min.js', false],
  ['tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js', false],
  // Только LSTM-варианты ядра (OEM 1). Файл *.wasm.js содержит сам wasm внутри
  // (base64), поэтому отдельный .wasm не нужен. Какой из трёх загрузить, воркер
  // решает сам по поддержке SIMD (см. tesseract.js/src/worker-script/browser/getCore.js).
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core/tesseract-core-lstm.wasm.js', false],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core/tesseract-core-simd-lstm.wasm.js', false],
  ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core/tesseract-core-relaxedsimd-lstm.wasm.js', false],
  // best_int — только LSTM-модель, квантованная до int8: меньше и быстрее «best»,
  // точность почти та же. Легаси-данные (папка 4.0.0) при OEM 1 не нужны.
  ['@tesseract.js-data/rus/4.0.0_best_int/rus.traineddata.gz', 'tessdata/rus.traineddata.gz', false],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'tessdata/eng.traineddata.gz', false],

  // pdf-lib ESM самодостаточен (проверено: нет import из других пакетов).
  ['pdf-lib/dist/pdf-lib.esm.min.js', 'pdf-lib/pdf-lib.esm.min.js', true],
  ['sortablejs/modular/sortable.esm.js', 'sortablejs/sortable.esm.js', true],
];

// Файлы приложения для precache.json (кроме src/ — его обходим целиком).
const APP_FILES = ['index.html', 'styles.css', 'manifest.webmanifest'];
const APP_DIRS = ['src', 'icons'];

const hashOf = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const toUrl = (abs) => relative(ROOT, abs).split(sep).join('/');
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} МБ`;

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

async function describe(abs) {
  const buf = await readFile(abs);
  return { url: toUrl(abs), size: buf.length, hash: hashOf(buf) };
}

async function main() {
  // Чистим целиком: иначе после смены версии в vendor/ остались бы старые файлы.
  await rm(VENDOR, { recursive: true, force: true });

  const vendorFiles = [];
  for (const [from, to, precache] of FILES) {
    const src = join(NM, from);
    if (!await exists(src)) {
      throw new Error(`Нет ${src} — выполните npm install`);
    }
    const dst = join(VENDOR, to);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    vendorFiles.push({ ...await describe(dst), precache });
  }

  await writeFile(join(VENDOR, 'manifest.json'), JSON.stringify({ files: vendorFiles }, null, 2) + '\n');

  // precache.json: список для сервис-воркера. version меняется при любом изменении
  // файлов — по нему pwa.js понимает, что вышла новая версия (sw.js?v=...).
  const app = [];
  for (const f of APP_FILES) {
    if (await exists(join(ROOT, f))) app.push(await describe(join(ROOT, f)));
  }
  for (const d of APP_DIRS) {
    if (!await exists(join(ROOT, d))) continue;
    for (const f of (await walk(join(ROOT, d))).sort()) app.push(await describe(f));
  }
  const vendor = vendorFiles.map(({ url, size, hash, precache }) => ({ url, size, hash, precache }));
  const version = hashOf([...app, ...vendor].map((f) => `${f.url}:${f.hash}`).join('\n'));
  await writeFile(join(ROOT, 'precache.json'), JSON.stringify({ version, app, vendor }, null, 2) + '\n');

  // Сводка размеров.
  const width = Math.max(...vendorFiles.map((f) => f.url.length));
  for (const f of vendorFiles) {
    console.log(`${f.url.padEnd(width)}  ${mb(f.size).padStart(9)}${f.precache ? '  (precache)' : ''}`);
  }
  const total = vendorFiles.reduce((s, f) => s + f.size, 0);
  const pre = vendorFiles.filter((f) => f.precache).reduce((s, f) => s + f.size, 0);
  const appSize = app.reduce((s, f) => s + f.size, 0);
  console.log(`\nvendor/: ${vendorFiles.length} файлов, ${mb(total)}; в precache: ${mb(pre)}`);
  console.log(`приложение: ${app.length} файлов, ${mb(appSize)}; precache.json version=${version}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
