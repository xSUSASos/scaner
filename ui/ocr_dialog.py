"""Окно с распознанным текстом: посмотреть, скопировать, сохранить в .txt."""
from __future__ import annotations

from pathlib import Path

from PySide6.QtGui import QFontDatabase, QGuiApplication
from PySide6.QtWidgets import (QDialog, QDialogButtonBox, QFileDialog, QMessageBox,
                               QPlainTextEdit, QPushButton, QVBoxLayout, QWidget)

from .workers import describe_error


class OcrDialog(QDialog):
    def __init__(self, text: str, suggested_name: str = "текст.txt",
                 parent: QWidget | None = None):
        super().__init__(parent)
        self.setWindowTitle("Распознанный текст")
        self.resize(700, 600)
        self._suggested_name = suggested_name

        self.editor = QPlainTextEdit()
        self.editor.setReadOnly(True)  # только чтение, но выделять и копировать можно
        self.editor.setPlainText(text)
        self.editor.setFont(QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont))
        if not text.strip():
            self.editor.setPlaceholderText("Текст не найден")

        buttons = QDialogButtonBox()
        copy_button = QPushButton("Копировать")
        save_button = QPushButton("Сохранить .txt…")
        close_button = QPushButton("Закрыть")
        buttons.addButton(copy_button, QDialogButtonBox.ButtonRole.ActionRole)
        buttons.addButton(save_button, QDialogButtonBox.ButtonRole.ActionRole)
        buttons.addButton(close_button, QDialogButtonBox.ButtonRole.RejectRole)
        copy_button.clicked.connect(self.copy_to_clipboard)
        save_button.clicked.connect(self.save_as)
        close_button.clicked.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.addWidget(self.editor, 1)
        layout.addWidget(buttons)

    def text(self) -> str:
        return self.editor.toPlainText()

    def copy_to_clipboard(self) -> None:
        # Если пользователь выделил фрагмент — копируем его, иначе весь текст.
        selected = self.editor.textCursor().selectedText().replace(" ", "\n")
        QGuiApplication.clipboard().setText(selected or self.text())

    def save_as(self) -> None:
        path, _ = QFileDialog.getSaveFileName(self, "Сохранить текст", self._suggested_name,
                                              "Текст (*.txt)")
        if not path:
            return
        if not path.lower().endswith(".txt"):
            path += ".txt"
        try:
            from core.export import save_text
            save_text(self.text(), path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "Не удалось сохранить", describe_error(exc))
            return
        QMessageBox.information(self, "Сохранено", f"Текст сохранён:\n{Path(path)}")
