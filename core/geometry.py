"""Геометрия: порядок углов, пересчёт координат, выравнивание перспективы.

Углы документа везде хранятся в НОРМИРОВАННЫХ координатах [0..1] (x — доля
ширины, y — доля высоты). Так одни и те же углы подходят и к превью, и к
оригиналу на 50 Мп — пересчёт делается только в момент применения.
"""
from __future__ import annotations

import cv2
import numpy as np


def full_frame_corners() -> np.ndarray:
    """Рамка по краям изображения (TL, TR, BR, BL)."""
    return np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float64)


def order_points(pts: np.ndarray) -> np.ndarray:
    """Упорядочить 4 точки как TL, TR, BR, BL.

    Классический трюк «TL = min(x+y), BR = max(x+y)» ломается, когда лист
    повёрнут примерно на 45°. Поэтому сортируем по углу вокруг центра масс:
    в координатах экрана (y вниз) рост угла atan2 = обход по часовой стрелке.
    Затем циклически сдвигаем так, чтобы первой была точка с минимальной x+y.
    """
    pts = np.asarray(pts, dtype=np.float64).reshape(4, 2)
    center = pts.mean(axis=0)
    angles = np.arctan2(pts[:, 1] - center[1], pts[:, 0] - center[0])
    clockwise = pts[np.argsort(angles)]
    start = int(np.argmin(clockwise.sum(axis=1)))
    return np.roll(clockwise, -start, axis=0)


def to_pixels(corners_norm: np.ndarray, shape: tuple[int, ...]) -> np.ndarray:
    """Нормированные углы -> пиксели для изображения формы shape (h, w, ...)."""
    h, w = shape[:2]
    return np.asarray(corners_norm, dtype=np.float64) * [w - 1, h - 1]


def to_normalized(corners_px: np.ndarray, shape: tuple[int, ...]) -> np.ndarray:
    h, w = shape[:2]
    return np.asarray(corners_px, dtype=np.float64) / [max(w - 1, 1), max(h - 1, 1)]


def output_size(corners_px: np.ndarray) -> tuple[int, int]:
    """Размер результата (w, h) по реальным длинам сторон четырёхугольника.

    Берём максимум из пары противоположных сторон: дальняя от камеры сторона
    выглядит короче, и по максимуму мы не теряем разрешение.
    +1: длина — это расстояние между центрами крайних пикселей, а пикселей на 1 больше.

    Ограничение метода: при сильном наклоне камеры истинные пропорции листа
    так не восстановить (для этого нужно знать фокусное расстояние).
    """
    tl, tr, br, bl = corners_px
    width = max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))
    height = max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))
    return max(1, round(width) + 1), max(1, round(height) + 1)


def warp_document(img: np.ndarray, corners_norm: np.ndarray,
                  interpolation: int = cv2.INTER_LINEAR) -> np.ndarray:
    """Вырезать документ и развернуть его в прямоугольник.

    getPerspectiveTransform по 4 парам точек даёт матрицу гомографии 3x3;
    warpPerspective для каждого пикселя результата берёт цвет из исходника.
    """
    src = order_points(to_pixels(corners_norm, img.shape))
    w, h = output_size(src)
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(src.astype(np.float32), dst)
    return cv2.warpPerspective(img, matrix, (w, h), flags=interpolation,
                               borderMode=cv2.BORDER_REPLICATE)
