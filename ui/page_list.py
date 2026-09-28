"""Список страниц с миниатюрами: выбор, перестановка перетаскиванием, удаление.

Миниатюры — это РЕЗУЛЬТАТ обработки (с углами, фильтром и поворотом), поэтому
при изменении настроек страницы их надо перестраивать. Делается это в фоне
и с задержкой (debounce): пока пользователь тянет угол, миниатюра не
пересчитывается на каждом движении мыши — только когда он остановится.
"""
from __future__ import annotations

from PySide6.QtCore import QSize, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QIcon, QKeyEvent, QPixmap
from PySide6.QtWidgets import (QAbstractItemView, QListView, QListWidget, QListWidgetItem,
                               QPushButton, QVBoxLayout, QWidget)

from core.imageio import make_preview
from core.page import render

from .document_model import Document
from .image_utils import ndarray_to_qimage
from .workers import Task, run_task

THUMB_SIZE = 150
ID_ROLE = Qt.ItemDataRole.UserRole  # в элементе списка храним id страницы


def render_thumbnails(jobs: list[tuple]) -> list[tuple]:
    """Рабочий поток: jobs = [(id, generation, page, thumb_source), ...].

    Рендерим по маленькой копии (~300 px): фильтры в core задают размеры
    ядер относительно размера картинки, так что результат выглядит так же,
    как на большом превью, только считается мгновенно.
    """
    out = []
    for page_id, generation, page, source in jobs:
        img = make_preview(render(page, source), THUMB_SIZE)
        out.append((page_id, generation, ndarray_to_qimage(img)))
    return out


class _ThumbList(QListWidget):
    """QListWidget с клавишей Del и сообщением о перестановке после drop."""

    deletePressed = Signal()
    dropped = Signal()

    def keyPressEvent(self, event: QKeyEvent) -> None:
        if event.key() == Qt.Key.Key_Delete:
            self.deletePressed.emit()
            return
        super().keyPressEvent(event)

    def dropEvent(self, event) -> None:
        super().dropEvent(event)
        self.dropped.emit()


class PageList(QWidget):
    pageSelected = Signal(int)     # id страницы (0 — ничего не выбрано)
    orderChanged = Signal(list)    # id страниц в новом порядке
    deleteRequested = Signal(list)  # id выделенных страниц

    THUMB_DELAY_MS = 300

    def __init__(self, document: Document, parent: QWidget | None = None):
        super().__init__(parent)
        self._doc = document
        self._icons: dict[int, QIcon] = {}
        self._generation: dict[int, int] = {}  # «поколение» настроек страницы
        self._dirty: set[int] = set()
        self._thumb_task: Task | None = None
        self._rebuilding = False

        self.list = _ThumbList()
        self.list.setViewMode(QListView.ViewMode.IconMode)
        # IconMode по умолчанию включает «свободное» перемещение (элементы просто
        # сдвигаются по экрану). Static + InternalMove = настоящая перестановка
        # строк модели, которую мы потом переносим в Document.
        self.list.setMovement(QListView.Movement.Static)
        self.list.setDragDropMode(QAbstractItemView.DragDropMode.InternalMove)
        self.list.setDefaultDropAction(Qt.DropAction.MoveAction)
        self.list.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.list.setIconSize(QSize(THUMB_SIZE, THUMB_SIZE))
        self.list.setGridSize(QSize(THUMB_SIZE + 20, THUMB_SIZE + 30))
        self.list.setResizeMode(QListView.ResizeMode.Adjust)
        self.list.setWrapping(True)
        self.list.setUniformItemSizes(True)
        self.list.setMinimumWidth(THUMB_SIZE + 40)

        self.list.currentItemChanged.connect(self._on_current_changed)
        self.list.deletePressed.connect(self._request_delete)
        # rowsMoved — модель переставила строки (drag&drop); dropped — страховка.
        self.list.model().rowsMoved.connect(self._schedule_order_check)
        self.list.dropped.connect(self._schedule_order_check)

        self.delete_button = QPushButton("Удалить")
        self.delete_button.setToolTip("Удалить выделенные страницы (Del)")
        self.delete_button.clicked.connect(self._request_delete)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(self.list, 1)
        layout.addWidget(self.delete_button)

        self._thumb_timer = QTimer(self)
        self._thumb_timer.setSingleShot(True)
        self._thumb_timer.setInterval(self.THUMB_DELAY_MS)
        self._thumb_timer.timeout.connect(self._start_thumbnails)

        document.structureChanged.connect(self._rebuild)
        document.pageChanged.connect(self._mark_dirty)
        self._update_buttons()

    # --- публичное ---
    def current_id(self) -> int:
        item = self.list.currentItem()
        return int(item.data(ID_ROLE)) if item else 0

    def select(self, page_id: int) -> None:
        for row in range(self.list.count()):
            item = self.list.item(row)
            if item.data(ID_ROLE) == page_id:
                self.list.setCurrentItem(item)  # вызовет pageSelected
                return

    def selected_ids(self) -> list[int]:
        return [int(i.data(ID_ROLE)) for i in self.list.selectedItems()]

    def thumbnails_idle(self) -> bool:
        return not self._dirty and self._thumb_task is None and not self._thumb_timer.isActive()

    def has_thumbnail(self, page_id: int) -> bool:
        return page_id in self._icons

    # --- синхронизация с Document ---
    def _widget_ids(self) -> list[int]:
        return [int(self.list.item(r).data(ID_ROLE)) for r in range(self.list.count())]

    def _rebuild(self) -> None:
        doc_ids = self._doc.ids()
        if self._widget_ids() != doc_ids:
            current = self.current_id()
            self._rebuilding = True
            self.list.blockSignals(True)  # не слать pageSelected на каждый clear/add
            try:
                self.list.clear()
                for page_id in doc_ids:
                    item = QListWidgetItem()
                    item.setData(ID_ROLE, page_id)
                    item.setIcon(self._icons.get(page_id) or self._placeholder_icon())
                    self.list.addItem(item)
                    if page_id not in self._icons:
                        self._mark_dirty(page_id)
                if current in doc_ids:
                    self.list.setCurrentRow(doc_ids.index(current))
            finally:
                self.list.blockSignals(False)
                self._rebuilding = False
        # Забываем миниатюры удалённых страниц.
        for gone in set(self._icons) - set(doc_ids):
            self._icons.pop(gone, None)
        self._renumber()
        self._update_buttons()

    def _renumber(self) -> None:
        for row in range(self.list.count()):
            self.list.item(row).setText(str(row + 1))

    def _schedule_order_check(self, *_args) -> None:
        # Откладываем до следующего круга цикла событий: сигнал приходит из
        # середины dropEvent, и пересобирать список прямо там небезопасно.
        if not self._rebuilding:
            QTimer.singleShot(0, self._check_order)

    def _check_order(self) -> None:
        ids = self._widget_ids()
        self._renumber()
        if ids != self._doc.ids():
            self.orderChanged.emit(ids)

    # --- выбор и удаление ---
    def _on_current_changed(self, current: QListWidgetItem | None, _previous) -> None:
        self.pageSelected.emit(int(current.data(ID_ROLE)) if current else 0)
        self._update_buttons()

    def _request_delete(self) -> None:
        ids = self.selected_ids() or ([self.current_id()] if self.current_id() else [])
        if ids:
            self.deleteRequested.emit(ids)

    def _update_buttons(self) -> None:
        self.delete_button.setEnabled(self.list.count() > 0)

    # --- миниатюры ---
    def _placeholder_icon(self) -> QIcon:
        pm = QPixmap(THUMB_SIZE, THUMB_SIZE)
        pm.fill(QColor(200, 200, 200))
        return QIcon(pm)

    def _mark_dirty(self, page_id: int) -> None:
        self._generation[page_id] = self._generation.get(page_id, 0) + 1
        self._dirty.add(page_id)
        self._thumb_timer.start()  # перезапуск таймера = debounce

    def _start_thumbnails(self) -> None:
        if self._thumb_task is not None:
            return  # закончится текущая пачка — запустим следующую
        jobs = []
        for page_id in list(self._dirty):
            entry = self._doc.entry(page_id)
            if entry is not None:
                jobs.append((page_id, self._generation[page_id], entry.page.clone(),
                             entry.thumb_source))
        self._dirty.clear()
        if jobs:
            self._thumb_task = run_task(render_thumbnails, jobs,
                                        on_done=self._on_thumbnails, on_error=self._on_thumb_error)

    def _on_thumbnails(self, results: list[tuple]) -> None:
        self._thumb_task = None
        for page_id, generation, image in results:
            if self._generation.get(page_id) != generation or self._doc.entry(page_id) is None:
                continue  # настройки успели измениться — эта миниатюра устарела
            icon = QIcon(QPixmap.fromImage(image))
            self._icons[page_id] = icon
            for row in range(self.list.count()):
                if self.list.item(row).data(ID_ROLE) == page_id:
                    self.list.item(row).setIcon(icon)
        if self._dirty:
            self._thumb_timer.start()

    def _on_thumb_error(self, message: str) -> None:
        self._thumb_task = None
        print("Ошибка построения миниатюры:", message)
        if self._dirty:
            self._thumb_timer.start()
