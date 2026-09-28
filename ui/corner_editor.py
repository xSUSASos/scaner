"""Редактор углов документа: картинка, четырёхугольник и 4 перетаскиваемых угла.

Почему свой QWidget с paintEvent, а не QGraphicsView: элементов всего пять
(картинка, контур, 4 маркера) — проще один раз нарисовать всё вручную, чем
разбираться со сценой, трансформациями и флагами элементов.

Координаты углов хранятся НОРМИРОВАННЫМИ [0..1] (как в core.page.Page):
размер виджета меняется, а углы при этом пересчитывать не нужно — перевод
в экранные точки делается при каждой отрисовке.
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPointF, QRectF, QSize, Qt, Signal
from PySide6.QtGui import (QBrush, QColor, QImage, QMouseEvent, QPainter, QPainterPath,
                           QPaintEvent, QPen, QPixmap, QPolygonF)
from PySide6.QtWidgets import QHBoxLayout, QPushButton, QVBoxLayout, QWidget

from core.detect import detect_document
from core.geometry import full_frame_corners, order_points

from .image_utils import ndarray_to_qimage

ACCENT = QColor(0, 150, 255)


class CornerCanvas(QWidget):
    """Сама «холст»-область: рисование и перетаскивание углов."""

    cornersChanged = Signal(object)  # np.ndarray (4, 2), нормированные

    HANDLE_R = 9        # радиус маркера угла, px экрана
    HIT_R = 24          # на каком расстоянии от маркера можно его «схватить»
    MAG_R = 70          # радиус лупы
    MAG_ZOOM = 3.0      # увеличение лупы относительно того, что видно на экране
    MAG_GAP = 40        # отступ лупы от пальца/курсора

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setMinimumSize(200, 200)
        self.setMouseTracking(True)  # чтобы менять курсор при наведении на угол
        self._pixmap: QPixmap | None = None
        self._scaled: QPixmap | None = None  # кэш картинки под текущий размер виджета
        self._corners = full_frame_corners()
        self._drag: int | None = None         # индекс перетаскиваемого угла
        self._grab_offset = QPointF()         # чтобы угол не «прыгал» под курсор

    # --- данные ---
    def set_image(self, qimage: QImage | None, corners: np.ndarray | None = None) -> None:
        self._pixmap = QPixmap.fromImage(qimage) if qimage is not None else None
        self._scaled = None
        self._drag = None
        if corners is not None:
            self._corners = np.array(corners, dtype=np.float64)
        self.update()

    def has_image(self) -> bool:
        return self._pixmap is not None

    def corners(self) -> np.ndarray:
        return self._corners.copy()

    def set_corners(self, corners: np.ndarray, emit: bool = False) -> None:
        self._corners = np.clip(np.array(corners, dtype=np.float64), 0.0, 1.0)
        self.update()
        if emit:
            self.cornersChanged.emit(self.corners())

    # --- геометрия: нормированные <-> экранные координаты ---
    def _image_rect(self) -> QRectF:
        """Где на виджете лежит картинка: вписана с сохранением пропорций.
        Поля по краям — чтобы маркер в углу кадра было за что схватить."""
        if self._pixmap is None:
            return QRectF()
        margin = self.HANDLE_R + 4
        avail_w = max(1.0, self.width() - 2 * margin)
        avail_h = max(1.0, self.height() - 2 * margin)
        scale = min(avail_w / self._pixmap.width(), avail_h / self._pixmap.height())
        w, h = self._pixmap.width() * scale, self._pixmap.height() * scale
        return QRectF((self.width() - w) / 2, (self.height() - h) / 2, w, h)

    def _to_widget(self, i: int) -> QPointF:
        r = self._image_rect()
        x, y = self._corners[i]
        # Отличие от core.geometry.to_pixels (там множитель w-1) — меньше пикселя, не видно.
        return QPointF(r.left() + x * r.width(), r.top() + y * r.height())

    def _to_normalized(self, p: QPointF) -> np.ndarray:
        r = self._image_rect()
        x = (p.x() - r.left()) / max(r.width(), 1e-9)
        y = (p.y() - r.top()) / max(r.height(), 1e-9)
        # Угол не может уйти за пределы изображения.
        return np.clip([x, y], 0.0, 1.0)

    def _handle_at(self, p: QPointF) -> int | None:
        best, best_d = None, float(self.HIT_R)
        for i in range(4):
            d = (self._to_widget(i) - p)
            dist = (d.x() ** 2 + d.y() ** 2) ** 0.5
            if dist <= best_d:
                best, best_d = i, dist
        return best

    # --- мышь ---
    def mousePressEvent(self, event: QMouseEvent) -> None:
        if self._pixmap is None or event.button() != Qt.MouseButton.LeftButton:
            return
        pos = event.position()
        i = self._handle_at(pos)
        if i is not None:
            self._drag = i
            self._grab_offset = self._to_widget(i) - pos
            self.setCursor(Qt.CursorShape.BlankCursor)  # курсор не закрывает точку — есть лупа
            self.update()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        pos = event.position()
        if self._drag is None:
            over = self._pixmap is not None and self._handle_at(pos) is not None
            self.setCursor(Qt.CursorShape.OpenHandCursor if over else Qt.CursorShape.ArrowCursor)
            return
        self._corners[self._drag] = self._to_normalized(pos + self._grab_offset)
        self.update()
        # Сигнал идёт на каждое движение; частоту перерисовки результата
        # ограничивает PreviewRenderer (таймер), здесь ничего не тормозим.
        self.cornersChanged.emit(self.corners())

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if self._drag is None or event.button() != Qt.MouseButton.LeftButton:
            return
        self._drag = None
        self.setCursor(Qt.CursorShape.OpenHandCursor)
        # Пользователь мог «перекрестить» углы (утащить левый верхний вправо).
        # Переупорядочиваем, чтобы индексы снова значили TL, TR, BR, BL.
        self._corners = order_points(self._corners)
        self.update()
        self.cornersChanged.emit(self.corners())

    # --- отрисовка ---
    def resizeEvent(self, event) -> None:
        self._scaled = None  # масштаб изменился — кэш недействителен
        super().resizeEvent(event)

    def _scaled_pixmap(self, size: QSize) -> QPixmap:
        # Масштабировать 1600-px картинку на каждом движении мыши дорого;
        # делаем это один раз на размер окна.
        if self._scaled is None or self._scaled.size() != size:
            self._scaled = self._pixmap.scaled(size, Qt.AspectRatioMode.IgnoreAspectRatio,
                                               Qt.TransformationMode.SmoothTransformation)
        return self._scaled

    def paintEvent(self, event: QPaintEvent) -> None:
        p = QPainter(self)
        p.fillRect(self.rect(), self.palette().window())
        if self._pixmap is None:
            p.setPen(self.palette().placeholderText().color())
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter,
                       "Откройте изображения или перетащите их в окно")
            return
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        rect = self._image_rect()
        p.drawPixmap(rect.topLeft(), self._scaled_pixmap(rect.size().toSize()))

        poly = QPolygonF([self._to_widget(i) for i in range(4)])
        p.setPen(QPen(ACCENT, 2))
        p.setBrush(QColor(ACCENT.red(), ACCENT.green(), ACCENT.blue(), 45))
        p.drawPolygon(poly)

        for i in range(4):
            active = i == self._drag
            p.setPen(QPen(Qt.GlobalColor.white, 2))
            p.setBrush(QColor(255, 120, 0) if active else ACCENT)
            p.drawEllipse(self._to_widget(i), self.HANDLE_R, self.HANDLE_R)

        if self._drag is not None:
            self._paint_magnifier(p, rect)

    def _magnifier_center(self, corner: QPointF) -> QPointF:
        """Лупа — по диагонали от угла В СТОРОНУ ЦЕНТРА виджета: там она не
        окажется под пальцем/курсором и не вылезет за край окна."""
        shift = self.MAG_R + self.MAG_GAP
        dx = shift if corner.x() < self.width() / 2 else -shift
        dy = shift if corner.y() < self.height() / 2 else -shift
        c = corner + QPointF(dx, dy)
        r = self.MAG_R + 2
        return QPointF(min(max(c.x(), r), self.width() - r),
                       min(max(c.y(), r), self.height() - r))

    def _paint_magnifier(self, p: QPainter, rect: QRectF) -> None:
        corner = self._to_widget(self._drag)
        center = self._magnifier_center(corner)
        r = self.MAG_R
        circle = QPainterPath()
        circle.addEllipse(center, r, r)

        p.save()
        p.setClipPath(circle)
        p.fillPath(circle, QColor(40, 40, 40))  # фон там, где лупа вылезает за картинку
        # Рисуем ИСХОДНОЕ превью (не уменьшенное под экран) через трансформацию:
        # точка угла в пикселях картинки -> центр лупы, масштаб = экранный * MAG_ZOOM.
        k = rect.width() / self._pixmap.width() * self.MAG_ZOOM
        ix = self._corners[self._drag][0] * self._pixmap.width()
        iy = self._corners[self._drag][1] * self._pixmap.height()
        p.translate(center)
        p.scale(k, k)
        p.translate(-ix, -iy)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        p.drawPixmap(0, 0, self._pixmap)
        # Стороны четырёхугольника внутри лупы — видно, ровно ли легла линия на край листа.
        pen = QPen(ACCENT, 1.5)
        pen.setCosmetic(True)  # толщина в пикселях экрана, независимо от масштаба
        p.setPen(pen)
        p.setBrush(Qt.BrushStyle.NoBrush)
        w, h = self._pixmap.width(), self._pixmap.height()
        p.drawPolygon(QPolygonF([QPointF(x * w, y * h) for x, y in self._corners]))
        p.restore()

        # Перекрестие и рамка лупы (уже без трансформации).
        p.setPen(QPen(QColor(255, 60, 60), 1))
        p.drawLine(QPointF(center.x() - r, center.y()), QPointF(center.x() + r, center.y()))
        p.drawLine(QPointF(center.x(), center.y() - r), QPointF(center.x(), center.y() + r))
        p.setPen(QPen(Qt.GlobalColor.white, 3))
        p.setBrush(QBrush(Qt.BrushStyle.NoBrush))
        p.drawEllipse(center, r, r)


class CornerEditor(QWidget):
    """Холст + кнопки «Авто» и «Весь кадр»."""

    cornersChanged = Signal(object)    # np.ndarray (4, 2)
    detectionFinished = Signal(bool)   # результат кнопки «Авто»: найден ли документ

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self._preview: np.ndarray | None = None
        self.canvas = CornerCanvas()
        self.canvas.cornersChanged.connect(self.cornersChanged)

        self.auto_button = QPushButton("Авто")
        self.auto_button.setToolTip("Найти края документа автоматически")
        self.auto_button.clicked.connect(self.auto_detect)
        self.full_button = QPushButton("Весь кадр")
        self.full_button.setToolTip("Рамка по краям изображения (без обрезки)")
        self.full_button.clicked.connect(self.full_frame)

        buttons = QHBoxLayout()
        buttons.addWidget(self.auto_button)
        buttons.addWidget(self.full_button)
        buttons.addStretch()
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addLayout(buttons)
        layout.addWidget(self.canvas, 1)
        self._update_buttons()

    def set_image(self, preview: np.ndarray | None, corners: np.ndarray | None = None) -> None:
        self._preview = preview
        self.canvas.set_image(ndarray_to_qimage(preview) if preview is not None else None, corners)
        self._update_buttons()

    def corners(self) -> np.ndarray:
        return self.canvas.corners()

    def set_corners(self, corners: np.ndarray, emit: bool = False) -> None:
        self.canvas.set_corners(corners, emit)

    def auto_detect(self) -> None:
        if self._preview is None:
            return
        # Выполняем прямо в GUI-потоке: детекция работает на копии 800 px
        # и занимает миллисекунды — фоновый поток тут только усложнил бы код.
        result = detect_document(self._preview)
        self.canvas.set_corners(result.corners, emit=True)
        self.detectionFinished.emit(result.found)

    def full_frame(self) -> None:
        if self._preview is not None:
            self.canvas.set_corners(full_frame_corners(), emit=True)

    def _update_buttons(self) -> None:
        enabled = self._preview is not None
        self.auto_button.setEnabled(enabled)
        self.full_button.setEnabled(enabled)
