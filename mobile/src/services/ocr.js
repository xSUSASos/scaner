/**
 * Распознавание текста (Tesseract.js) — аналог core/ocr.py из десктопа.
 *
 * Tesseract.js — это настоящий Tesseract, скомпилированный в WebAssembly; он
 * работает в собственном Web Worker, поэтому интерфейс не замирает. Все файлы
 * (воркер, ядро, языковые модели) лежат локально в vendor/ — никакого CDN.
 *
 * Один общий воркер на всё приложение: каждая копия держит в памяти модели
 * rus+eng (~десятки МБ), на iPhone две копии — лишний риск вылета вкладки.
 * Поэтому задания выполняются строго по очереди.
 */
import { autoDpi, imageSize } from './imaging.js';

const vendorUrl = (path) => new URL(`../../vendor/${path}`, import.meta.url).href;

const LANGS = ['rus', 'eng'];
const OEM_LSTM_ONLY = 1; // только нейросеть: легаси-модели не нужны, данные меньше
// PSM 3 — автоматическая разметка страницы (колонки, абзацы), как в десктопе.
// У API Tesseract по умолчанию 6 (один блок текста) — для страниц хуже.
const PSM_AUTO = '3';
// Ключ кэша моделей в IndexedDB. Версия в имени: сменим модели — не подхватим старые.
const CACHE_PATH = 'scaner-tessdata-4.0.0_best_int';

let workerPromise = null;
let queue = Promise.resolve();
let currentProgress = null; // onProgress текущего задания (логгер у воркера один)

/** Понятная ошибка вместо «Failed to fetch» / «Network error while fetching ...». */
function friendlyError(err) {
  return Object.assign(toRussian(err), { friendly: true });
}

function toRussian(err) {
  if (err?.name === 'AbortError' || err?.friendly) return err;
  const msg = String(err?.message ?? err ?? '');
  const network = /fetch|network|load failed|importScripts|NetworkError|Response code/i.test(msg);
  if (network) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return new Error(offline
      ? 'Для первого распознавания нужен интернет, чтобы скачать языковые модели (~10 МБ). '
        + 'Подключитесь к сети и попробуйте снова — дальше распознавание работает без интернета.'
      : `Не удалось загрузить модули распознавания текста. Проверьте подключение и попробуйте снова.\n(${msg})`);
  }
  if (/memory|out of bounds|abort\(/i.test(msg)) {
    return new Error('Не хватило памяти для распознавания. Закройте другие вкладки и приложения и попробуйте снова.');
  }
  return new Error(`Ошибка распознавания текста: ${msg}`);
}

const STATUS_RU = {
  'loading tesseract core': 'Загрузка модуля распознавания',
  'initializing tesseract': 'Запуск распознавания',
  'loading language traineddata': 'Загрузка языковых моделей',
  'loading language traineddata (from cache)': 'Загрузка языковых моделей',
  'initializing api': 'Подготовка',
  'recognizing text': 'Распознавание текста',
};

async function createOcrWorker() {
  const { default: Tesseract } = await import('../../vendor/tesseract/tesseract.esm.min.js');

  // Ошибку загрузки моделей tesseract.js не передаёт в createWorker: без
  // errorHandler он бросает её из обработчика сообщений, а createWorker висит
  // вечно. Ловим сами и завершаем ожидание с ошибкой.
  let failStartup;
  const startupFailed = new Promise((_, reject) => { failStartup = reject; });

  const workerReady = Tesseract.createWorker(LANGS, OEM_LSTM_ONLY, {
    workerPath: vendorUrl('tesseract/worker.min.js'),
    // Папка, а не файл: воркер сам выберет сборку ядра (relaxed SIMD / SIMD / обычную).
    corePath: vendorUrl('tesseract-core/'),
    langPath: vendorUrl('tessdata'),
    gzip: true,               // качаем *.traineddata.gz, распаковывает сам tesseract.js
    cacheMethod: 'write',     // распакованные модели кладутся в IndexedDB: второй запуск быстрый
    cachePath: CACHE_PATH,
    // Обычный воркер вместо blob:-URL: его запросы видит сервис-воркер (офлайн-кэш).
    workerBlobURL: false,
    logger: (m) => {
      if (!currentProgress || typeof m.progress !== 'number') return;
      currentProgress(m.progress, STATUS_RU[m.status] ?? m.status);
    },
    errorHandler: (err) => failStartup(err),
  });
  const worker = await Promise.race([workerReady, startupFailed]);
  await worker.setParameters({ tessedit_pageseg_mode: PSM_AUTO });
  return worker;
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = createOcrWorker().catch((err) => {
      workerPromise = null; // следующая попытка создаст воркер заново
      throw friendlyError(err);
    });
  }
  return workerPromise;
}

/**
 * Поставить задание в очередь: один воркер — одно задание за раз.
 * signal: при отмене воркер уничтожается (другого способа прервать Tesseract нет),
 * следующее задание создаст новый — модели уже в IndexedDB, это пара секунд.
 */
function enqueue(job, { onProgress, signal } = {}) {
  const run = async () => {
    if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
    const worker = await getWorker();
    currentProgress = onProgress ?? null;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => {
        terminateOcr();
        reject(new DOMException('Отменено', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([job(worker), aborted]);
    } catch (err) {
      throw friendlyError(err);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      currentProgress = null;
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {}); // ошибка одного задания не ломает очередь
  return result;
}

/** DPI по размеру картинки: Tesseract без него гадает размер шрифта, а в PDF от него зависит размер страницы. */
async function dpiOf(blob) {
  const head = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
  const size = imageSize(head);
  return size ? autoDpi(size.width, size.height) : 300;
}

/** Распознать текст на картинке страницы (JPEG/PNG). -> string */
export async function recognizeText(blob, { onProgress, signal } = {}) {
  const dpi = await dpiOf(blob);
  return enqueue(async (worker) => {
    // Параметры в options передаются в Tesseract только на этот вызов, потом откатываются.
    const { data } = await worker.recognize(blob, { user_defined_dpi: String(dpi) });
    return data.text ?? '';
  }, { onProgress, signal });
}

/**
 * Одностраничный PDF: картинка + невидимый слой текста (можно искать и копировать).
 * JPEG Tesseract встраивает как есть, 1-битный PNG — тоже без раздувания.
 * -> Uint8Array
 */
export async function recognizePdfPage(blob, { dpi, title, onProgress, signal } = {}) {
  const pageDpi = dpi ?? await dpiOf(blob);
  return enqueue(async (worker) => {
    const { data } = await worker.recognize(
      blob,
      { user_defined_dpi: String(pageDpi), pdfTitle: title ?? 'Скан' },
      { text: false, pdf: true },
    );
    if (!data.pdf) throw new Error('Tesseract не вернул PDF');
    return data.pdf instanceof Uint8Array ? data.pdf : new Uint8Array(data.pdf);
  }, { onProgress, signal });
}

/** Прогрев: создать воркер и загрузить модели заранее (например, при открытии экрана OCR). */
export async function preloadOcr() {
  await getWorker();
}

/** Освободить память (модели в воркере — десятки МБ). */
export async function terminateOcr() {
  const p = workerPromise;
  workerPromise = null;
  if (!p) return;
  try {
    await (await p).terminate();
  } catch {
    // воркер не успел создаться — освобождать нечего
  }
}
