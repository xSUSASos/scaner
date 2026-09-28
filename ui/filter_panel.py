"""Панель фильтров: режим, яркость/контраст, параметры Ч/Б, поворот.

Панель ничего не обрабатывает сама — только сообщает о новых настройках
сигналом settingsChanged. Перерисовкой превью занимается PreviewRenderer.
"""
from __future__ import annotations

from collections.abc import Callable

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (QButtonGroup, QGroupBox, QHBoxLayout, QLabel, QPushButton,
                               QRadioButton, QSlider, QVBoxLayout, QWidget)

from core.filters import FILTER_TITLES, FilterMode, FilterSettings


class LabeledSlider(QWidget):
    """Подпись + ползунок + текущее значение.

    QSlider умеет только целые числа, поэтому для дробных параметров задаём
    множитель scale: например, «размер блока» 0.5..10 с шагом 0.5 — это
    целые 1..20 на ползунке, делённые на 2.
    """

    valueChanged = Signal(float)

    def __init__(self, title: str, minimum: float, maximum: float, scale: int = 1,
                 fmt: Callable[[float], str] = lambda v: f"{v:g}"):
        super().__init__()
        self._scale, self._fmt = scale, fmt
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(round(minimum * scale), round(maximum * scale))
        self.value_label = QLabel()
        self.value_label.setMinimumWidth(44)
        self.value_label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.slider.valueChanged.connect(self._on_changed)

        top = QHBoxLayout()
        top.addWidget(QLabel(title))
        top.addStretch()
        top.addWidget(self.value_label)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addLayout(top)
        layout.addWidget(self.slider)

    def value(self) -> float:
        return self.slider.value() / self._scale

    def set_value(self, v: float) -> None:
        self.slider.setValue(round(v * self._scale))
        self.value_label.setText(self._fmt(self.value()))

    def _on_changed(self, _raw: int) -> None:
        self.value_label.setText(self._fmt(self.value()))
        self.valueChanged.emit(self.value())


class FilterPanel(QWidget):
    settingsChanged = Signal(object)  # FilterSettings (новый объект)
    rotateRequested = Signal(int)     # +1 — по часовой, -1 — против

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        # Флаг «заполняем виджеты программно»: в это время не шлём settingsChanged,
        # иначе открытие страницы выглядело бы как её редактирование.
        self._updating = False

        # --- режим ---
        mode_box = QGroupBox("Фильтр")
        mode_layout = QVBoxLayout(mode_box)
        self._mode_group = QButtonGroup(self)
        self._mode_buttons: dict[FilterMode, QRadioButton] = {}
        for mode in FilterMode:
            button = QRadioButton(FILTER_TITLES[mode])
            self._mode_group.addButton(button)
            self._mode_buttons[mode] = button
            mode_layout.addWidget(button)
        self._mode_group.buttonToggled.connect(self._on_mode_toggled)

        # --- яркость/контраст ---
        adjust_box = QGroupBox("Коррекция")
        adjust_layout = QVBoxLayout(adjust_box)
        self.brightness = LabeledSlider("Яркость", -100, 100, fmt=lambda v: f"{v:+.0f}")
        self.contrast = LabeledSlider("Контраст", -100, 100, fmt=lambda v: f"{v:+.0f}")
        for s in (self.brightness, self.contrast):
            s.valueChanged.connect(self._emit)
            adjust_layout.addWidget(s)

        # --- параметры Ч/Б (видны только в режиме Ч/Б) ---
        self.bw_box = QGroupBox("Ч/Б документ")
        bw_layout = QVBoxLayout(self.bw_box)
        self.bw_block = LabeledSlider("Размер блока, %", 0.5, 10, scale=2,
                                      fmt=lambda v: f"{v:.1f}")
        self.bw_block.setToolTip("Меньше — лучше справляется с тенями, но может «съесть» "
                                 "толстые линии и заливки")
        self.bw_c = LabeledSlider("Порог C", 0, 40)
        self.bw_c.setToolTip("Больше — чище фон, но тоньше и бледнее текст")
        for s in (self.bw_block, self.bw_c):
            s.valueChanged.connect(self._emit)
            bw_layout.addWidget(s)

        # --- поворот ---
        rotate_box = QGroupBox("Поворот")
        rotate_layout = QHBoxLayout(rotate_box)
        left = QPushButton("⟲ Влево")
        right = QPushButton("Вправо ⟳")
        left.clicked.connect(lambda: self.rotateRequested.emit(-1))
        right.clicked.connect(lambda: self.rotateRequested.emit(+1))
        rotate_layout.addWidget(left)
        rotate_layout.addWidget(right)

        layout = QVBoxLayout(self)
        for box in (mode_box, adjust_box, self.bw_box, rotate_box):
            layout.addWidget(box)
        layout.addStretch()

        self.set_settings(FilterSettings())
        self.setEnabled(False)  # включится, когда откроют страницу

    def set_settings(self, s: FilterSettings) -> None:
        """Показать настройки страницы (без сигнала settingsChanged)."""
        self._updating = True
        try:
            self._mode_buttons[s.mode].setChecked(True)
            self.brightness.set_value(s.brightness)
            self.contrast.set_value(s.contrast)
            self.bw_block.set_value(s.bw_block_percent)
            self.bw_c.set_value(s.bw_c)
            self.bw_box.setVisible(s.mode == FilterMode.BW)
        finally:
            self._updating = False

    def settings(self) -> FilterSettings:
        mode = next(m for m, b in self._mode_buttons.items() if b.isChecked())
        return FilterSettings(mode=mode,
                              bw_block_percent=self.bw_block.value(),
                              bw_c=int(self.bw_c.value()),
                              brightness=int(self.brightness.value()),
                              contrast=int(self.contrast.value()))

    def select_mode(self, mode: FilterMode) -> None:
        """Выбрать режим так, как будто пользователь кликнул (со всеми сигналами)."""
        self._mode_buttons[mode].setChecked(True)

    def _on_mode_toggled(self, _button: QRadioButton, checked: bool) -> None:
        # buttonToggled приходит дважды: «старая кнопка выключена» и «новая включена».
        if checked:
            self.bw_box.setVisible(self.settings().mode == FilterMode.BW)
            self._emit()

    def _emit(self, *_args) -> None:
        if not self._updating:
            self.settingsChanged.emit(self.settings())
