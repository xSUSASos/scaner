"""Перевод numpy-массивов (формат OpenCV) в QImage/QPixmap.

Тонкости:
* bytesPerLine (длина строки в байтах) передаём явно из strides: у массива-среза
  строка может быть длиннее, чем width * channels, и без этого картинка «поедет».
* QImage(data, ...) НЕ копирует данные, а ссылается на память numpy. Если массив
  удалит сборщик мусора, QImage будет читать освобождённую память. Поэтому сразу
  делаем .copy() — после этого QImage владеет своими пикселями.
* QImage можно создавать в любом потоке, а QPixmap — только в GUI-потоке
  (он живёт в памяти видеосистемы). Поэтому рабочие потоки возвращают QImage.
"""
from __future__ import annotations

import numpy as np
from PySide6.QtGui import QImage, QPixmap


def ndarray_to_qimage(img: np.ndarray) -> QImage:
    """BGR (h, w, 3), BGRA (h, w, 4) или grayscale (h, w) uint8 -> QImage."""
    if img.dtype != np.uint8:
        raise ValueError(f"Ожидался uint8, получено {img.dtype}")
    # ascontiguousarray: у повёрнутых/обрезанных массивов строки могут идти не подряд.
    img = np.ascontiguousarray(img)
    h, w = img.shape[:2]
    if img.ndim == 2:
        fmt = QImage.Format.Format_Grayscale8
    elif img.shape[2] == 3:
        fmt = QImage.Format.Format_BGR888  # порядок каналов OpenCV — без cvtColor
    elif img.shape[2] == 4:
        fmt = QImage.Format.Format_ARGB32  # в памяти little-endian это как раз B,G,R,A
    else:
        raise ValueError(f"Неподдерживаемая форма массива: {img.shape}")
    qimg = QImage(img.data, w, h, img.strides[0], fmt)
    return qimg.copy()


def ndarray_to_qpixmap(img: np.ndarray) -> QPixmap:
    """Только для GUI-потока."""
    return QPixmap.fromImage(ndarray_to_qimage(img))
