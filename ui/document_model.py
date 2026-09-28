"""Модель документа: упорядоченный список страниц + их превью.

Кто чем владеет:
* Page (core.page) — «рецепт» обработки: путь к файлу, углы, фильтр, поворот.
* preview — уменьшенная копия исходника (~1600 px). Оригиналы (до 50 Мп)
  в памяти НЕ храним: при экспорте render_full() читает файл заново.
* thumb_source — совсем маленькая копия (~300 px) для миниатюр в списке:
  миниатюру дешевле строить по ней, чем по превью.

Виджеты не хранят страниц у себя — они читают Document и подписываются на
его сигналы. Так порядок страниц существует ровно в одном месте.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PySide6.QtCore import QObject, Signal

from core.imageio import load_image, make_preview
from core.page import Page, new_page

THUMB_SOURCE_SIDE = 300


@dataclass
class PageEntry:
    id: int                   # стабильный идентификатор (номер страницы меняется при перестановке)
    page: Page
    preview: np.ndarray       # только читаем, никогда не меняем «на месте» — поэтому
    thumb_source: np.ndarray  # массивы можно без копирования отдавать в рабочие потоки


@dataclass
class LoadedPage:
    """Результат фоновой загрузки одного файла."""
    page: Page
    preview: np.ndarray
    thumb_source: np.ndarray


def load_page(path: str | Path) -> LoadedPage:
    """Выполняется в рабочем потоке: чтение файла, превью, поиск документа."""
    original = load_image(path)
    preview = make_preview(original)
    del original  # 50-Мп массив больше не нужен — отпускаем память сразу
    page = new_page(path, preview)  # детекция идёт по превью, это быстро
    return LoadedPage(page, preview, make_preview(preview, THUMB_SOURCE_SIDE))


class Document(QObject):
    structureChanged = Signal()  # страницы добавлены/удалены/переставлены
    pageChanged = Signal(int)    # у страницы id изменились настройки

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self._entries: list[PageEntry] = []
        self._next_id = 1

    def __len__(self) -> int:
        return len(self._entries)

    def entries(self) -> list[PageEntry]:
        return list(self._entries)

    def ids(self) -> list[int]:
        return [e.id for e in self._entries]

    def entry(self, page_id: int) -> PageEntry | None:
        return next((e for e in self._entries if e.id == page_id), None)

    def index_of(self, page_id: int) -> int:
        return next((i for i, e in enumerate(self._entries) if e.id == page_id), -1)

    def add(self, loaded: LoadedPage) -> int:
        entry = PageEntry(self._next_id, loaded.page, loaded.preview, loaded.thumb_source)
        self._next_id += 1
        self._entries.append(entry)
        self.structureChanged.emit()
        return entry.id

    def remove(self, page_ids: list[int]) -> None:
        doomed = set(page_ids)
        before = len(self._entries)
        self._entries = [e for e in self._entries if e.id not in doomed]
        if len(self._entries) != before:
            self.structureChanged.emit()

    def set_order(self, page_ids: list[int]) -> None:
        """Переставить страницы. page_ids — те же id в новом порядке."""
        if page_ids == self.ids():
            return
        by_id = {e.id: e for e in self._entries}
        if sorted(page_ids) != sorted(by_id):
            raise ValueError("Новый порядок должен содержать ровно те же страницы")
        self._entries = [by_id[i] for i in page_ids]
        self.structureChanged.emit()

    def notify_page_changed(self, page_id: int) -> None:
        """Сообщить, что рецепт страницы изменён (углы, фильтр, поворот)."""
        self.pageChanged.emit(page_id)

    def pages_snapshot(self) -> list[Page]:
        """Копии страниц для фоновой задачи: пока экспорт идёт, пользователь может
        менять настройки в GUI-потоке — рабочий поток не должен видеть эти изменения
        «наполовину»."""
        return [e.page.clone() for e in self._entries]
