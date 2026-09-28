"""Фильтры улучшения документа.

Главный принцип: все размеры ядер задаются ОТНОСИТЕЛЬНО размера изображения.
Иначе превью (1600 px) и оригинал (8000 px) выглядели бы по-разному:
ядро 31 px на превью — это «буква», а на оригинале — «пол-буквы».

Цветные функции принимают BGR, результат: BGR (original/magic) или
одноканальный uint8 (gray/bw) — одноканальные PDF/PNG заметно легче.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import cv2
import numpy as np


class FilterMode(str, Enum):
    ORIGINAL = "original"
    MAGIC = "magic"
    BW = "bw"
    GRAY = "gray"


FILTER_TITLES = {
    FilterMode.ORIGINAL: "Оригинал",
    FilterMode.MAGIC: "Магия цвета",
    FilterMode.BW: "Ч/Б документ",
    FilterMode.GRAY: "Оттенки серого",
}


@dataclass
class FilterSettings:
    mode: FilterMode = FilterMode.MAGIC
    # Ч/Б: размер окна адаптивного порога в % от длинной стороны.
    # Меньше — лучше держит неравномерный свет, но «съедает» толстые линии и заливки.
    bw_block_percent: float = 2.5
    # Ч/Б: константа C — насколько пиксель должен быть темнее среднего по окну,
    # чтобы стать чёрным. Больше C — чище фон, но тоньше/бледнее текст.
    bw_c: int = 12
    # Яркость и контраст, -100..100, применяются после основного фильтра.
    brightness: int = 0
    contrast: int = 0


def apply_filter(img: np.ndarray, s: FilterSettings) -> np.ndarray:
    if s.mode == FilterMode.MAGIC:
        out = magic_color(img)
    elif s.mode == FilterMode.BW:
        out = bw_document(img, s.bw_block_percent, s.bw_c)
    elif s.mode == FilterMode.GRAY:
        out = to_gray(img)
    else:
        out = img
    if s.brightness or s.contrast:
        out = brightness_contrast(out, s.brightness, s.contrast)
    return out


def to_gray(img: np.ndarray) -> np.ndarray:
    return img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def _odd(n: float, minimum: int = 3) -> int:
    n = max(minimum, int(round(n)))
    return n if n % 2 else n + 1


def estimate_background(img: np.ndarray, work_side: int = 512) -> np.ndarray:
    """Оценка «освещения» — как выглядел бы лист без текста.

    Фон — низкочастотный сигнал, поэтому считаем его на маленькой копии
    (быстро даже для 50 Мп) и растягиваем обратно. Закрытие (dilate->erode)
    заливает тёмные штрихи текста окружающей бумагой, затем размываем.
    """
    h, w = img.shape[:2]
    scale = min(1.0, work_side / max(h, w))
    small = cv2.resize(img, (max(1, round(w * scale)), max(1, round(h * scale))),
                       interpolation=cv2.INTER_AREA)
    side = max(small.shape[:2])
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (_odd(side / 40),) * 2)
    bg = cv2.morphologyEx(small, cv2.MORPH_CLOSE, kernel)
    bg = cv2.GaussianBlur(bg, (_odd(side / 20),) * 2, 0)
    return cv2.resize(bg, (w, h), interpolation=cv2.INTER_LINEAR)


def magic_color(img: np.ndarray, text_gain: float = 1.4, sharpen: float = 0.6) -> np.ndarray:
    """«Магия цвета»: убрать тени и неравномерный свет, усилить текст, добавить резкость.

    1) img / background * 255 — бумага становится белой, тени исчезают,
       цвет печатей и подписей сохраняется (делим каждый канал отдельно).
    2) v = 255 - (255 - v) * text_gain — белое остаётся белым, тёмное темнеет.
    3) unsharp mask: img + sharpen * (img - blur).
    """
    bg = estimate_background(img)
    norm = cv2.divide(img, np.maximum(bg, 1), scale=255)

    lut = np.clip(255 - (255 - np.arange(256)) * text_gain, 0, 255).astype(np.uint8)
    out = cv2.LUT(norm, lut)

    sigma = max(0.8, max(img.shape[:2]) / 2000)  # ~1 px на 2000 px стороны
    blurred = cv2.GaussianBlur(out, (0, 0), sigma)
    return cv2.addWeighted(out, 1 + sharpen, blurred, -sharpen, 0)


def bw_document(img: np.ndarray, block_percent: float = 2.5, c: int = 12) -> np.ndarray:
    """Ч/Б документ через adaptiveThreshold.

    Порог считается для каждого пикселя по среднему в окне вокруг него, поэтому
    тень на половине листа не превращается в чёрное пятно.
    MEAN_C, а не GAUSSIAN_C: среднее по окну считается за O(1) на пиксель
    независимо от размера окна — на 50 Мп с окном ~200 px это секунды против минут.
    """
    gray = to_gray(img)
    block = _odd(max(gray.shape[:2]) * block_percent / 100)
    # Лёгкое сглаживание убирает зернистость бумаги, иначе фон «рябит» точками.
    gray = cv2.GaussianBlur(gray, (0, 0), max(0.5, max(gray.shape[:2]) / 3000))
    return cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                                 cv2.THRESH_BINARY, block, c)


def brightness_contrast(img: np.ndarray, brightness: int = 0, contrast: int = 0) -> np.ndarray:
    """Линейная коррекция через таблицу (LUT): 256 значений вместо миллионов пикселей.

    contrast -100..100 -> наклон 0..2 вокруг середины (127.5),
    brightness -100..100 -> сдвиг на ±127.
    """
    alpha = 1.0 + contrast / 100.0
    beta = brightness * 1.27
    x = np.arange(256, dtype=np.float64)
    lut = np.clip((x - 127.5) * alpha + 127.5 + beta, 0, 255).astype(np.uint8)
    return cv2.LUT(img, lut)


def rotate90(img: np.ndarray, quarter_turns: int) -> np.ndarray:
    """Повернуть на quarter_turns * 90° по часовой стрелке."""
    k = quarter_turns % 4
    if k == 1:
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    if k == 2:
        return cv2.rotate(img, cv2.ROTATE_180)
    if k == 3:
        return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return img
