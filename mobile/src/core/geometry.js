/**
 * Геометрия: порядок углов, пересчёт координат, выравнивание перспективы.
 * Порт core/geometry.py.
 *
 * Углы документа везде хранятся в НОРМИРОВАННЫХ координатах [0..1]:
 * одни и те же углы подходят и к превью, и к полному снимку.
 * Точка — массив [x, y].
 */
import { withMats } from './mats.js';

export function fullFrameCorners() {
  return [[0, 0], [1, 0], [1, 1], [0, 1]];
}

/**
 * Упорядочить 4 точки как TL, TR, BR, BL.
 * Сортировка по углу atan2 вокруг центра (в экранных координатах рост угла —
 * обход по часовой стрелке), затем старт с точки с минимальной x+y.
 * Надёжнее трюка «min/max по x+y», который ломается на листе, повёрнутом на 45°.
 */
export function orderPoints(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const clockwise = [...pts].sort(
    (a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (clockwise[i][0] + clockwise[i][1] < clockwise[start][0] + clockwise[start][1]) start = i;
  }
  return [0, 1, 2, 3].map((k) => [...clockwise[(start + k) % 4]]);
}

export function toPixels(corners, width, height) {
  return corners.map(([x, y]) => [x * (width - 1), y * (height - 1)]);
}

export function toNormalized(cornersPx, width, height) {
  return cornersPx.map(([x, y]) => [x / Math.max(width - 1, 1), y / Math.max(height - 1, 1)]);
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Размер результата по реальным длинам сторон: максимум из противоположных
 * сторон (дальняя от камеры короче — по максимуму не теряем разрешение), +1 пиксель.
 */
export function outputSize(cornersPx) {
  const [tl, tr, br, bl] = cornersPx;
  const w = Math.max(dist(tr, tl), dist(br, bl));
  const h = Math.max(dist(bl, tl), dist(br, tr));
  return [Math.max(1, Math.round(w) + 1), Math.max(1, Math.round(h) + 1)];
}

/** Вырезать документ и развернуть в прямоугольник. Возвращает новый cv.Mat. */
export function warpDocument(cv, src, corners) {
  return withMats((t) => {
    const px = orderPoints(toPixels(corners, src.cols, src.rows));
    const [w, h] = outputSize(px);
    const srcPts = t.add(cv.matFromArray(4, 1, cv.CV_32FC2, px.flat()));
    const dstPts = t.add(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w - 1, 0, w - 1, h - 1, 0, h - 1]));
    const m = t.add(cv.getPerspectiveTransform(srcPts, dstPts));
    const out = new cv.Mat();
    cv.warpPerspective(src, out, m, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    return out;
  });
}

/** Уменьшить так, чтобы длинная сторона была <= side (маленькие не увеличиваем). Новый Mat. */
export function downscale(cv, src, side) {
  const scale = side / Math.max(src.rows, src.cols);
  const out = new cv.Mat();
  if (scale >= 1) {
    src.copyTo(out);
  } else {
    // INTER_AREA — правильная интерполяция для уменьшения (усредняет, без муара).
    cv.resize(src, out, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)),
      0, 0, cv.INTER_AREA);
  }
  return out;
}
