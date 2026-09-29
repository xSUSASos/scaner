/**
 * Общие помощники для экспорта и OCR: DPI страницы, размеры картинки по байтам,
 * 1-битный PNG для Ч/Б страниц.
 *
 * Отдельный модуль, чтобы export.js и ocr.js не импортировали друг друга
 * (export.js использует ocr.js, а обоим нужен autoDpi).
 * Без DOM на уровне модуля — функции без canvas тестируются в Node.
 */

const A4_LONG_SIDE_INCH = 297 / 25.4;
const MIN_DPI = 72;
const MAX_DPI = 1200;

/**
 * DPI, при котором длинная сторона картинки = длинной стороне A4 (297 мм).
 * У снимка с телефона нет «настоящего» DPI, а PDF нужен физический размер
 * страницы. Считаем документ форматом A4 — как auto_dpi в десктопной версии.
 */
export function autoDpi(width, height) {
  const dpi = Math.round(Math.max(width, height) / A4_LONG_SIDE_INCH);
  return Math.min(Math.max(dpi, MIN_DPI), MAX_DPI);
}

/** Размер страницы PDF в пунктах (1 дюйм = 72 pt) для картинки w×h px. */
export function pageSizePt(width, height) {
  const dpi = autoDpi(width, height);
  return { width: (width / dpi) * 72, height: (height / dpi) * 72, dpi };
}

export function isJpeg(bytes) {
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function isPng(bytes) {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

/** Размеры JPEG/PNG по заголовку, без декодирования: {width, height} | null. */
export function imageSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (isPng(bytes)) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (isJpeg(bytes)) {
    // Идём по сегментам до SOFn (Start Of Frame) — там высота и ширина.
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xff) { i++; continue; } // заполняющие байты
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + view.getUint16(i + 2);
    }
  }
  return null;
}

// ---------------------------------------------------------------- PNG-чанки

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, crc = 0xffffffff) {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

/** Разобрать PNG: {width, height, bitDepth, colorType, interlace, idat} (idat — склеенные IDAT). */
export function parsePng(bytes) {
  if (!isPng(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [];
  let info = null;
  for (let i = 8; i + 8 <= bytes.length;) {
    const len = view.getUint32(i);
    const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    const data = bytes.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') {
      info = { width: view.getUint32(i + 8), height: view.getUint32(i + 12),
               bitDepth: data[8], colorType: data[9], interlace: data[12] };
    } else if (type === 'IDAT') {
      parts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    i += 12 + len;
  }
  if (!info) return null;
  return { ...info, idat: concat(parts) };
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** 1-битный серый PNG без чересстрочности: такие данные можно вставить в PDF как есть. */
export function isBilevelPng(info) {
  return info && info.bitDepth === 1 && info.colorType === 0 && info.interlace === 0;
}

/**
 * RGBA -> строки 1-битного изображения в формате PNG: перед каждой строкой байт
 * фильтра 0, дальше по 8 пикселей в байте, 1 = белый (так в PNG и в PDF DeviceGray).
 */
export function packBilevelRows(rgba, width, height) {
  const stride = Math.ceil(width / 8) + 1;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride + 1;
    let src = y * width * 4;
    for (let x = 0; x < width; x++, src += 4) {
      // Ч/Б страница и так содержит только 0 и 255; порог по яркости — на всякий случай.
      if (rgba[src] + 2 * rgba[src + 1] + rgba[src + 2] >= 512) {
        rows[rowStart + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return rows;
}

/** zlib-сжатие (формат «deflate» = zlib-обёртка, как нужно PNG и PDF FlateDecode). */
export async function zlibCompress(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Собрать 1-битный PNG из zlib-данных строк. dpi пишется в pHYs (физический размер для просмотрщиков). */
export function buildBilevelPng(width, height, zdata, dpi) {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 1; // бит на пиксель
  ihdr[9] = 0; // серый
  const parts = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk('IHDR', ihdr)];
  if (dpi) {
    const phys = new Uint8Array(9);
    const ppm = Math.round(dpi / 0.0254); // пикселей на метр
    new DataView(phys.buffer).setUint32(0, ppm);
    new DataView(phys.buffer).setUint32(4, ppm);
    phys[8] = 1; // единица — метр
    parts.push(chunk('pHYs', phys));
  }
  parts.push(chunk('IDAT', zdata), chunk('IEND', new Uint8Array(0)));
  return concat(parts);
}

/**
 * Ч/Б страница (обычный 8-битный PNG из canvas) -> 1-битный PNG.
 * Зачем: canvas умеет сохранять только 8-битный RGBA, а у документа из чистых
 * чёрного и белого 1 бит на пиксель даёт файл в разы меньше (как IMWRITE_PNG_BILEVEL
 * в десктопе). Возвращает { png, zdata, width, height } или null, если браузер не умеет.
 */
export async function toBilevelPng(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const info = parsePng(bytes);
  if (isBilevelPng(info)) { // уже 1-битный — ничего не делаем
    return { png: bytes, zdata: info.idat, width: info.width, height: info.height };
  }
  if (typeof CompressionStream === 'undefined' || typeof createImageBitmap === 'undefined') return null;

  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  let rgba;
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    rgba = ctx.getImageData(0, 0, width, height).data;
    // Сразу освобождаем холст: на iOS память canvas отдаётся не сразу.
    canvas.width = canvas.height = 1;
  } finally {
    bitmap.close();
  }
  const zdata = await zlibCompress(packBilevelRows(rgba, width, height));
  rgba = null;
  return { png: buildBilevelPng(width, height, zdata, autoDpi(width, height)), zdata, width, height };
}

/** Перекодировать картинку в JPEG через canvas (если рендер вернул не тот формат). */
export async function toJpeg(blob, quality = 0.92) {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      return await canvas.convertToBlob({ type: 'image/jpeg', quality });
    }
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  } finally {
    bitmap.close();
  }
}
