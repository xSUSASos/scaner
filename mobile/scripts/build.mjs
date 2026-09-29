// Сборка веб-части: копирует всё нужное приложению в mobile/www/.
// www/ — это то, что уходит на GitHub Pages и внутрь iOS-приложения (Capacitor webDir).
// Бандлера нет: файлы копируются как есть.
// Запуск: npm run build   (перед этим один раз: npm run vendor)
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // папка mobile/
const OUT = join(ROOT, 'www');

// Обязательные части веб-корня.
const REQUIRED = ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js', 'src', 'vendor'];
// Необязательные: копируем, если есть.
const OPTIONAL = ['precache.json', 'icons'];

if (!existsSync(join(ROOT, 'vendor'))) {
  console.error('Ошибка: нет папки vendor/ (OpenCV, Tesseract, jsPDF...).\n' +
    'Сначала выполните: npm run vendor');
  process.exit(1);
}
const missing = REQUIRED.filter((name) => !existsSync(join(ROOT, name)));
if (missing.length) {
  console.error(`Ошибка: не найдены файлы веб-корня: ${missing.join(', ')}`);
  process.exit(1);
}

// Чистая сборка: старые файлы в www/ не должны «пережить» удаление из исходников.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const name of [...REQUIRED, ...OPTIONAL]) {
  const from = join(ROOT, name);
  if (!existsSync(from)) {
    console.warn(`  (пропущено, нет файла) ${name}`);
    continue;
  }
  // Системный мусор macOS/Windows не нужен.
  cpSync(from, join(OUT, name), {
    recursive: true,
    filter: (src) => !/(^|[\\/])(\.DS_Store|Thumbs\.db)$/.test(src),
  });
  console.log(`  ${name}`);
}
console.log(`Готово: ${OUT}`);
