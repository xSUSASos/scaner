/**
 * Автоматический поиск документа на фото. Порт core/detect.py (v1.1).
 *
 * Несколько стратегий предлагают КАНДИДАТОВ-четырёхугольников, каждый получает
 * оценку, побеждает лучший (а не самый большой):
 *   1. Canny -> закрытие -> контуры -> approxPolyDP;
 *   2. порог Оцу -> контуры (светлый лист на тёмном фоне);
 *   3. прямые Хафа -> пары «верх/низ» × «лево/право» -> углы как пересечения
 *      (работает, когда угол листа закрыт или лист упирается в край кадра).
 * Оценка = опора на края × контраст сторон × площадь^0.25.
 *
 * Вход — RGB или grayscale cv.Mat любого размера (детекция идёт на копии 800 px).
 */
import { fullFrameCorners, orderPoints, toNormalized } from './geometry.js';
import { withMats } from './mats.js';

export const DEFAULT_DETECT_PARAMS = Object.freeze({
  workSide: 800,          // сторона рабочей копии: быстро и не зависит от разрешения
  blurKsize: 5,           // размытие гасит текст, клетку и шум бумаги
  cannySigma: 0.33,       // пороги Canny = (1 ± sigma) × медиана яркости
  cannySoftCap: [60, 120], // потолок порогов для второй, «мягкой» карты краёв
  closeKsize: 5,          // закрытие склеивает разрывы контура (стратегия 1)
  approxEps: [0.02, 0.03, 0.04, 0.05], // точность approxPolyDP в долях периметра
  minAreaRatio: 0.15,     // меньше — не документ
  maxCandidates: 10,      // сколько крупнейших контуров проверять
  houghLinesPerGroup: 8,  // сильнейших прямых в группе (гориз./верт.)
  maxScored: 25,          // сколько лучших по опоре проверять на контраст
  minScore: 0.35,         // ниже — документа нет, рамка по краям
});

/**
 * @returns {{corners: number[][], found: boolean, strategy: string|null, score: number}}
 */
export function detectDocument(cv, img, params = DEFAULT_DETECT_PARAMS) {
  const p = { ...DEFAULT_DETECT_PARAMS, ...params };
  return withMats((t) => {
    const small = t.add(downscaleTo(cv, img, p.workSide));
    const color = t.add(new cv.Mat());
    if (small.channels() === 1) cv.cvtColor(small, color, cv.COLOR_GRAY2RGB);
    else if (small.channels() === 4) cv.cvtColor(small, color, cv.COLOR_RGBA2RGB);
    else small.copyTo(color);
    const grayRaw = t.add(new cv.Mat());
    cv.cvtColor(color, grayRaw, cv.COLOR_RGB2GRAY);
    const gray = t.add(new cv.Mat());
    cv.GaussianBlur(grayRaw, gray, new cv.Size(p.blurKsize, p.blurKsize), 0);

    const rawEdges = t.add(canny(cv, gray, p.cannySigma));
    // Пороги «от медианы» на светлом кадре высокие — слабый край «бумага -> светлый
    // стол» теряется. Вторая карта с ограниченными порогами даёт ДОПОЛНИТЕЛЬНЫХ
    // кандидатов; оцениваем всех по первой (на пёстром фоне лишние края не мешают).
    const softEdges = t.add(canny(cv, gray, p.cannySigma, p.cannySoftCap));
    const scorer = new Scorer(cv, t, rawEdges, color);
    const closed = t.add(closeMat(cv, rawEdges, p.closeKsize));
    const softClosed = t.add(closeMat(cv, softEdges, p.closeKsize));
    const otsu = t.add(otsuMask(cv, gray, p));

    const candidates = [
      ...contourQuads(cv, closed, p).map((q) => ['canny', q]),
      ...contourQuads(cv, softClosed, p).map((q) => ['canny-soft', q]),
      ...contourQuads(cv, otsu, p).map((q) => ['otsu', q]),
      ...houghQuads(cv, rawEdges, p).map((q) => ['hough', q]),
      ...houghQuads(cv, softEdges, p).map((q) => ['hough-soft', q]),
    ];

    // Два прохода: дешёвая «опора» — для всех (у Хафа их сотни), контраст — для лучших.
    const w = gray.cols;
    const h = gray.rows;
    const rated = [];
    for (const [name, raw] of candidates) {
      const quad = orderPoints(raw);
      const area = polygonArea(quad) / (w * h);
      if (area >= p.minAreaRatio) rated.push([scorer.support(quad) * area ** 0.25, name, quad]);
    }
    rated.sort((a, b) => b[0] - a[0]);

    let best = null;
    let bestScore = 0;
    for (const [prelim, name, quad] of rated.slice(0, p.maxScored)) {
      const score = prelim * scorer.contrast(quad);
      if (score > bestScore) {
        best = [name, quad];
        bestScore = score;
      }
    }

    if (!best || bestScore < p.minScore) {
      return { corners: fullFrameCorners(), found: false, strategy: best?.[0] ?? null, score: bestScore };
    }
    const corners = toNormalized(best[1], w, h).map(([x, y]) => [clamp01(x), clamp01(y)]);
    return { corners: orderPoints(corners), found: true, strategy: best[0], score: bestScore };
  });
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ----------------------------- подготовка -----------------------------

function downscaleTo(cv, img, side) {
  const scale = side / Math.max(img.rows, img.cols);
  const out = new cv.Mat();
  if (scale >= 1) img.copyTo(out);
  else cv.resize(img, out, new cv.Size(Math.round(img.cols * scale), Math.round(img.rows * scale)),
    0, 0, cv.INTER_AREA);
  return out;
}

function median8u(mat) {
  const hist = new Uint32Array(256);
  const data = mat.data;
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  const half = data.length / 2;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= half) return v;
  }
  return 255;
}

function canny(cv, gray, sigma, cap = [255, 255]) {
  const m = median8u(gray);
  const out = new cv.Mat();
  const low = Math.floor(Math.min(cap[0], Math.max(0, (1 - sigma) * m)));
  const high = Math.floor(Math.min(cap[1], (1 + sigma) * m));
  cv.Canny(gray, out, low, high);
  return out;
}

function closeMat(cv, src, k) {
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k));
  const out = new cv.Mat();
  cv.morphologyEx(src, out, cv.MORPH_CLOSE, kernel);
  kernel.delete();
  return out;
}

function otsuMask(cv, gray, p) {
  return withMats((t) => {
    const mask = t.add(new cv.Mat());
    cv.threshold(gray, mask, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    const k = p.closeKsize * 3;
    const kernel = t.add(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k)));
    // Открытие убирает светлые пятна фона, закрытие — тёмный текст внутри листа.
    const opened = t.add(new cv.Mat());
    cv.morphologyEx(mask, opened, cv.MORPH_OPEN, kernel);
    const out = new cv.Mat();
    cv.morphologyEx(opened, out, cv.MORPH_CLOSE, kernel);
    return out;
  });
}

// ----------------------------- кандидаты -----------------------------

function matToPoints(mat) {
  const d = mat.data32S;
  const pts = [];
  for (let i = 0; i < mat.rows; i++) pts.push([d[2 * i], d[2 * i + 1]]);
  return pts;
}

function contourQuads(cv, binary, p) {
  return withMats((t) => {
    const minArea = p.minAreaRatio * binary.rows * binary.cols;
    const contours = t.add(new cv.MatVector());
    const hierarchy = t.add(new cv.Mat());
    cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const list = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = t.add(contours.get(i));
      list.push([cv.contourArea(c), c]);
    }
    list.sort((a, b) => b[0] - a[0]);

    const quads = [];
    for (const [, contour] of list.slice(0, p.maxCandidates)) {
      // Выпуклая оболочка сглаживает «вмятины» (палец на листе, загнутый угол).
      const hull = t.add(new cv.Mat());
      cv.convexHull(contour, hull, false, true);
      if (cv.contourArea(hull) < minArea) continue;
      const perimeter = cv.arcLength(hull, true);
      let quad = null;
      for (const eps of p.approxEps) {
        const approx = t.add(new cv.Mat());
        cv.approxPolyDP(hull, approx, eps * perimeter, true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          quad = matToPoints(approx);
          break;
        }
      }
      // approxPolyDP не свёл к 4 вершинам (скруглённые углы, лист за краем) — упрощаем сами.
      quads.push(quad ?? reduceToQuad(matToPoints(hull)));
    }
    return quads;
  });
}

/** Висвалингам: убираем вершину с наименьшим треугольником с соседями, пока не останется 4. */
export function reduceToQuad(points) {
  const pts = points.map((pt) => [...pt]);
  while (pts.length > 4) {
    let minArea = Infinity;
    let idx = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
      if (area < minArea) {
        minArea = area;
        idx = i;
      }
    }
    pts.splice(idx, 1);
  }
  return pts;
}

function houghQuads(cv, edges, p) {
  const w = edges.cols;
  const h = edges.rows;
  const lines = new cv.Mat();
  let raw;
  try {
    cv.HoughLines(edges, lines, 1, Math.PI / 180, Math.floor(0.15 * Math.min(h, w)));
    const cn = lines.channels(); // rho, theta (+ голоса в некоторых сборках)
    raw = [];
    for (let i = 0; i < Math.min(lines.rows, 400); i++) {
      raw.push([lines.data32F[i * cn], lines.data32F[i * cn + 1]]);
    }
  } finally {
    lines.delete();
  }

  // Нормализуем так, чтобы rho >= 0 (почти вертикальные с θ≈0 и θ≈π становятся
  // сравнимыми) и подавляем близкие прямые (HoughLines отдаёт по убыванию голосов).
  const kept = [];
  const angTol = (8 * Math.PI) / 180;
  for (let [rho, theta] of raw) {
    if (rho < 0) {
      rho = -rho;
      theta -= Math.PI;
    }
    if (kept.every(([r, th]) => Math.abs(rho - r) > 15 || Math.abs(theta - th) > angTol)) {
      kept.push([rho, theta]);
    }
  }
  const tol35 = (35 * Math.PI) / 180;
  const k = p.houghLinesPerGroup;
  const horizontal = kept.filter(([, th]) => Math.abs(th - Math.PI / 2) < tol35).slice(0, k);
  const vertical = kept.filter(([, th]) => Math.abs(th) < tol35).slice(0, k);

  // Пересечения считаем один раз на пару прямых, а не на каждый 4-угольник.
  const cross = horizontal.map((hl) => vertical.map((vl) => intersect(hl, vl)));
  const quads = [];
  const mx = 0.05 * w;
  const my = 0.05 * h;
  for (let a = 0; a < horizontal.length; a++) {
    for (let b = a + 1; b < horizontal.length; b++) {
      for (let l = 0; l < vertical.length; l++) {
        for (let r = l + 1; r < vertical.length; r++) {
          const pts = [cross[a][l], cross[a][r], cross[b][r], cross[b][l]];
          if (pts.some((pt) => pt === null)) continue;
          const quad = orderPoints(pts);
          if (quad.some(([x, y]) => x < -mx || x > w + mx || y < -my || y > h + my)) continue;
          if (isConvex(quad)) quads.push(quad);
        }
      }
    }
  }
  return quads;
}

/** Пересечение прямых x·cosθ + y·sinθ = ρ (правило Крамера). */
export function intersect([r1, t1], [r2, t2]) {
  const a = Math.cos(t1), b = Math.sin(t1), c = Math.cos(t2), d = Math.sin(t2);
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-6) return null;
  return [(r1 * d - b * r2) / det, (a * r2 - r1 * c) / det];
}

export function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function isConvex(quad) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = quad[i];
    const [bx, by] = quad[(i + 1) % 4];
    const [cx, cy] = quad[(i + 2) % 4];
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(z) < 1e-9) return false;
    if (sign === 0) sign = Math.sign(z);
    else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

// ----------------------------- оценка -----------------------------

class Scorer {
  constructor(cv, t, edges, color) {
    this.w = edges.cols;
    this.h = edges.rows;
    // Расширяем края на пару пикселей: сторона может пройти рядом с краем.
    const kernel = t.add(cv.Mat.ones(5, 5, cv.CV_8U));
    const dil = t.add(new cv.Mat());
    cv.dilate(edges, dil, kernel);
    this.edge = dil.data.slice(); // копия: Mat освободится вместе с трекером
    // Lab: евклидово расстояние в нём близко к воспринимаемой разнице цветов.
    const blurred = t.add(new cv.Mat());
    cv.GaussianBlur(color, blurred, new cv.Size(5, 5), 0);
    const lab = t.add(new cv.Mat());
    cv.cvtColor(blurred, lab, cv.COLOR_RGB2Lab);
    this.lab = lab.data.slice();
    // Полосы по обе стороны стороны: отступы ~0.8%..5% кадра (захватывают несколько строк текста).
    const step = Math.max(2, 0.008 * Math.max(this.w, this.h));
    this.offsets = [1, 2, 3, 4, 5, 6].map((k) => k * step);
  }

  *sides(quad) {
    for (let i = 0; i < 4; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      const n = Math.max(Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2), 8);
      const pts = [];
      for (let j = 0; j < n; j++) {
        const s = 0.05 + (0.9 * j) / (n - 1); // без 5% у углов
        pts.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]);
      }
      yield [a, b, pts];
    }
  }

  inside([x, y]) {
    return x >= 0 && x <= this.w - 1 && y >= 0 && y <= this.h - 1;
  }

  index([x, y]) {
    const xi = Math.min(this.w - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(this.h - 1, Math.max(0, Math.round(y)));
    return [xi, yi, yi * this.w + xi];
  }

  /** Средняя доля точек сторон на краях Canny. */
  support(quad) {
    let sum = 0;
    for (const [, , pts] of this.sides(quad)) sum += this.sideSupport(pts);
    return sum / 4;
  }

  /** Сторона вдоль края кадра — «половинная» опора (лист мог уйти за кадр). */
  sideSupport(pts) {
    let total = 0;
    for (const pt of pts) {
      if (!this.inside(pt)) continue;
      const [x, y, i] = this.index(pt);
      if (this.edge[i]) total += 1;
      else if (x <= 2 || x >= this.w - 3 || y <= 2 || y >= this.h - 3) total += 0.5;
    }
    return total / pts.length;
  }

  /** Геометрическое среднее контраста сторон: одна «фальшивая» сторона роняет оценку. */
  contrast(quad) {
    const cx = quad.reduce((s, q) => s + q[0], 0) / 4;
    const cy = quad.reduce((s, q) => s + q[1], 0) / 4;
    let prod = 1;
    for (const [a, b, pts] of this.sides(quad)) prod *= Math.max(this.sideContrast(pts, a, b, [cx, cy]), 0.05);
    return prod ** 0.25;
  }

  /** «Цвет фона» полосы: L — 80-й перцентиль (бумага без чернил), a/b — медиана. */
  bandColor(points) {
    const L = [], A = [], B = [];
    for (const pt of points) {
      const [, , i] = this.index(pt);
      L.push(this.lab[3 * i]);
      A.push(this.lab[3 * i + 1]);
      B.push(this.lab[3 * i + 2]);
    }
    return [percentile(L, 80), percentile(A, 50), percentile(B, 50)];
  }

  /** ΔE «цвета фона» внутри и снаружи стороны, нормированная: ΔE≈30 — явная граница. */
  sideContrast(pts, a, b, center) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) + 1e-9;
    let nx = -(b[1] - a[1]) / len;
    let ny = (b[0] - a[0]) / len;
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    if (nx * (center[0] - mx) + ny * (center[1] - my) > 0) { // нормаль — наружу
      nx = -nx;
      ny = -ny;
    }
    const inner = [];
    const outer = [];
    let total = 0;
    for (const d of this.offsets) {
      for (const [x, y] of pts) {
        total++;
        const o = [x + nx * d, y + ny * d];
        if (!this.inside(o)) continue;
        outer.push(o);
        inner.push([x - nx * d, y - ny * d]);
      }
    }
    if (outer.length < 0.3 * total) return 0.5; // снаружи почти ничего не видно — нейтрально
    const ci = this.bandColor(inner);
    const co = this.bandColor(outer);
    const delta = Math.hypot(ci[0] - co[0], ci[1] - co[1], ci[2] - co[2]);
    return Math.min(1, delta / 30);
  }
}

/** Перцентиль с линейной интерполяцией (как numpy.percentile по умолчанию). */
export function percentile(values, q) {
  const s = Float64Array.from(values).sort();
  if (s.length === 0) return 0;
  const pos = ((s.length - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
