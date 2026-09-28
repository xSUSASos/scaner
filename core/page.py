"""Страница документа = рецепт обработки, а не готовая картинка.

Храним путь к исходнику и параметры (углы, фильтр, поворот). Результат всегда
строится заново функцией render(): поэтому страницу можно сколько угодно
раз перенастраивать без накопления потерь, а превью и финальный экспорт
проходят один и тот же конвейер (превью — на уменьшенной копии).
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .detect import detect_document
from .filters import FilterSettings, apply_filter, rotate90
from .geometry import full_frame_corners, warp_document
from .imageio import load_image, make_preview


@dataclass
class Page:
    source_path: Path
    corners: np.ndarray = field(default_factory=full_frame_corners)  # нормированные TL,TR,BR,BL
    filter: FilterSettings = field(default_factory=FilterSettings)
    rotation: int = 0          # четверти оборота по часовой стрелке
    auto_detected: bool = False

    def clone(self) -> "Page":
        return copy.deepcopy(self)


def render(page: Page, image: np.ndarray) -> np.ndarray:
    """Полный конвейер: перспектива -> фильтр -> яркость/контраст -> поворот.

    image — исходник (оригинал или его превью; углы нормированы, подходят к обоим).
    """
    warped = warp_document(image, page.corners)
    out = apply_filter(warped, page.filter)
    return rotate90(out, page.rotation)


def render_full(page: Page) -> np.ndarray:
    """Финальная обработка на оригинале (читаем файл заново, чтобы не держать
    в памяти десятки 50-Мп исходников)."""
    return render(page, load_image(page.source_path))


def new_page(path: str | Path, preview: np.ndarray | None = None) -> Page:
    """Создать страницу и сразу найти документ (детекция идёт по превью)."""
    path = Path(path)
    if preview is None:
        preview = make_preview(load_image(path))
    result = detect_document(preview)
    return Page(source_path=path, corners=result.corners, auto_detected=result.found)
