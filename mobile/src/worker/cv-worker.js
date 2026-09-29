/**
 * Web Worker обработки изображений (аналог QThread из десктопа).
 *
 * Зачем: OpenCV.js считает синхронно; в основном потоке интерфейс замирал бы на
 * каждом движении ползунка. Воркер получает команды сообщениями, отвечает тоже
 * сообщениями (RPC: {id, method, args} -> {id, result} | {id, error}).
 *
 * Память: полный снимок (до ~12 Мп) декодируется только на время экспорта и сразу
 * освобождается; в кэше держим лишь превью нескольких последних страниц.
 */
import { detectDocument } from '../core/detect.js';
import { downscale } from '../core/geometry.js';
import { render } from '../core/pipeline.js';

// Предел пикселей полного снимка. iOS Safari не даёт canvas больше ~16.7 Мп,
// а 48-Мп снимки новых iPhone в памяти WebAssembly заняли бы ~600 МБ на копию.
export const MAX_PIXELS = 12_600_000;
const PREVIEW_SIDE = 1400; // превью для редактора и живого результата
const THUMB_SIDE = 360;    // миниатюры в списке страниц
const CACHE_PAGES = 6;     // сколько превью держать в памяти

let cv = null;
const ready = loadOpenCV();

async function loadOpenCV() {
  // opencv.js — UMD-скрипт, а модульный воркер не умеет importScripts. Выполняем
  // его «косвенным» eval в глобальной области: скрипт сам кладёт себя в self.cv.
  const url = new URL('../../vendor/opencv/opencv.js', import.meta.url);
  const source = await (await fetch(url)).text();
  (0, eval)(source);
  let mod = self.cv;
  if (mod instanceof Promise || typeof mod?.then === 'function') mod = await mod;
  else if (!mod.Mat) await new Promise((resolve) => { mod.onRuntimeInitialized = resolve; });
  cv = mod;
}

/** id страницы -> { blob, width, height, preview: cv.Mat|null } (LRU по порядку Map). */
const pages = new Map();

function touch(id) {
  const entry = pages.get(id);
  pages.delete(id);
  pages.set(id, entry);
  // Вытесняем самые старые превью (blob оставляем: по нему превью можно пересоздать).
  let cached = [...pages.values()].filter((e) => e.preview);
  while (cached.length > CACHE_PAGES) {
    cached[0].preview.delete();
    cached[0].preview = null;
    cached = cached.slice(1);
  }
  return entry;
}

/** Декодировать blob в RGB cv.Mat (с учётом EXIF-ориентации), не больше maxPixels. */
async function decode(blob, maxPixels = MAX_PIXELS) {
  // imageOrientation: 'from-image' — повернуть по EXIF (фото с телефона).
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const scale = Math.min(1, Math.sqrt(maxPixels / (bitmap.width * bitmap.height)));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    const rgba = cv.matFromImageData(ctx.getImageData(0, 0, w, h));
    const rgb = new cv.Mat();
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    rgba.delete();
    return rgb;
  } finally {
    bitmap.close();
  }
}

/** RGB или grayscale Mat -> Blob (JPEG/PNG). */
async function encode(mat, type, quality) {
  const rgba = new cv.Mat();
  cv.cvtColor(mat, rgba, mat.channels() === 1 ? cv.COLOR_GRAY2RGBA : cv.COLOR_RGB2RGBA);
  try {
    const canvas = new OffscreenCanvas(rgba.cols, rgba.rows);
    const img = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
    canvas.getContext('2d').putImageData(img, 0, 0);
    return await canvas.convertToBlob({ type, quality });
  } finally {
    rgba.delete();
  }
}

async function previewOf(id) {
  const entry = pages.get(id);
  if (!entry) throw new Error(`Страница ${id} не загружена в обработчик`);
  if (!entry.preview) {
    const full = await decode(entry.blob);
    entry.preview = downscale(cv, full, PREVIEW_SIDE);
    full.delete();
  }
  touch(id);
  return entry.preview;
}

const methods = {
  /** Зарегистрировать страницу; вернуть размеры и (опционально) найденные углы. */
  async load({ id, blob, detect = true }) {
    const full = await decode(blob);
    const entry = { blob, width: full.cols, height: full.rows, preview: downscale(cv, full, PREVIEW_SIDE) };
    full.delete();
    pages.get(id)?.preview?.delete();
    pages.set(id, entry);
    touch(id);
    const result = { width: entry.width, height: entry.height, corners: null, found: false };
    if (detect) Object.assign(result, pickDetect(detectDocument(cv, entry.preview)));
    return result;
  },

  async detect({ id }) {
    return pickDetect(detectDocument(cv, await previewOf(id)));
  },

  /** Исходник (уже повёрнутый по EXIF) в размере превью — для редактора углов. */
  async sourcePreview({ id }) {
    return encode(await previewOf(id), 'image/jpeg', 0.9);
  },

  /**
   * Результат обработки.
   * target: 'preview' (живое превью), 'thumb' (миниатюра), 'full' (экспорт, полный снимок).
   * format: 'jpeg' | 'png' | 'auto' (auto: PNG для Ч/Б — без потерь и меньше, иначе JPEG).
   */
  async render({ id, recipe, target = 'preview', format = 'auto', quality = 0.9 }) {
    let source;
    let owned = false;
    if (target === 'full') {
      source = await decode(pages.get(id)?.blob ?? missing(id));
      owned = true;
    } else {
      source = await previewOf(id);
      if (target === 'thumb') {
        source = downscale(cv, source, THUMB_SIDE);
        owned = true;
      }
    }
    try {
      const out = render(cv, source, recipe);
      try {
        const binary = recipe.filter.mode === 'bw';
        const type = format === 'png' || (format === 'auto' && binary) ? 'image/png' : 'image/jpeg';
        const blob = await encode(out, type, quality);
        return { blob, width: out.cols, height: out.rows, binary };
      } finally {
        out.delete();
      }
    } finally {
      if (owned) source.delete();
    }
  },

  forget({ id }) {
    pages.get(id)?.preview?.delete();
    pages.delete(id);
    return true;
  },

  ping() {
    return true;
  },
};

function missing(id) {
  throw new Error(`Страница ${id} не загружена в обработчик`);
}

function pickDetect(r) {
  return { corners: r.corners, found: r.found };
}

self.onmessage = async (event) => {
  const { id, method, args } = event.data;
  try {
    await ready;
    const result = await methods[method](args ?? {});
    self.postMessage({ id, result });
  } catch (err) {
    const message = typeof err === 'number' && cv?.exceptionFromPtr
      ? cv.exceptionFromPtr(err).msg // исключение C++ из OpenCV приходит числом-указателем
      : (err?.message ?? String(err));
    self.postMessage({ id, error: message });
  }
};
