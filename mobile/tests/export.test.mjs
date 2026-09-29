/**
 * Тесты экспорта (порт tests/test_export.py): чистые помощники и сборка PDF в Node.
 * PDF-тестам нужен vendor/ (npm run vendor) — без него они пропускаются.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, test } from 'node:test';

import { autoDpi, exportImages, exportPdf, makeBaseName } from '../src/services/export.js';
import {
  buildBilevelPng, imageSize, packBilevelRows, pageSizePt, parsePng, zlibCompress,
} from '../src/services/imaging.js';

const PDF_LIB = new URL('../vendor/pdf-lib/pdf-lib.esm.min.js', import.meta.url);
const noVendor = !existsSync(PDF_LIB) && 'нет vendor/ — выполните npm run vendor';

// Настоящий JPEG 40×30 (Pillow), чтобы проверить вставку «как есть».
const JPEG_40x30 = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAeACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCSiiivGPWCiiigAooooAKKKKACiiigAooooA//2Q==',
  'base64',
);

/** Ч/Б «страница» w×h в RGBA: чёрная диагональ на белом. */
function bwRgba(w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) {
    const x = Math.floor((y * w) / h);
    rgba.fill(0, (y * w + x) * 4, (y * w + x) * 4 + 3);
  }
  return rgba;
}

/** 8-битный RGBA PNG (как из canvas) — через node:zlib. */
function rgbaPng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 бит, RGBA
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function bilevelPng(w, h) {
  const zdata = await zlibCompress(packBilevelRows(bwRgba(w, h), w, h));
  return buildBilevelPng(w, h, zdata, autoDpi(w, h));
}

const page = (blob, width, height, binary = false) => ({ blob, width, height, binary });

describe('autoDpi (как dpi_for_size в десктопе)', () => {
  test('длинная сторона = 297 мм', () => {
    assert.equal(autoDpi(2480, 3508), 300); // A4 при 300 dpi
    assert.equal(autoDpi(3508, 2480), 300); // альбомная — то же
    assert.equal(autoDpi(3024, 4032), 345);
  });
  test('ограничение 72..1200', () => {
    assert.equal(autoDpi(10, 10), 72);
    assert.equal(autoDpi(100000, 100), 1200);
  });
  test('размер страницы PDF ≈ A4', () => {
    const { width, height } = pageSizePt(2480, 3508);
    assert.ok(Math.abs(height - 841.89) < 1, `высота ${height}`);
    assert.ok(Math.abs(width - 595.28) < 1, `ширина ${width}`);
  });
});

describe('makeBaseName', () => {
  test('формат «Скан ГГГГ-ММ-ДД ЧЧ-ММ»', () => {
    assert.equal(makeBaseName(new Date(2026, 8, 9, 4, 5)), 'Скан 2026-09-09 04-05');
  });
  test('без символов, запрещённых в именах файлов', () => {
    assert.doesNotMatch(makeBaseName(), /[\\/:*?"<>|]/);
  });
});

describe('imaging', () => {
  test('imageSize читает JPEG и PNG', async () => {
    assert.deepEqual(imageSize(new Uint8Array(JPEG_40x30)), { width: 40, height: 30 });
    assert.deepEqual(imageSize(await bilevelPng(33, 17)), { width: 33, height: 17 });
  });

  test('1-битный PNG: 1 бит на пиксель, пиксели на месте', async () => {
    const w = 21, h = 10; // ширина не кратна 8 — проверяем хвост строки
    const info = parsePng(await bilevelPng(w, h));
    assert.equal(info.bitDepth, 1);
    assert.equal(info.colorType, 0);
    const rows = inflateSync(info.idat);
    const stride = Math.ceil(w / 8) + 1;
    assert.equal(rows.length, stride * h);
    for (let y = 0; y < h; y++) {
      assert.equal(rows[y * stride], 0, 'фильтр строки None');
      const black = Math.floor((y * w) / h);
      for (let x = 0; x < w; x++) {
        const bit = (rows[y * stride + 1 + (x >> 3)] >> (7 - (x & 7))) & 1;
        assert.equal(bit, x === black ? 0 : 1, `пиксель ${x},${y}`);
      }
    }
  });
});

describe('exportPdf', { skip: noVendor }, () => {
  test('N страниц, размер A4 по длинной стороне, ориентация по картинке', async () => {
    const { PDFDocument } = await import(PDF_LIB);
    const jpeg = new Blob([JPEG_40x30], { type: 'image/jpeg' });
    const png1 = new Blob([await bilevelPng(1240, 1754)], { type: 'image/png' }); // A4 при 150 dpi
    const png8 = new Blob([rgbaPng(40, 60, bwRgba(40, 60))], { type: 'image/png' });
    const renders = [page(jpeg, 40, 30), page(png1, 1240, 1754, true), page(png8, 40, 60, true)];
    const progress = [];
    const blob = await exportPdf(renders, {
      renderPage: async (p, opts) => { assert.equal(opts.format, 'auto'); return p; },
      onProgress: (done, total, text) => progress.push([done, total, text]),
      title: 'Тест',
    });
    assert.equal(blob.type, 'application/pdf');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    assert.equal(doc.getPageCount(), 3);
    const sizes = doc.getPages().map((p) => p.getSize());
    assert.ok(sizes[0].width > sizes[0].height, 'альбомная');
    assert.ok(sizes[1].height > sizes[1].width, 'книжная');
    assert.ok(Math.abs(sizes[1].height - 841.89) < 1, 'A4 по длинной стороне');
    // Крошечная картинка: DPI упирается в минимум 72 — 1 px = 1 pt, как в десктопе.
    assert.deepEqual(sizes[0], { width: 40, height: 30 });
    assert.equal(doc.getTitle(), 'Тест');
    assert.deepEqual(progress.at(-1).slice(0, 2), [3, 3]);

    // JPEG вставлен без перекодирования: его байты целиком есть в файле.
    assert.ok(Buffer.from(bytes).includes(JPEG_40x30), 'JPEG перекодирован');
    // Ч/Б страница — 1-битная картинка.
    assert.match(Buffer.from(bytes).toString('latin1'), /\/BitsPerComponent 1/);
  });

  test('отмена через AbortSignal', async () => {
    const ctrl = new AbortController();
    const jpeg = new Blob([JPEG_40x30], { type: 'image/jpeg' });
    await assert.rejects(
      exportPdf([1, 2, 3], {
        renderPage: async () => { ctrl.abort(); return page(jpeg, 40, 30); },
        signal: ctrl.signal,
      }),
      { name: 'AbortError' },
    );
  });

  test('пустой список — понятная ошибка', async () => {
    await assert.rejects(exportPdf([], { renderPage: async () => null }), /Нет страниц/);
  });
});

describe('exportImages', () => {
  test('имена base_001.jpg..., формат передаётся в renderPage', async () => {
    const jpeg = new Blob([JPEG_40x30], { type: 'image/jpeg' });
    const files = await exportImages(['a', 'b'], {
      renderPage: async (p, opts) => { assert.equal(opts.format, 'jpeg'); return page(jpeg, 40, 30); },
      format: 'jpeg',
      baseName: 'Скан: тест',
    });
    assert.deepEqual(files.map((f) => f.name), ['Скан_ тест_001.jpg', 'Скан_ тест_002.jpg']);
    assert.equal(files[0].type, 'image/jpeg');
  });

  test('PNG для Ч/Б страницы — 1-битный', async () => {
    const png1 = new Blob([await bilevelPng(50, 70)], { type: 'image/png' });
    const [file] = await exportImages(['a'], {
      renderPage: async () => page(png1, 50, 70, true), format: 'png', baseName: 'x',
    });
    assert.equal(file.name, 'x_001.png');
    assert.equal(parsePng(new Uint8Array(await file.arrayBuffer())).bitDepth, 1);
  });
});
