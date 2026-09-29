"""Синтетические тестовые изображения.

Рисуем «лист» с текстом и накладываем его перспективой на фон по ЗАРАНЕЕ
ИЗВЕСТНЫМ углам — так тест может проверить точность детекции численно.
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def make_sheet(w: int = 700, h: int = 990, seed: int = 0) -> np.ndarray:
    """Белый лист с «строками текста» (чёрные полосы и буквы)."""
    rng = np.random.default_rng(seed)
    sheet = np.full((h, w, 3), 245, np.uint8)
    y = 80
    while y < h - 80:
        x = 60
        while x < w - 100:
            word = int(rng.integers(30, 110))
            cv2.rectangle(sheet, (x, y), (min(x + word, w - 60), y + 14), (30, 30, 30), -1)
            x += word + 18
        y += 38
    cv2.putText(sheet, "SCAN TEST", (80, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (20, 20, 160), 3)
    return sheet


def make_photo(corners_norm, size=(1200, 900), bg=(70, 60, 55), shadow=False,
               noise=6, seed=0) -> np.ndarray:
    """Фото листа на фоне. corners_norm — куда попадут TL,TR,BR,BL листа (доли кадра)."""
    w, h = size
    rng = np.random.default_rng(seed)
    photo = np.empty((h, w, 3), np.uint8)
    photo[:] = bg
    # Лёгкая текстура стола, чтобы Canny было что «отфильтровать».
    photo = cv2.add(photo, rng.integers(0, noise + 1, photo.shape, dtype=np.uint8))

    sheet = make_sheet(seed=seed)
    sh, sw = sheet.shape[:2]
    src = np.float32([[0, 0], [sw - 1, 0], [sw - 1, sh - 1], [0, sh - 1]])
    dst = np.float32(np.asarray(corners_norm) * [w - 1, h - 1])
    m = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(sheet, m, (w, h))
    mask = cv2.warpPerspective(np.full((sh, sw), 255, np.uint8), m, (w, h))
    photo[mask > 0] = warped[mask > 0]

    if shadow:  # тень: плавное затемнение слева направо до 45%
        ramp = np.linspace(0.55, 1.0, w, dtype=np.float32)[None, :, None]
        photo = (photo.astype(np.float32) * ramp).astype(np.uint8)
    return photo


def busy_background(size=(900, 1600), seed=3) -> np.ndarray:
    """Пёстрый фон (как принт на ткани): много ярких цветных пятен и линий."""
    w, h = size
    rng = np.random.default_rng(seed)
    bg = np.full((h, w, 3), (60, 40, 90), np.uint8)
    for _ in range(120):
        color = tuple(int(c) for c in rng.integers(0, 256, 3))
        center = (int(rng.integers(0, w)), int(rng.integers(0, h)))
        if rng.random() < 0.5:
            cv2.circle(bg, center, int(rng.integers(10, 80)), color, -1)
        else:
            end = (int(rng.integers(0, w)), int(rng.integers(0, h)))
            cv2.line(bg, center, end, color, int(rng.integers(3, 15)))
    return cv2.GaussianBlur(bg, (5, 5), 0)


def make_busy_photo(corners_norm, size=(900, 1600)) -> np.ndarray:
    """Сценарий реального фото: пёстрый фон, лист почти во весь кадр,
    верхний левый угол листа перекрыт розовой обложкой (контур листа разорван)."""
    w, h = size
    photo = busy_background(size)
    sheet = make_sheet(700, 990)
    sh, sw = sheet.shape[:2]
    src = np.float32([[0, 0], [sw - 1, 0], [sw - 1, sh - 1], [0, sh - 1]])
    dst = np.float32(np.asarray(corners_norm) * [w - 1, h - 1])
    m = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(sheet, m, (w, h))
    mask = cv2.warpPerspective(np.full((sh, sw), 255, np.uint8), m, (w, h))
    photo[mask > 0] = warped[mask > 0]
    tl = dst[0]
    cover = np.int32([[tl[0] - 60, tl[1] - 80], [tl[0] + 220, tl[1] - 120],
                      [tl[0] + 240, tl[1] + 25], [tl[0] - 40, tl[1] + 70]])
    cv2.fillPoly(photo, [cover], (150, 140, 245))  # розовая обложка поверх угла
    return photo


TILTED = np.array([[0.22, 0.12], [0.80, 0.18], [0.76, 0.90], [0.18, 0.84]])


@pytest.fixture
def tilted_photo():
    return make_photo(TILTED), TILTED


@pytest.fixture
def cyr_dir(tmp_path) -> Path:
    d = tmp_path / "Документы сканы"
    d.mkdir()
    return d
