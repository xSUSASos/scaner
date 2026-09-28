"""Загрузка и сохранение изображений.

Почему не cv2.imread/imwrite: на Windows они не открывают пути с кириллицей.
Поэтому файл читается в память через np.fromfile и декодируется cv2.imdecode,
а сохранение — cv2.imencode + ndarray.tofile.

Все функции возвращают BGR uint8 (как принято в OpenCV).
"""
from __future__ import annotations

import io
from pathlib import Path

import cv2
import numpy as np
import pillow_heif
from PIL import Image, ImageOps

pillow_heif.register_heif_opener()

# Pillow по умолчанию ругается на картинки > ~89 Мп; нам нужны 50 Мп с запасом.
Image.MAX_IMAGE_PIXELS = 250_000_000

HEIF_EXTS = {".heic", ".heif"}
SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff", ".webp"} | HEIF_EXTS
SAVE_EXTS = {".jpg", ".jpeg", ".png"}

# Длинная сторона превью. Детекция и живые фильтры работают на нём, финал — на оригинале.
PREVIEW_MAX_SIDE = 1600

EXIF_ORIENTATION_TAG = 0x0112


class ImageLoadError(Exception):
    """Файл не найден, не читается или формат не поддерживается."""


def load_image(path: str | Path) -> np.ndarray:
    """Прочитать изображение как BGR uint8 с учётом EXIF-ориентации."""
    path = Path(path)
    try:
        data = np.fromfile(path, dtype=np.uint8)
    except OSError as e:
        raise ImageLoadError(f"Не удалось прочитать файл: {path}\n{e}") from e
    if data.size == 0:
        raise ImageLoadError(f"Пустой файл: {path}")

    if path.suffix.lower() in HEIF_EXTS:
        return _decode_with_pillow(data, path)

    # IGNORE_ORIENTATION: поворачиваем сами, чтобы поведение было явным и одинаковым
    # для всех форматов (в т.ч. в Pillow-ветке).
    img = cv2.imdecode(data, cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION)
    if img is None:
        return _decode_with_pillow(data, path)
    return apply_exif_orientation(img, read_exif_orientation(data))


def _decode_with_pillow(data: np.ndarray, path: Path) -> np.ndarray:
    try:
        with Image.open(io.BytesIO(data.tobytes())) as im:
            im = ImageOps.exif_transpose(im)
            rgb = np.asarray(im.convert("RGB"))
    except Exception as e:  # Pillow бросает разные типы исключений
        raise ImageLoadError(f"Неподдерживаемый или повреждённый файл: {path}\n{e}") from e
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def read_exif_orientation(data: np.ndarray | bytes) -> int:
    """Значение EXIF Orientation (1..8); 1 — если тега нет."""
    try:
        with Image.open(io.BytesIO(bytes(data))) as im:  # читает только заголовок
            value = int(im.getexif().get(EXIF_ORIENTATION_TAG, 1))
    except Exception:
        return 1
    return value if 1 <= value <= 8 else 1


def apply_exif_orientation(img: np.ndarray, orientation: int) -> np.ndarray:
    """Привести пиксели к «правильной» ориентации (как ImageOps.exif_transpose)."""
    if orientation == 2:
        return cv2.flip(img, 1)
    if orientation == 3:
        return cv2.rotate(img, cv2.ROTATE_180)
    if orientation == 4:
        return cv2.flip(img, 0)
    if orientation == 5:
        return cv2.transpose(img)
    if orientation == 6:
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    if orientation == 7:
        return cv2.flip(cv2.transpose(img), -1)
    if orientation == 8:
        return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return img


def save_image(path: str | Path, img: np.ndarray, jpeg_quality: int = 95) -> None:
    """Сохранить BGR/grayscale в JPG или PNG (путь может содержать кириллицу)."""
    path = Path(path)
    ext = path.suffix.lower()
    if ext not in SAVE_EXTS:
        raise ValueError(f"Формат сохранения не поддерживается: {ext}")
    params = [cv2.IMWRITE_JPEG_QUALITY, jpeg_quality] if ext in {".jpg", ".jpeg"} else [
        cv2.IMWRITE_PNG_COMPRESSION, 3]
    ok, buf = cv2.imencode(ext, img, params)
    if not ok:
        raise OSError(f"Не удалось закодировать изображение в {ext}")
    buf.tofile(path)


def make_preview(img: np.ndarray, max_side: int = PREVIEW_MAX_SIDE) -> np.ndarray:
    """Уменьшенная копия для интерфейса и детекции. Маленькие картинки не увеличиваем."""
    h, w = img.shape[:2]
    scale = max_side / max(h, w)
    if scale >= 1.0:
        return img.copy()
    size = (max(1, round(w * scale)), max(1, round(h * scale)))
    # INTER_AREA — правильная интерполяция для уменьшения (усредняет, без муара).
    return cv2.resize(img, size, interpolation=cv2.INTER_AREA)


def is_supported(path: str | Path) -> bool:
    return Path(path).suffix.lower() in SUPPORTED_EXTS
