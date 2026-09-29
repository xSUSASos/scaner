/**
 * Общие помощники тестов: загрузка OpenCV.js в Node и синтетические «фото документов»
 * (порт tests/conftest.py): лист с текстом накладывается перспективой на фон по
 * ЗАРАНЕЕ ИЗВЕСТНЫМ углам — детекцию можно проверять численно.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let cvPromise = null;

export function getCv() {
  if (!cvPromise) {
    cvPromise = (async () => {
      const mod = require('@techstark/opencv-js');
      if (mod instanceof Promise || typeof mod.then === 'function') return await mod;
      if (mod.Mat) return mod;
      await new Promise((resolve) => { mod.onRuntimeInitialized = resolve; });
      return mod;
    })();
  }
  return cvPromise;
}

/** Детерминированный генератор случайных чисел (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Белый лист (RGB) со «строками текста» и красным заголовком. */
export function makeSheet(cv, w = 700, h = 990, seed = 0) {
  const rand = rng(seed + 1);
  const sheet = new cv.Mat(h, w, cv.CV_8UC3, new cv.Scalar(245, 245, 245));
  for (let y = 80; y < h - 80; y += 38) {
    let x = 60;
    while (x < w - 100) {
      const word = 30 + Math.floor(rand() * 80);
      cv.rectangle(sheet, new cv.Point(x, y), new cv.Point(Math.min(x + word, w - 60), y + 14),
        new cv.Scalar(30, 30, 30), -1);
      x += word + 18;
    }
  }
  cv.putText(sheet, 'SCAN TEST', new cv.Point(80, 60), cv.FONT_HERSHEY_SIMPLEX, 1.4,
    new cv.Scalar(160, 20, 20), 3);
  return sheet;
}

export const TILTED = [[0.22, 0.12], [0.8, 0.18], [0.76, 0.9], [0.18, 0.84]];

function pasteWarped(cv, photo, sheet, cornersNorm) {
  const w = photo.cols, h = photo.rows;
  const src = cv.matFromArray(4, 1, cv.CV_32FC2,
    [0, 0, sheet.cols - 1, 0, sheet.cols - 1, sheet.rows - 1, 0, sheet.rows - 1]);
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, cornersNorm.flatMap(([x, y]) => [x * (w - 1), y * (h - 1)]));
  const m = cv.getPerspectiveTransform(src, dst);
  const warped = new cv.Mat();
  cv.warpPerspective(sheet, warped, m, new cv.Size(w, h));
  const ones = new cv.Mat(sheet.rows, sheet.cols, cv.CV_8UC1, new cv.Scalar(255));
  const mask = new cv.Mat();
  cv.warpPerspective(ones, mask, m, new cv.Size(w, h));
  warped.copyTo(photo, mask);
  [src, dst, m, warped, ones, mask].forEach((x) => x.delete());
}

/** Фото листа на однотонном фоне с шумом; shadow — затемнение слева до 45%. */
export function makePhoto(cv, cornersNorm, { size = [1200, 900], bg = [55, 60, 70], shadow = false, seed = 0 } = {}) {
  const [w, h] = size;
  const rand = rng(seed + 7);
  const photo = new cv.Mat(h, w, cv.CV_8UC3, new cv.Scalar(...bg));
  const d = photo.data;
  for (let i = 0; i < d.length; i++) d[i] = Math.min(255, d[i] + Math.floor(rand() * 7));
  const sheet = makeSheet(cv, 700, 990, seed);
  pasteWarped(cv, photo, sheet, cornersNorm);
  sheet.delete();
  if (shadow) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const k = 0.55 + (0.45 * x) / (w - 1);
        const i = 3 * (y * w + x);
        d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
      }
    }
  }
  return photo;
}

/** Сценарий реального фото: пёстрый фон, угол листа закрыт розовой обложкой. */
export function makeBusyPhoto(cv, cornersNorm, size = [900, 1600]) {
  const [w, h] = size;
  const rand = rng(3);
  const photo = new cv.Mat(h, w, cv.CV_8UC3, new cv.Scalar(90, 40, 60));
  for (let i = 0; i < 120; i++) {
    const color = new cv.Scalar(rand() * 256, rand() * 256, rand() * 256);
    const c = new cv.Point(Math.floor(rand() * w), Math.floor(rand() * h));
    if (rand() < 0.5) cv.circle(photo, c, 10 + Math.floor(rand() * 70), color, -1);
    else cv.line(photo, c, new cv.Point(Math.floor(rand() * w), Math.floor(rand() * h)), color, 3 + Math.floor(rand() * 12));
  }
  cv.GaussianBlur(photo, photo, new cv.Size(5, 5), 0);
  const sheet = makeSheet(cv);
  pasteWarped(cv, photo, sheet, cornersNorm);
  sheet.delete();
  const [tx, ty] = [cornersNorm[0][0] * (w - 1), cornersNorm[0][1] * (h - 1)];
  const cover = cv.matFromArray(4, 1, cv.CV_32SC2, [
    tx - 60, ty - 80, tx + 220, ty - 120, tx + 240, ty + 25, tx - 40, ty + 70].map(Math.round));
  const pts = new cv.MatVector();
  pts.push_back(cover);
  cv.fillPoly(photo, pts, new cv.Scalar(245, 140, 150));
  cover.delete(); pts.delete();
  return photo;
}

export function maxCornerError(found, expected) {
  let m = 0;
  for (let i = 0; i < 4; i++) {
    m = Math.max(m, Math.abs(found[i][0] - expected[i][0]), Math.abs(found[i][1] - expected[i][1]));
  }
  return m;
}
