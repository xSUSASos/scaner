/**
 * Фильтры улучшения документа. Порт core/filters.py.
 *
 * Все размеры ядер — ОТНОСИТЕЛЬНО размера изображения, чтобы превью и
 * финальный результат выглядели одинаково.
 * Вход — RGB (CV_8UC3). Выход — RGB (original/magic) или одноканальный (gray/bw).
 */
import { withMats } from './mats.js';

export const FilterMode = Object.freeze({
  ORIGINAL: 'original',
  MAGIC: 'magic',
  BW: 'bw',
  GRAY: 'gray',
});

export const FILTER_TITLES = {
  original: 'Оригинал',
  magic: 'Магия цвета',
  bw: 'Ч/Б документ',
  gray: 'Оттенки серого',
};

export function defaultFilter() {
  return {
    mode: FilterMode.MAGIC,
    // Ч/Б: окно адаптивного порога, % от длинной стороны. Меньше — лучше держит
    // неравномерный свет, но «съедает» жирные линии и заливки.
    bwBlockPercent: 2.5,
    // Ч/Б: насколько пиксель темнее среднего по окну, чтобы стать чёрным.
    // Больше — чище фон, но тоньше текст.
    bwC: 12,
    brightness: 0, // -100..100
    contrast: 0,   // -100..100
  };
}

/** Применить фильтр; возвращает НОВЫЙ Mat (исходный не меняется). */
export function applyFilter(cv, img, f) {
  let out;
  if (f.mode === FilterMode.MAGIC) out = magicColor(cv, img);
  else if (f.mode === FilterMode.BW) out = bwDocument(cv, img, f.bwBlockPercent, f.bwC);
  else if (f.mode === FilterMode.GRAY) out = toGray(cv, img);
  else {
    // Не img.clone(): в OpenCV.js это копия JS-«ручки» (те же данные), а не матрицы.
    out = new cv.Mat();
    img.copyTo(out);
  }
  if (f.brightness || f.contrast) {
    const adjusted = brightnessContrast(cv, out, f.brightness, f.contrast);
    out.delete();
    out = adjusted;
  }
  return out;
}

export function toGray(cv, img) {
  const out = new cv.Mat();
  if (img.channels() === 1) img.copyTo(out);
  else cv.cvtColor(img, out, cv.COLOR_RGB2GRAY);
  return out;
}

const odd = (n, min = 3) => {
  const v = Math.max(min, Math.round(n));
  return v % 2 ? v : v + 1;
};

/**
 * Оценка «освещения» — как выглядел бы лист без текста. Фон — низкочастотный
 * сигнал, считаем его на копии 512 px и растягиваем обратно. Закрытие
 * (dilate->erode) заливает тёмные штрихи окружающей бумагой, затем размытие.
 */
export function estimateBackground(cv, img, workSide = 512) {
  return withMats((t) => {
    const scale = Math.min(1, workSide / Math.max(img.rows, img.cols));
    const small = t.add(new cv.Mat());
    cv.resize(img, small, new cv.Size(Math.max(1, Math.round(img.cols * scale)),
      Math.max(1, Math.round(img.rows * scale))), 0, 0, cv.INTER_AREA);
    const side = Math.max(small.rows, small.cols);
    const k = odd(side / 40);
    const kernel = t.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
    const closed = t.add(new cv.Mat());
    cv.morphologyEx(small, closed, cv.MORPH_CLOSE, kernel);
    const b = odd(side / 20);
    const blurred = t.add(new cv.Mat());
    cv.GaussianBlur(closed, blurred, new cv.Size(b, b), 0);
    const bg = new cv.Mat();
    cv.resize(blurred, bg, new cv.Size(img.cols, img.rows), 0, 0, cv.INTER_LINEAR);
    return bg;
  });
}

function lut(cv, fn) {
  const table = new cv.Mat(1, 256, cv.CV_8UC1);
  for (let i = 0; i < 256; i++) table.data[i] = Math.max(0, Math.min(255, Math.round(fn(i))));
  return table;
}

/** Применить таблицу к 1- или 3-канальному изображению (LUT: 256 значений вместо миллионов пикселей). */
function applyLut(cv, img, table) {
  const out = new cv.Mat();
  if (img.channels() === 1) {
    cv.LUT(img, table, out);
    return out;
  }
  // LUT в OpenCV.js надёжнее работает с таблицей того же числа каналов.
  withMats((t) => {
    const tables = t.add(new cv.MatVector());
    for (let c = 0; c < img.channels(); c++) tables.push_back(table);
    const table3 = t.add(new cv.Mat());
    cv.merge(tables, table3);
    cv.LUT(img, table3, out);
  });
  return out;
}

/**
 * «Магия цвета»: убрать тени, усилить текст, добавить резкость.
 *  1) img / фон * 255 — бумага белая, тени исчезают, цвета сохраняются;
 *  2) v = 255 - (255 - v) * textGain — белое остаётся белым, тёмное темнеет;
 *  3) unsharp mask: img + sharpen * (img - blur).
 */
export function magicColor(cv, img, textGain = 1.4, sharpen = 0.6) {
  return withMats((t) => {
    const bg = t.add(estimateBackground(cv, img));
    // max(bg, 1): защита от деления на ноль в совсем чёрных местах.
    const ones = t.add(new cv.Mat(bg.rows, bg.cols, bg.type(), new cv.Scalar(1, 1, 1, 1)));
    const safeBg = t.add(new cv.Mat());
    cv.max(bg, ones, safeBg);
    const norm = t.add(new cv.Mat());
    cv.divide(img, safeBg, norm, 255);

    const table = t.add(lut(cv, (v) => 255 - (255 - v) * textGain));
    const contrasted = t.add(applyLut(cv, norm, table));

    const sigma = Math.max(0.8, Math.max(img.rows, img.cols) / 2000);
    const blurred = t.add(new cv.Mat());
    cv.GaussianBlur(contrasted, blurred, new cv.Size(0, 0), sigma);
    const out = new cv.Mat();
    cv.addWeighted(contrasted, 1 + sharpen, blurred, -sharpen, 0, out);
    return out;
  });
}

/**
 * Ч/Б документ: adaptiveThreshold (MEAN_C — среднее по окну за O(1) на пиксель
 * при любом размере окна; GAUSSIAN_C на больших окнах в разы медленнее).
 */
export function bwDocument(cv, img, blockPercent = 2.5, c = 12) {
  return withMats((t) => {
    const gray = t.add(toGray(cv, img));
    const side = Math.max(gray.rows, gray.cols);
    const block = odd(side * blockPercent / 100);
    // Лёгкое сглаживание убирает зернистость бумаги, иначе фон «рябит» точками.
    const smooth = t.add(new cv.Mat());
    cv.GaussianBlur(gray, smooth, new cv.Size(0, 0), Math.max(0.5, side / 3000));
    const out = new cv.Mat();
    cv.adaptiveThreshold(smooth, out, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, block, c);
    return out;
  });
}

/** contrast -100..100 -> наклон 0..2 вокруг 127.5; brightness -100..100 -> сдвиг ±127. */
export function brightnessContrast(cv, img, brightness = 0, contrast = 0) {
  const alpha = 1 + contrast / 100;
  const beta = brightness * 1.27;
  const table = lut(cv, (x) => (x - 127.5) * alpha + 127.5 + beta);
  try {
    return applyLut(cv, img, table);
  } finally {
    table.delete();
  }
}

/** Повернуть на quarterTurns * 90° по часовой стрелке. Новый Mat. */
export function rotate90(cv, img, quarterTurns) {
  const k = ((quarterTurns % 4) + 4) % 4;
  const out = new cv.Mat();
  if (k === 0) img.copyTo(out);
  else cv.rotate(img, out, [null, cv.ROTATE_90_CLOCKWISE, cv.ROTATE_180, cv.ROTATE_90_COUNTERCLOCKWISE][k]);
  return out;
}
