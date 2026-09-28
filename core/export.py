"""Экспорт страниц: PDF, PDF с текстовым слоем, отдельные картинки, .txt.

Страницы приходят ИТЕРАТОРОМ (обычно генератором render_full по страницам).
Каждую сразу кодируем в сжатые байты и отпускаем: 20 страниц по 50 Мп в
виде массивов — это ~3 ГБ памяти, а в виде JPEG — десятки мегабайт.

Все файлы пишутся через open(path, "wb") / core.imageio — пути с кириллицей работают.
"""
from __future__ import annotations

import io
from collections.abc import Callable, Iterable
from pathlib import Path

import cv2
import img2pdf
import numpy as np
from pypdf import PdfReader, PdfWriter

from . import ocr
from .imageio import save_image

A4_LONG_SIDE_INCH = 297 / 25.4
MIN_DPI, MAX_DPI = 72, 1200

ProgressFn = Callable[[int, int], None]  # (сделано, всего); всего = 0, если неизвестно


def auto_dpi(img: np.ndarray) -> int:
    """DPI, при котором длинная сторона картинки = длинной стороне A4 (297 мм).

    У снимка с телефона нет «настоящего» DPI (в EXIF обычно 72 или ничего),
    а PDF нужен физический размер страницы. Считаем, что документ — A4:
    тогда при печати и просмотре масштаб будет естественным при любом разрешении.
    """
    h, w = img.shape[:2]
    return dpi_for_size(w, h)


def dpi_for_size(width_px: int, height_px: int) -> int:
    """То же, что auto_dpi, но по размерам (без самой картинки)."""
    dpi = round(max(width_px, height_px) / A4_LONG_SIDE_INCH)
    return int(min(max(dpi, MIN_DPI), MAX_DPI))


def _total(images: Iterable, total: int | None) -> int:
    if total is not None:
        return total
    try:
        return len(images)  # type: ignore[arg-type]
    except TypeError:  # генератор — длина неизвестна
        return 0


def is_binary(img: np.ndarray) -> bool:
    """Только 0 и 255 (результат фильтра «Ч/Б документ»)."""
    # inRange — быстрый проход на C; numpy-выражение создало бы временные массивы на 50 Мп.
    return img.ndim == 2 and cv2.countNonZero(cv2.inRange(img, 1, 254)) == 0


def encode_page(img: np.ndarray, jpeg_quality: int = 90) -> bytes:
    """Картинка -> байты для вставки в PDF.

    Ч/Б -> 1-битный PNG: без потерь и в разы меньше JPEG (у JPEG на резких
    чёрно-белых краях появляются «комары» и файл раздувается).
    Цвет и оттенки серого -> JPEG: для фото это на порядок компактнее PNG.
    img2pdf вставляет оба формата как есть, без перекодирования.
    """
    if is_binary(img):
        ok, buf = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_BILEVEL, 1])
    else:
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, jpeg_quality])
    if not ok:
        raise OSError("Не удалось закодировать страницу")
    return buf.tobytes()


def _a4_layout(imgwidthpx: int, imgheightpx: int, ndpi: tuple[float, float]):
    """layout_fun для img2pdf: размер страницы = пиксели / auto_dpi.

    DPI из заголовка файла (ndpi) игнорируем — OpenCV его не записывает, и img2pdf
    подставил бы 96 dpi: 50-Мп снимок стал бы страницей размером с плакат.
    """
    dpi = dpi_for_size(imgwidthpx, imgheightpx)
    w_pt, h_pt = imgwidthpx / dpi * 72, imgheightpx / dpi * 72  # 1 дюйм = 72 pt
    return w_pt, h_pt, w_pt, h_pt


def export_pdf(images: Iterable[np.ndarray], path: str | Path, total: int | None = None,
               jpeg_quality: int = 90, progress: ProgressFn | None = None) -> Path:
    """Многостраничный PDF из картинок (без распознавания текста)."""
    path = Path(path)
    total = _total(images, total)
    pages: list[bytes] = []
    for i, img in enumerate(images, 1):
        pages.append(encode_page(img, jpeg_quality))
        # Отпускаем массив до запроса следующей страницы: иначе, пока генератор
        # рендерит новую, в памяти висели бы сразу две 50-Мп картинки.
        del img
        if progress:
            progress(i, total)
    if not pages:
        raise ValueError("Нет страниц для экспорта")
    data = img2pdf.convert(pages, layout_fun=_a4_layout)
    with open(path, "wb") as f:
        f.write(data)
    return path


def export_images(images: Iterable[np.ndarray], folder: str | Path, base_name: str,
                  fmt: str = "jpg", total: int | None = None, jpeg_quality: int = 95,
                  progress: ProgressFn | None = None) -> list[Path]:
    """Сохранить страницы как base_name_001.jpg, base_name_002.jpg, ..."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    ext = fmt.lower().lstrip(".")
    total = _total(images, total)
    result: list[Path] = []
    for i, img in enumerate(images, 1):
        out = folder / f"{base_name}_{i:03d}.{ext}"
        save_image(out, img, jpeg_quality)
        result.append(out)
        if progress:
            progress(i, total)
    return result


def export_searchable_pdf(images: Iterable[np.ndarray], path: str | Path,
                          lang: str = ocr.DEFAULT_LANG, total: int | None = None,
                          progress: ProgressFn | None = None) -> Path:
    """PDF, в котором можно искать и копировать текст.

    Tesseract умеет выдавать только одностраничный PDF на картинку, поэтому
    склеиваем страницы через pypdf. Tesseract проверяем ДО обработки: иначе
    пользователь ждал бы рендеринга первой 50-Мп страницы, чтобы увидеть ошибку.
    """
    status = ocr.check_tesseract(tuple(lang.split("+")))
    if not status.ok:
        raise ocr.TesseractNotFoundError(status.message)

    path = Path(path)
    total = _total(images, total)
    writer = PdfWriter()
    for i, img in enumerate(images, 1):
        page_pdf = ocr.image_to_pdf_page(img, lang, auto_dpi(img))
        del img
        writer.append(PdfReader(io.BytesIO(page_pdf)))
        if progress:
            progress(i, total)
    if not writer.pages:
        raise ValueError("Нет страниц для экспорта")
    with open(path, "wb") as f:
        writer.write(f)
    return path


def save_text(text: str, path: str | Path) -> Path:
    """Сохранить распознанный текст в UTF-8 (без BOM)."""
    path = Path(path)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    return path
