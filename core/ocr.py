"""Распознавание текста через Tesseract (обёртка pytesseract).

Tesseract — отдельная программа, pip её не ставит. Поэтому модуль сначала
ищет tesseract.exe (PATH и стандартные папки установки Windows) и, если не
нашёл, выдаёт понятную инструкцию вместо трейсбэка.

Функции можно вызывать из рабочего потока: pytesseract на каждый вызов
запускает отдельный процесс со своими временными файлами. Единственное
глобальное состояние — путь pytesseract.pytesseract.tesseract_cmd.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pytesseract
from PIL import Image

DEFAULT_LANG = "rus+eng"
REQUIRED_LANGS = ("rus", "eng")

# --psm 3 — полностью автоматическая разметка страницы (колонки, абзацы).
# Для сканов документов это самый надёжный режим.
DEFAULT_PSM = 3

INSTALL_HINT = (
    "Как установить Tesseract OCR:\n"
    "1. Скачайте установщик сборки UB Mannheim:\n"
    "   https://github.com/UB-Mannheim/tesseract/wiki\n"
    "2. При установке в разделе «Additional language data» отметьте «Russian»\n"
    "   (английский ставится всегда).\n"
    "3. Оставьте путь по умолчанию: C:\\Program Files\\Tesseract-OCR\n"
    "   Если ставите в другую папку — добавьте её в переменную PATH.\n"
    "4. Перезапустите программу."
)


class TesseractNotFoundError(Exception):
    """Tesseract не установлен (или не хватает языков). Текст содержит инструкцию."""

    def __init__(self, message: str | None = None):
        super().__init__(message or f"Tesseract OCR не найден.\n\n{INSTALL_HINT}")


@dataclass(frozen=True)
class TesseractStatus:
    ok: bool
    path: str | None
    version: str | None
    missing_langs: tuple[str, ...]
    message: str


def bundled_tesseract_dir() -> Path:
    """Папка встроенного Tesseract: рядом с exe в сборке, vendor/ — при запуске из исходников."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "tesseract"
    return Path(__file__).resolve().parents[1] / "vendor" / "tesseract"


def _use_bundled_tessdata(exe: str | Path) -> None:
    """Переносимой копии Tesseract нужно явно указать папку языков: путь по
    умолчанию зашит при компиляции и на чужой машине не существует."""
    exe = Path(exe)
    if exe.parent == bundled_tesseract_dir():
        os.environ["TESSDATA_PREFIX"] = str(exe.parent / "tessdata")


def _candidate_paths() -> list[Path]:
    """Встроенная копия, затем стандартные места установки (UB Mannheim ставит в Program Files)."""
    paths = [bundled_tesseract_dir() / "tesseract.exe",
             Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe"),
             Path(r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe")]
    local = os.environ.get("LOCALAPPDATA")
    if local:  # установка «только для меня»
        paths.append(Path(local) / "Programs" / "Tesseract-OCR" / "tesseract.exe")
    return paths


def find_tesseract() -> str | None:
    """Найти tesseract.exe и прописать его в pytesseract. None — если не найден."""
    # Встроенная копия — первой: в ней точно есть rus+eng, а у системной может не быть.
    configured = pytesseract.pytesseract.tesseract_cmd
    candidates: list[str | Path | None] = [
        bundled_tesseract_dir() / "tesseract.exe",
        configured if configured and Path(configured).is_file() else None,
        shutil.which("tesseract"),
        *_candidate_paths()[1:],
    ]
    for c in candidates:
        if c and Path(c).is_file():
            _use_bundled_tessdata(c)
            pytesseract.pytesseract.tesseract_cmd = str(c)
            return str(c)
    return None


def check_tesseract(langs: tuple[str, ...] | list[str] = REQUIRED_LANGS) -> TesseractStatus:
    """Проверить установку и наличие языков. Никогда не бросает исключений:
    результат предназначен для показа пользователю."""
    path = find_tesseract()
    if path is None:
        return TesseractStatus(False, None, None, tuple(langs),
                               f"Tesseract OCR не найден.\n\n{INSTALL_HINT}")
    try:
        version = str(pytesseract.get_tesseract_version())
        installed = _list_langs(path)
    except Exception as e:  # битая установка, нет прав на запуск и т.п.
        return TesseractStatus(False, path, None, tuple(langs),
                               f"Tesseract найден ({path}), но не запускается: {e}\n\n{INSTALL_HINT}")
    missing = tuple(lang for lang in langs if lang not in installed)
    if missing:
        return TesseractStatus(False, path, version, missing,
                               f"Tesseract {version} найден ({path}), но нет языковых данных: "
                               f"{', '.join(missing)}.\n\n{INSTALL_HINT}")
    return TesseractStatus(True, path, version, (), f"Tesseract {version}: {path}")


def _list_langs(exe: str) -> set[str]:
    """Установленные языки (`tesseract --list-langs`).

    Не pytesseract.get_languages: он декодирует вывод как UTF-8, а Tesseract
    печатает путь к tessdata в кодировке Windows — на пути с кириллицей падает.
    Первая строка вывода — этот путь, она нам не нужна.
    """
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # без мелькания консоли в GUI
    out = subprocess.run([exe, "--list-langs"], capture_output=True, timeout=30,
                         creationflags=flags, check=True).stdout
    lines = out.decode("utf-8", errors="replace").splitlines()[1:]
    return {line.strip() for line in lines if line.strip()}


def _require_tesseract() -> None:
    if find_tesseract() is None:
        raise TesseractNotFoundError()


def _to_pil(img: np.ndarray) -> Image.Image:
    """BGR (OpenCV) -> RGB для Pillow; одноканальное — как есть (режим L)."""
    if img.ndim == 2:
        return Image.fromarray(img)
    return Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))


def _config(dpi: int) -> str:
    # Без --dpi Tesseract пишет «Invalid resolution 0 dpi» и гадает размер шрифта;
    # в PDF-режиме от DPI зависит ещё и физический размер страницы.
    return f"--psm {DEFAULT_PSM} --dpi {dpi}"


def _auto_dpi(img: np.ndarray) -> int:
    # Импорт внутри функции: export.py сам импортирует ocr, и импорт на уровне
    # модуля дал бы циклическую зависимость. Формула DPI живёт в одном месте.
    from .export import auto_dpi
    return auto_dpi(img)


def image_to_text(img: np.ndarray, lang: str = DEFAULT_LANG) -> str:
    """Распознать текст на изображении (BGR или grayscale uint8)."""
    _require_tesseract()
    try:
        return pytesseract.image_to_string(_to_pil(img), lang=lang, config=_config(_auto_dpi(img)))
    except pytesseract.TesseractNotFoundError as e:  # exe удалили между проверкой и запуском
        raise TesseractNotFoundError() from e


def image_to_pdf_page(img: np.ndarray, lang: str = DEFAULT_LANG, dpi: int | None = None) -> bytes:
    """Одностраничный PDF: картинка + невидимый слой текста (можно искать и копировать).

    Разметку текстового слоя строит сам Tesseract — он знает координаты каждого
    слова, так что текст ложится точно поверх изображения.
    """
    _require_tesseract()
    dpi = dpi or _auto_dpi(img)
    # Отдаём Tesseract уже сжатый файл, а не PIL-картинку: из PIL pytesseract
    # сохранил бы PNG, и Tesseract встроил бы в PDF несжатый растр (цветная
    # страница 50 Мп — десятки МБ). JPEG он встраивает как есть, 1-битный PNG — в G4.
    from .export import encode_page
    data = encode_page(img)
    suffix = ".png" if data.startswith(b"\x89PNG") else ".jpg"
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / f"page{suffix}"
        src.write_bytes(data)
        try:
            return pytesseract.image_to_pdf_or_hocr(str(src), lang=lang, config=_config(dpi),
                                                    extension="pdf")
        except pytesseract.TesseractNotFoundError as e:
            raise TesseractNotFoundError() from e
