/**
 * Тесты core (порт tests/*.py): node --test tests/
 */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

import { detectDocument, intersect, percentile, polygonArea, reduceToQuad } from '../src/core/detect.js';
import {
  bwDocument, brightnessContrast, defaultFilter, magicColor, rotate90, applyFilter,
} from '../src/core/filters.js';
import { fullFrameCorners, orderPoints, outputSize, warpDocument } from '../src/core/geometry.js';
import { render } from '../src/core/pipeline.js';
import {
  getCv, makeBusyPhoto, makePhoto, makeSheet, maxCornerError, TILTED,
} from './helpers.mjs';

let cv;
before(async () => { cv = await getCv(); });

describe('geometry', () => {
  const ordered = [[10, 20], [110, 25], [105, 220], [5, 210]];
  const perms = [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2], [2, 3, 0, 1]];
  for (const perm of perms) {
    test(`orderPoints перестановка ${perm}`, () => {
      assert.deepEqual(orderPoints(perm.map((i) => ordered[i])), ordered);
    });
  }

  test('outputSize — по длиннейшим сторонам +1', () => {
    assert.deepEqual(outputSize([[0, 0], [100, 0], [120, 50], [-10, 50]]), [131, 55]);
  });

  test('warp всего кадра — тождество', () => {
    const img = makeSheet(cv, 200, 300);
    const out = warpDocument(cv, img, fullFrameCorners());
    assert.equal(out.cols, 200);
    assert.equal(out.rows, 300);
    img.delete(); out.delete();
  });

  test('пересечение прямых и площадь', () => {
    const p = intersect([5, 0], [7, Math.PI / 2]); // x=5, y=7
    assert.ok(Math.abs(p[0] - 5) < 1e-9 && Math.abs(p[1] - 7) < 1e-9);
    assert.equal(polygonArea([[0, 0], [4, 0], [4, 3], [0, 3]]), 12);
    assert.equal(reduceToQuad([[0, 0], [5, -0.1], [10, 0], [10, 10], [0, 10]]).length, 4);
    assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  });
});

describe('detect', () => {
  const check = (photo, truth, tol = 0.02) => {
    const r = detectDocument(cv, photo);
    photo.delete();
    assert.ok(r.found, `не найден (score=${r.score})`);
    assert.ok(maxCornerError(r.corners, truth) < tol,
      `ошибка ${maxCornerError(r.corners, truth).toFixed(3)} (${r.strategy})`);
  };

  test('наклонный лист', () => check(makePhoto(cv, TILTED), TILTED));
  test('лист в тени', () => check(makePhoto(cv, TILTED, { shadow: true }), TILTED));
  for (const seed of [0, 1, 2, 3, 4]) {
    test(`светлый фон, лист #${seed}`, () => check(makePhoto(cv, TILTED, { bg: [195, 190, 185], seed }), TILTED));
  }

  test('ромб 45°', () => {
    const diamond = [[0.5, 0.05], [0.9, 0.5], [0.5, 0.95], [0.1, 0.5]];
    const photo = makePhoto(cv, diamond, { size: [1000, 1000] });
    const r = detectDocument(cv, photo);
    photo.delete();
    assert.ok(r.found);
    for (const p of diamond) {
      assert.ok(Math.min(...r.corners.map((c) => Math.hypot(c[0] - p[0], c[1] - p[1]))) < 0.02);
    }
  });

  test('пёстрый фон, угол закрыт обложкой (регрессия реального фото)', () => {
    const truth = [[0.03, 0.07], [0.93, 0.06], [1.0, 0.84], [0.0, 0.86]];
    check(makeBusyPhoto(cv, truth), truth, 0.03);
  });

  test('большое разрешение (не зависит от размера)', () => {
    check(makePhoto(cv, TILTED, { size: [3000, 2250] }), TILTED);
  });

  test('шум -> рамка по краям', () => {
    const noise = new cv.Mat(600, 800, cv.CV_8UC3);
    let s = 1;
    for (let i = 0; i < noise.data.length; i++) { s = (s * 16807) % 2147483647; noise.data[i] = 100 + (s % 40); }
    const r = detectDocument(cv, noise);
    noise.delete();
    assert.equal(r.found, false);
    assert.deepEqual(r.corners, fullFrameCorners());
  });

  test('маленький прямоугольник игнорируется', () => {
    const tiny = [[0.45, 0.45], [0.55, 0.45], [0.55, 0.55], [0.45, 0.55]];
    const photo = makePhoto(cv, tiny);
    const r = detectDocument(cv, photo);
    photo.delete();
    assert.equal(r.found, false);
  });
});

describe('filters', () => {
  const mean = (mat, maskFn) => {
    let s = 0, n = 0;
    const ch = mat.channels();
    for (let i = 0; i < mat.rows * mat.cols; i++) {
      if (!maskFn(i)) continue;
      for (let c = 0; c < ch; c++) s += mat.data[i * ch + c];
      n += ch;
    }
    return s / n;
  };

  test('магия цвета убирает тень и сохраняет текст', () => {
    const sheet = makeSheet(cv);
    const shadowed = sheet.mat_clone(); // глубокая копия (clone() в OpenCV.js копирует только «ручку»)
    const w = sheet.cols;
    for (let i = 0; i < shadowed.rows * w; i++) {
      const k = 1 - (0.5 * (i % w)) / (w - 1);
      for (let c = 0; c < 3; c++) shadowed.data[3 * i + c] *= k;
    }
    const out = magicColor(cv, shadowed);
    const isPaper = (i) => sheet.data[3 * i] > 200 && sheet.data[3 * i + 1] > 200;
    const rightPaper = (i) => isPaper(i) && (i % w) > w * 0.75;
    assert.ok(mean(out, rightPaper) > 235, 'бумага в тени стала белой');
    assert.ok(mean(out, (i) => !isPaper(i)) < 90, 'текст остался тёмным');
    [sheet, shadowed, out].forEach((m) => m.delete());
  });

  test('Ч/Б — бинарный результат', () => {
    const sheet = makeSheet(cv);
    const out = bwDocument(cv, sheet);
    assert.equal(out.channels(), 1);
    assert.ok(out.data.every((v) => v === 0 || v === 255));
    sheet.delete(); out.delete();
  });

  test('яркость/контраст', () => {
    const img = cv.matFromArray(1, 5, cv.CV_8UC1, [0, 64, 128, 192, 255]);
    const same = brightnessContrast(cv, img, 0, 0);
    assert.deepEqual([...same.data], [0, 64, 128, 192, 255]);
    const flat = brightnessContrast(cv, img, 0, -100);
    assert.ok(Math.max(...flat.data) - Math.min(...flat.data) <= 1);
    const rgb = new cv.Mat(2, 2, cv.CV_8UC3, new cv.Scalar(100, 100, 100));
    const brighter = brightnessContrast(cv, rgb, 50, 0);
    assert.ok(brighter.data.every((v) => v > 100));
    [img, same, flat, rgb, brighter].forEach((m) => m.delete());
  });

  test('поворот по часовой', () => {
    const img = cv.matFromArray(2, 2, cv.CV_8UC1, [1, 2, 3, 4]);
    const r = rotate90(cv, img, 1);
    assert.deepEqual([...r.data], [3, 1, 4, 2]);
    img.delete(); r.delete();
  });

  test('оттенки серого — один канал', () => {
    const sheet = makeSheet(cv);
    const out = applyFilter(cv, sheet, { ...defaultFilter(), mode: 'gray' });
    assert.equal(out.channels(), 1);
    sheet.delete(); out.delete();
  });
});

describe('pipeline', () => {
  test('превью ≈ уменьшенный полный результат', () => {
    const photo = makePhoto(cv, TILTED, { size: [2400, 1800] });
    const small = new cv.Mat();
    cv.resize(photo, small, new cv.Size(800, 600), 0, 0, cv.INTER_AREA);
    const recipe = { corners: TILTED, filter: defaultFilter(), rotation: 1 };
    const full = render(cv, photo, recipe);
    const prev = render(cv, small, recipe);
    assert.ok(Math.abs(full.cols / full.rows - prev.cols / prev.rows) < 0.01);
    assert.ok(full.rows > prev.rows * 2.5);
    [photo, small, full, prev].forEach((m) => m.delete());
  });
});
