/**
 * Экспорт: PDF, PDF с текстовым слоем, отдельные картинки; «Поделиться».
 * Аналог core/export.py из десктопа.
 *
 * Память iPhone — главное ограничение: страницы рендерятся СТРОГО по одной
 * (renderPage), сразу превращаются в сжатые байты, и только потом берётся
 * следующая. 20 страниц по 12 Мп в виде пикселей — ~1 ГБ, в виде JPEG — ~30 МБ.
 *
 * PDF собирается через pdf-lib (а не jsPDF): он вставляет JPEG как есть, без
 * перекодирования, позволяет записать Ч/Б страницу 1-битной картинкой (в разы
 * меньше) и всё равно нужен для склейки страниц PDF с текстовым слоем.
 *
 * renderPage(page, { format }) -> Promise<{ blob, width, height, binary }>
 *   даёт UI (полноразмерный рендер в cv-воркере). format: 'auto' (PNG для Ч/Б,
 *   иначе JPEG) для PDF; 'jpeg' | 'png' для экспорта картинок.
 */
import { autoDpi, isJpeg, pageSizePt, toBilevelPng, toJpeg } from './imaging.js';

export { autoDpi };

const PRODUCER = 'Сканер документов';

// pdf-lib (~0.5 МБ) грузим только при первом экспорте, а не при старте приложения.
const loadPdfLib = () => import('../../vendor/pdf-lib/pdf-lib.esm.min.js');

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

/** Имя по умолчанию: «Скан 2026-09-29 14-05» (двоеточие в именах файлов запрещено в Windows/iOS Files). */
export function makeBaseName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `Скан ${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} `
    + `${p(date.getHours())}-${p(date.getMinutes())}`;
}

/** Убрать из имени символы, недопустимые в именах файлов. */
function safeName(name) {
  return (name || makeBaseName()).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || makeBaseName();
}

function setMeta(doc, title) {
  doc.setTitle(title || 'Скан');
  doc.setProducer(PRODUCER);
  doc.setCreator(PRODUCER);
  doc.setCreationDate(new Date());
}

/**
 * Вставить 1-битную картинку прямо сжатыми строками PNG. PDF понимает PNG-фильтры
 * строк (DecodeParms Predictor 15), поэтому данные идут в файл без распаковки.
 */
function embedBilevel(doc, lib, { zdata, width, height }) {
  const stream = doc.context.stream(zdata, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: width,
    Height: height,
    BitsPerComponent: 1,
    ColorSpace: 'DeviceGray',
    Filter: 'FlateDecode',
    DecodeParms: { Predictor: 15, Colors: 1, BitsPerComponent: 1, Columns: width },
  });
  return doc.context.register(stream);
}

function drawXObject(lib, pdfPage, ref, w, h) {
  const name = pdfPage.node.newXObject('Im', ref);
  pdfPage.pushOperators(
    lib.pushGraphicsState(),
    lib.concatTransformationMatrix(w, 0, 0, h, 0, 0), // картинка 1×1 растягивается на всю страницу
    lib.drawObject(name),
    lib.popGraphicsState(),
  );
}

/** Добавить отрендеренную страницу в PDF. Размер = пиксели / autoDpi (A4 по длинной стороне). */
async function addImagePage(doc, lib, rendered) {
  const { width: wPt, height: hPt } = pageSizePt(rendered.width, rendered.height);
  const bytes = new Uint8Array(await rendered.blob.arrayBuffer());

  if (isJpeg(bytes)) {
    const img = await doc.embedJpg(bytes); // JPEG вставляется как есть (DCTDecode)
    doc.addPage([wPt, hPt]).drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
    return;
  }
  if (rendered.binary) {
    const bilevel = await toBilevelPng(rendered.blob).catch(() => null);
    if (bilevel) {
      const page = doc.addPage([wPt, hPt]);
      drawXObject(lib, page, embedBilevel(doc, lib, bilevel), wPt, hPt);
      return;
    }
  }
  // Запасной путь: обычный PNG (pdf-lib распакует и сожмёт заново).
  const img = await doc.embedPng(bytes);
  doc.addPage([wPt, hPt]).drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
}

async function saveBlob(doc) {
  // useObjectStreams: false — чуть больше файл, зато открывается даже старыми просмотрщиками.
  const bytes = await doc.save({ useObjectStreams: false });
  return new Blob([bytes], { type: 'application/pdf' });
}

/** Многостраничный PDF из картинок (без распознавания текста). -> Blob */
export async function exportPdf(pages, { renderPage, onProgress, signal, title } = {}) {
  if (!pages?.length) throw new Error('Нет страниц для экспорта');
  const lib = await loadPdfLib();
  const doc = await lib.PDFDocument.create();
  setMeta(doc, title);
  const total = pages.length;
  for (let i = 0; i < total; i++) {
    checkAbort(signal);
    onProgress?.(i, total, `Обработка страницы ${i + 1} из ${total}`);
    let rendered = await renderPage(pages[i], { format: 'auto' });
    checkAbort(signal);
    await addImagePage(doc, lib, rendered);
    rendered = null; // отпускаем полноразмерный blob до рендера следующей страницы
  }
  onProgress?.(total, total, 'Сохранение PDF');
  return saveBlob(doc);
}

/**
 * PDF, в котором можно искать и копировать текст.
 * Tesseract умеет выдавать только одностраничный PDF на картинку — склеиваем
 * страницы через pdf-lib (copyPages переносит и картинку, и текстовый слой).
 * onProgress(done, total, text): во время распознавания done дробный (2.4 — идёт третья страница).
 */
export async function exportSearchablePdf(pages, { renderPage, onProgress, signal, title } = {}) {
  if (!pages?.length) throw new Error('Нет страниц для экспорта');
  const [lib, ocr] = await Promise.all([loadPdfLib(), import('./ocr.js')]);
  // Модели грузим ДО рендера первой страницы: если их нет (офлайн), пользователь
  // узнает сразу, а не после обработки страницы.
  onProgress?.(0, pages.length, 'Загрузка модуля распознавания');
  await ocr.preloadOcr();

  const out = await lib.PDFDocument.create();
  setMeta(out, title);
  const total = pages.length;
  for (let i = 0; i < total; i++) {
    checkAbort(signal);
    const label = `Страница ${i + 1} из ${total}`;
    onProgress?.(i, total, `${label}: обработка`);
    let rendered = await renderPage(pages[i], { format: 'auto' });
    checkAbort(signal);

    let image = rendered.blob;
    if (rendered.binary && !isJpeg(new Uint8Array(await image.slice(0, 3).arrayBuffer()))) {
      // 1-битный PNG Tesseract вставит в PDF компактно, 8-битный RGBA — раздутым.
      const bilevel = await toBilevelPng(image).catch(() => null);
      if (bilevel) image = new Blob([bilevel.png], { type: 'image/png' });
    }
    const pagePdf = await ocr.recognizePdfPage(image, {
      dpi: autoDpi(rendered.width, rendered.height),
      title,
      signal,
      onProgress: (fraction, status) => onProgress?.(
        i + Math.min(Math.max(fraction, 0), 0.99), total,
        `${label}: ${status.toLowerCase()} ${Math.round(fraction * 100)}%`,
      ),
    });
    rendered = image = null;

    const src = await lib.PDFDocument.load(pagePdf);
    const [copied] = await out.copyPages(src, [0]);
    out.addPage(copied);
  }
  onProgress?.(total, total, 'Сохранение PDF');
  return saveBlob(out);
}

/** Страницы отдельными картинками: `${baseName}_001.jpg`, ... -> File[] */
export async function exportImages(pages, { renderPage, format = 'jpeg', onProgress, signal, baseName } = {}) {
  if (!pages?.length) throw new Error('Нет страниц для экспорта');
  const png = format === 'png';
  const ext = png ? 'png' : 'jpg';
  const type = png ? 'image/png' : 'image/jpeg';
  const base = safeName(baseName);
  const total = pages.length;
  const files = [];
  for (let i = 0; i < total; i++) {
    checkAbort(signal);
    onProgress?.(i, total, `Обработка страницы ${i + 1} из ${total}`);
    const rendered = await renderPage(pages[i], { format: png ? 'png' : 'jpeg' });
    checkAbort(signal);
    let data = rendered.blob;
    if (png && rendered.binary) {
      // Ч/Б документ: 1 бит на пиксель вместо 32 — файл в разы меньше, без потерь.
      const bilevel = await toBilevelPng(data).catch(() => null);
      if (bilevel) data = bilevel.png;
    } else if (!png && rendered.blob.type !== 'image/jpeg') {
      data = await toJpeg(rendered.blob); // рендер вернул PNG, а просили JPEG
    }
    files.push(new File([data], `${base}_${pad3(i + 1)}.${ext}`, { type }));
  }
  onProgress?.(total, total, 'Готово');
  return files;
}

// ------------------------------------------------------------------ Поделиться

const isNative = () => Boolean(globalThis.Capacitor?.isNativePlatform?.());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Скачать файлы через <a download> (запасной путь для браузеров без Web Share). */
async function download(files) {
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    // Браузеры блокируют «пачку» скачиваний подряд и не любят, когда URL
    // отзывают до начала загрузки, — делаем паузу между файлами.
    await sleep(400);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return 'downloaded';
}

/**
 * Поделиться файлами: в приложении (Capacitor) — нативное меню iOS, в Safari —
 * Web Share (там есть «Сохранить в Файлы»), иначе — скачивание.
 * -> 'shared' | 'downloaded' | 'cancelled'
 */
export async function shareFiles(files, { title } = {}) {
  if (!files?.length) throw new Error('Нет файлов');
  if (isNative()) {
    return (await import('./native-share.js')).shareNative(files, { title });
  }
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files, title });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled'; // пользователь закрыл меню
      // NotAllowedError: share() вызван не из нажатия (прошло много времени после
      // клика, пока шёл экспорт). UI должен показать кнопку «Поделиться» ещё раз.
      throw err;
    }
  }
  return download(files);
}

/** Поделиться распознанным текстом. -> 'shared' | 'downloaded' | 'cancelled' */
export async function shareText(text, { title } = {}) {
  const name = `${safeName(title)}.txt`;
  // Обычный UTF-8 без BOM — как save_text в десктопе.
  const file = () => new File([text], name, { type: 'text/plain' });
  if (isNative()) {
    return (await import('./native-share.js')).shareNative([file()], { title });
  }
  if (navigator.share) {
    try {
      await navigator.share({ text, title });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
      throw err;
    }
  }
  return download([file()]);
}
