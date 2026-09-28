"""Просмотр результата обработки + фоновый рендер превью.

PreviewRenderer отвечает на вопрос «как показывать результат вживую и не
подвесить интерфейс»:

1. Рендер (перспектива + фильтр) идёт в рабочем потоке по ПРЕВЬЮ ~1600 px,
   а не по оригиналу — это десятки миллисекунд вместо секунд.
2. Ограничение частоты: ползунок шлёт десятки событий в секунду. Запросы
   копятся, и не чаще раза в INTERVAL_MS запускается рендер ПОСЛЕДНЕГО из них.
   Таймер не перезапускается на каждом событии (как в «чистом» debounce),
   иначе при непрерывном движении ползунка превью не обновлялось бы вовсе.
3. Одновременно работает не больше одной задачи: если рендер ещё идёт,
   новый запрос просто ждёт своей очереди (хранится только самый свежий).
4. Счётчик поколений (generation): каждый запрос получает номер. Результат
   показывается, только если его номер — последний. Так устаревшая картинка
   (например, от предыдущей страницы) никогда не «перебьёт» актуальную.
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QObject, QRectF, Qt, QTimer, Signal
from PySide6.QtGui import QImage, QPainter, QPaintEvent, QPixmap
from PySide6.QtWidgets import QWidget

from core.page import Page, render

from .image_utils import ndarray_to_qimage
from .workers import Task, run_task


def render_preview_qimage(page: Page, preview: np.ndarray) -> QImage:
    """Выполняется в рабочем потоке. QImage (не QPixmap!) можно создавать вне GUI-потока."""
    return ndarray_to_qimage(render(page, preview))


class PreviewRenderer(QObject):
    rendered = Signal(QImage)
    failed = Signal(str)

    INTERVAL_MS = 100

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self._generation = 0
        self._pending: tuple[int, Page, np.ndarray] | None = None
        self._task: Task | None = None
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.setInterval(self.INTERVAL_MS)
        self._timer.timeout.connect(self._start_next)
        self.render_count = 0  # сколько результатов показано (для отладки и smoke-теста)

    def request(self, page: Page, preview: np.ndarray) -> None:
        self._generation += 1
        # clone(): GUI-поток продолжит менять page, пока рабочий поток её рендерит.
        self._pending = (self._generation, page.clone(), preview)
        if not self._timer.isActive():
            self._timer.start()

    def clear(self) -> None:
        """Забыть все запросы (например, страницу удалили)."""
        self._generation += 1
        self._pending = None

    def is_idle(self) -> bool:
        return self._pending is None and self._task is None and not self._timer.isActive()

    def _start_next(self) -> None:
        if self._pending is None or self._task is not None:
            return  # нечего делать или ждём текущую задачу (она сама запустит следующую)
        generation, page, preview = self._pending
        self._pending = None
        self._task = run_task(
            render_preview_qimage, page, preview,
            on_done=lambda img, g=generation: self._on_done(g, img),
            on_error=self._on_error)

    def _on_done(self, generation: int, image: QImage) -> None:
        self._task = None
        if generation == self._generation:
            self.render_count += 1
            self.rendered.emit(image)
        self._schedule_pending()

    def _on_error(self, message: str) -> None:
        self._task = None
        self.failed.emit(message)
        self._schedule_pending()

    def _schedule_pending(self) -> None:
        if self._pending is not None and not self._timer.isActive():
            self._timer.start()


class ResultView(QWidget):
    """Показывает обработанную страницу, вписанную в размер виджета."""

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setMinimumSize(200, 200)
        self._pixmap: QPixmap | None = None

    def set_image(self, image: QImage | None) -> None:
        self._pixmap = QPixmap.fromImage(image) if image is not None else None
        self.update()

    def has_image(self) -> bool:
        return self._pixmap is not None

    def paintEvent(self, event: QPaintEvent) -> None:
        p = QPainter(self)
        p.fillRect(self.rect(), self.palette().window())
        if self._pixmap is None:
            p.setPen(self.palette().placeholderText().color())
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "Здесь появится результат")
            return
        margin = 8
        pw, ph = self._pixmap.width(), self._pixmap.height()
        scale = min((self.width() - 2 * margin) / pw, (self.height() - 2 * margin) / ph)
        scale = max(scale, 0.01)
        w, h = pw * scale, ph * scale
        target = QRectF((self.width() - w) / 2, (self.height() - h) / 2, w, h)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        p.drawPixmap(target, self._pixmap, QRectF(self._pixmap.rect()))
