"""Главное окно: связывает модель документа, виджеты и фоновые задачи.

Раскладка:  [список страниц] | [Углы | Результат] | [фильтры]

Поток данных при редактировании:
  виджет (углы/фильтр/поворот) -> меняем Page текущей страницы
  -> Document.pageChanged (миниатюра) + PreviewRenderer.request (большое превью).

Все долгие операции (загрузка, экспорт, OCR) — в рабочих потоках (ui.workers).
Методы с диалогами (export_pdf, export_images, …) только спрашивают путь и
вызывают start_* — так экспорт можно запустить и без диалогов (smoke-тест).
"""
from __future__ import annotations

from collections import deque
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QCloseEvent, QDragEnterEvent, QDropEvent, QKeySequence
from PySide6.QtWidgets import (QFileDialog, QInputDialog, QLabel, QMainWindow, QMessageBox,
                               QProgressDialog, QScrollArea, QSplitter, QVBoxLayout, QWidget)

from core.imageio import SUPPORTED_EXTS, is_supported
from core.page import Page, render_full

from . import workers
from .corner_editor import CornerEditor
from .document_model import Document, LoadedPage, PageEntry, load_page
from .filter_panel import FilterPanel
from .ocr_dialog import OcrDialog
from .page_list import PageList
from .result_view import PreviewRenderer, ResultView
from .workers import Task, run_task

EXPORT_BASE_NAME = "Скан"


# ---------- функции, которые выполняются в рабочих потоках ----------
# core.export и core.ocr импортируются внутри: если модуля нет или он сломан,
# программа всё равно запустится, а ошибка покажется при попытке экспорта.

def export_pdf_job(pages: list[Page], path: Path, progress) -> Path:
    from core.export import export_pdf
    # Генератор, а не список: в памяти одновременно только одна страница 50 Мп.
    images = (render_full(p) for p in pages)
    return export_pdf(images, path, total=len(pages), progress=progress)


def export_searchable_pdf_job(pages: list[Page], path: Path, progress) -> Path:
    from core.export import export_searchable_pdf
    from core.ocr import DEFAULT_LANG
    images = (render_full(p) for p in pages)
    return export_searchable_pdf(images, path, lang=DEFAULT_LANG, total=len(pages),
                                 progress=progress)


def export_images_job(pages: list[Page], folder: Path, fmt: str, progress) -> list[Path]:
    from core.export import export_images
    images = (render_full(p) for p in pages)
    return export_images(images, folder, EXPORT_BASE_NAME, fmt=fmt, total=len(pages),
                         progress=progress)


def ocr_job(page: Page) -> str:
    from core import ocr
    status = ocr.check_tesseract()  # проверяем при каждом запуске: вдруг Tesseract уже поставили
    if not status.ok:
        raise ocr.TesseractNotFoundError(status.message)
    # OCR — по оригиналу: мелкий текст на превью 1600 px распознаётся плохо.
    return ocr.image_to_text(render_full(page), ocr.DEFAULT_LANG)


def check_tesseract_job():
    from core.ocr import check_tesseract
    return check_tesseract()


def _titled(title: str, widget: QWidget) -> QWidget:
    """Виджет с заголовком сверху."""
    box = QWidget()
    layout = QVBoxLayout(box)
    layout.setContentsMargins(4, 4, 4, 4)
    label = QLabel(f"<b>{title}</b>")
    layout.addWidget(label)
    layout.addWidget(widget, 1)
    return box


class MainWindow(QMainWindow):
    def __init__(self, check_tesseract_on_start: bool = True):
        super().__init__()
        self.setWindowTitle("Сканер документов")
        self.resize(1400, 850)
        self.setAcceptDrops(True)  # перетаскивание файлов из Проводника

        self.document = Document(self)
        self._current_id = 0
        self._last_dir = str(Path.home())

        # Очередь загрузки: файлы грузятся строго по одному. Параллельная загрузка
        # двадцати 50-Мп снимков съела бы несколько гигабайт памяти.
        self._load_queue: deque[Path] = deque()
        self._load_task: Task | None = None
        self._load_total = 0
        self._load_done = 0
        self._load_errors: list[str] = []

        # Экспорт/OCR: одновременно только одна такая задача.
        self._busy_task: Task | None = None
        self._progress: QProgressDialog | None = None
        self.last_ocr_dialog: OcrDialog | None = None
        self.tesseract_status = None

        self._build_widgets()
        self._build_actions()
        self._build_status_bar()
        self._connect_signals()
        self._show_current()

        if check_tesseract_on_start:
            # singleShot(0): проверка начнётся, когда окно уже показано.
            QTimer.singleShot(0, self._check_tesseract_on_start)

    # ================= построение интерфейса =================
    def _build_widgets(self) -> None:
        self.page_list = PageList(self.document)
        self.corner_editor = CornerEditor()
        self.result_view = ResultView()
        self.filter_panel = FilterPanel()
        self.renderer = PreviewRenderer(self)

        center = QSplitter(Qt.Orientation.Horizontal)
        center.addWidget(_titled("Углы", self.corner_editor))
        center.addWidget(_titled("Результат", self.result_view))

        # Панель фильтров в прокрутке — на маленьких экранах она не влезет по высоте.
        filter_scroll = QScrollArea()
        filter_scroll.setWidget(self.filter_panel)
        filter_scroll.setWidgetResizable(True)
        filter_scroll.setMinimumWidth(260)

        main = QSplitter(Qt.Orientation.Horizontal)
        main.addWidget(self.page_list)
        main.addWidget(center)
        main.addWidget(filter_scroll)
        main.setStretchFactor(0, 0)
        main.setStretchFactor(1, 1)
        main.setStretchFactor(2, 0)
        main.setSizes([200, 900, 280])
        self.setCentralWidget(main)

    def _action(self, text: str, slot, shortcut: str | QKeySequence | None = None,
                tip: str = "") -> QAction:
        action = QAction(text, self)
        action.triggered.connect(slot)
        if shortcut:
            action.setShortcut(shortcut)
        if tip:
            action.setStatusTip(tip)
        return action

    def _build_actions(self) -> None:
        self.open_action = self._action("Открыть…", self.open_files, QKeySequence.StandardKey.Open,
                                        "Добавить изображения в документ")
        self.export_pdf_action = self._action("Экспорт PDF…", self.export_pdf, "Ctrl+S")
        self.export_ocr_action = self._action("Экспорт PDF с текстом (OCR)…",
                                              self.export_searchable_pdf, "Ctrl+Shift+S",
                                              "PDF, в котором можно искать и копировать текст")
        self.export_images_action = self._action("Экспорт JPG/PNG…", self.export_images, "Ctrl+E")
        self.ocr_action = self._action("Распознать текст", self.recognize_text, "Ctrl+T",
                                       "Распознать текст текущей страницы")
        self.delete_action = self._action("Удалить страницу", self.delete_current_page)
        quit_action = self._action("Выход", self.close, QKeySequence.StandardKey.Quit)

        file_menu = self.menuBar().addMenu("Файл")
        file_menu.addAction(self.open_action)
        file_menu.addSeparator()
        for a in (self.export_pdf_action, self.export_ocr_action, self.export_images_action):
            file_menu.addAction(a)
        file_menu.addSeparator()
        file_menu.addAction(quit_action)
        page_menu = self.menuBar().addMenu("Страница")
        page_menu.addAction(self.ocr_action)
        page_menu.addAction(self.delete_action)

        toolbar = self.addToolBar("Главная")
        toolbar.setMovable(False)
        toolbar.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextOnly)
        toolbar.addAction(self.open_action)
        toolbar.addSeparator()
        for a in (self.export_pdf_action, self.export_ocr_action, self.export_images_action):
            toolbar.addAction(a)
        toolbar.addSeparator()
        toolbar.addAction(self.ocr_action)
        toolbar.addAction(self.delete_action)

    def _build_status_bar(self) -> None:
        self._pages_label = QLabel()
        self._detect_label = QLabel()
        self.statusBar().addPermanentWidget(self._detect_label)
        self.statusBar().addPermanentWidget(self._pages_label)

    def _connect_signals(self) -> None:
        self.page_list.pageSelected.connect(self._on_page_selected)
        self.page_list.orderChanged.connect(self.document.set_order)
        self.page_list.deleteRequested.connect(self.delete_pages)
        self.document.structureChanged.connect(self._update_status)
        self.document.structureChanged.connect(self._update_actions)

        self.corner_editor.cornersChanged.connect(self._on_corners_changed)
        self.corner_editor.detectionFinished.connect(self._on_detection_finished)
        self.filter_panel.settingsChanged.connect(self._on_filter_changed)
        self.filter_panel.rotateRequested.connect(self._on_rotate)

        self.renderer.rendered.connect(self.result_view.set_image)
        self.renderer.failed.connect(
            lambda msg: self.statusBar().showMessage(f"Ошибка обработки: {msg}", 10000))

    # ================= сообщения (отдельные методы — их подменяет smoke-тест) =================
    def _show_error(self, title: str, text: str) -> None:
        QMessageBox.critical(self, title, text)

    def _show_warning(self, title: str, text: str) -> None:
        QMessageBox.warning(self, title, text)

    def _show_info(self, title: str, text: str) -> None:
        QMessageBox.information(self, title, text)

    def _ask_yes_no(self, title: str, text: str) -> bool:
        answer = QMessageBox.question(self, title, text)
        return answer == QMessageBox.StandardButton.Yes

    # ================= загрузка файлов =================
    def open_files(self) -> None:
        patterns = " ".join(f"*{ext}" for ext in sorted(SUPPORTED_EXTS))
        paths, _ = QFileDialog.getOpenFileNames(
            self, "Открыть изображения", self._last_dir,
            f"Изображения ({patterns});;Все файлы (*)")
        if paths:
            self.add_files(paths)

    def add_files(self, paths: list[str | Path]) -> None:
        """Поставить файлы в очередь загрузки (неподдерживаемые — пропустить с сообщением)."""
        accepted, skipped = [], []
        for p in map(Path, paths):
            (accepted if p.is_file() and is_supported(p) else skipped).append(p)
        if skipped:
            names = "\n".join(p.name or str(p) for p in skipped[:15])
            if len(skipped) > 15:
                names += f"\n… и ещё {len(skipped) - 15}"
            exts = ", ".join(sorted(e.lstrip(".") for e in SUPPORTED_EXTS))
            self._show_info("Некоторые файлы пропущены",
                            f"Эти файлы не являются поддерживаемыми изображениями:\n{names}\n\n"
                            f"Поддерживаются: {exts}")
        if not accepted:
            return
        self._last_dir = str(accepted[0].parent)
        self._load_queue.extend(accepted)
        self._load_total += len(accepted)
        self._load_next()

    def is_loading(self) -> bool:
        return self._load_task is not None or bool(self._load_queue)

    def _load_next(self) -> None:
        if self._load_task is not None:
            return  # следующий файл запустится из обработчика завершения
        if not self._load_queue:
            self._finish_loading()
            return
        path = self._load_queue.popleft()
        self.statusBar().showMessage(
            f"Загрузка {self._load_done + 1} из {self._load_total}: {path.name}")
        self._load_task = run_task(
            load_page, path,
            on_done=self._on_page_loaded,
            on_error=lambda msg, p=path: self._on_page_load_failed(p, msg))

    def _on_page_loaded(self, loaded: LoadedPage) -> None:
        self._load_task = None
        self._load_done += 1
        page_id = self.document.add(loaded)
        if not self._current_id:
            self.page_list.select(page_id)  # первая загруженная страница сразу открывается
        self._load_next()

    def _on_page_load_failed(self, path: Path, message: str) -> None:
        self._load_task = None
        self._load_done += 1
        self._load_errors.append(message)
        self._load_next()

    def _finish_loading(self) -> None:
        loaded = self._load_done - len(self._load_errors)
        if self._load_total:
            self.statusBar().showMessage(f"Загружено страниц: {loaded}", 5000)
        errors = self._load_errors
        self._load_total = self._load_done = 0
        self._load_errors = []
        if errors:
            self._show_error("Не удалось открыть файлы", "\n\n".join(errors))

    # --- перетаскивание файлов в окно ---
    def dragEnterEvent(self, event: QDragEnterEvent) -> None:
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dragMoveEvent(self, event) -> None:
        if event.mimeData().hasUrls():
            event.acceptProposedAction()

    def dropEvent(self, event: QDropEvent) -> None:
        paths = [u.toLocalFile() for u in event.mimeData().urls() if u.isLocalFile()]
        if paths:
            event.acceptProposedAction()
            self.add_files(paths)

    # ================= текущая страница и редактирование =================
    def current_entry(self) -> PageEntry | None:
        return self.document.entry(self._current_id) if self._current_id else None

    def _on_page_selected(self, page_id: int) -> None:
        if page_id == self._current_id:
            return
        self._current_id = page_id
        self._show_current()

    def _show_current(self) -> None:
        entry = self.current_entry()
        self.renderer.clear()
        # Сразу убираем старый результат: пусть лучше будет пусто 0.1 с,
        # чем результат ДРУГОЙ страницы.
        self.result_view.set_image(None)
        if entry is None:
            self.corner_editor.set_image(None)
            self.filter_panel.setEnabled(False)
        else:
            self.corner_editor.set_image(entry.preview, entry.page.corners)
            self.filter_panel.set_settings(entry.page.filter)
            self.filter_panel.setEnabled(True)
            self.renderer.request(entry.page, entry.preview)
        self._update_status()
        self._update_actions()

    def _page_edited(self, entry: PageEntry) -> None:
        self.document.notify_page_changed(entry.id)       # -> миниатюра
        self.renderer.request(entry.page, entry.preview)  # -> большое превью

    def _on_corners_changed(self, corners: np.ndarray) -> None:
        entry = self.current_entry()
        if entry is not None:
            entry.page.corners = np.array(corners, dtype=np.float64)
            self._page_edited(entry)

    def _on_detection_finished(self, found: bool) -> None:
        entry = self.current_entry()
        if entry is not None:
            entry.page.auto_detected = found
            self._update_status()
            if not found:
                self.statusBar().showMessage("Документ не найден — углы по краям кадра", 5000)

    def _on_filter_changed(self, settings) -> None:
        entry = self.current_entry()
        if entry is not None:
            entry.page.filter = settings
            self._page_edited(entry)

    def _on_rotate(self, delta: int) -> None:
        entry = self.current_entry()
        if entry is not None:
            entry.page.rotation = (entry.page.rotation + delta) % 4
            self._page_edited(entry)

    # ================= удаление =================
    def delete_current_page(self) -> None:
        if self._current_id:
            self.delete_pages([self._current_id])

    def delete_pages(self, page_ids: list[int]) -> None:
        """Убрать страницы из документа (файлы на диске не трогаем)."""
        ids = self.document.ids()
        doomed = set(page_ids)
        next_id = self._current_id
        if self._current_id in doomed:
            # Открываем соседнюю: следующую после текущей, иначе предыдущую.
            pos = ids.index(self._current_id)
            after = [i for i in ids[pos + 1:] if i not in doomed]
            before = [i for i in ids[:pos] if i not in doomed]
            next_id = after[0] if after else (before[-1] if before else 0)
        self.document.remove(list(doomed))
        if next_id != self._current_id:
            self._current_id = 0
            if next_id:
                self.page_list.select(next_id)
            else:
                self._show_current()
        self._update_status()

    # ================= экспорт и OCR =================
    def _default_save_path(self, suffix: str) -> str:
        return str(Path(self._last_dir) / f"{EXPORT_BASE_NAME}{suffix}")

    def _ask_save_path(self, title: str, file_filter: str, suffix: str) -> Path | None:
        path, _ = QFileDialog.getSaveFileName(self, title, self._default_save_path(suffix),
                                              file_filter)
        if not path:
            return None
        path = Path(path)
        if path.suffix.lower() != suffix:
            path = path.with_name(path.name + suffix)
        self._last_dir = str(path.parent)
        return path

    def export_pdf(self) -> None:
        path = self._ask_save_path("Экспорт PDF", "PDF (*.pdf)", ".pdf")
        if path:
            self.start_export_pdf(path)

    def export_searchable_pdf(self) -> None:
        path = self._ask_save_path("Экспорт PDF с текстом", "PDF (*.pdf)", ".pdf")
        if path:
            self.start_export_searchable_pdf(path)

    def export_images(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Папка для изображений", self._last_dir)
        if not folder:
            return
        fmt, ok = QInputDialog.getItem(self, "Формат", "Формат файлов:", ["JPG", "PNG"], 0, False)
        if not ok:
            return
        fmt = fmt.lower()
        n = len(self.document)
        existing = [Path(folder) / f"{EXPORT_BASE_NAME}_{i:03d}.{fmt}" for i in range(1, n + 1)]
        existing = [p for p in existing if p.exists()]
        if existing and not self._ask_yes_no(
                "Файлы уже существуют",
                f"В папке уже есть {len(existing)} файл(ов) вида {existing[0].name}.\n"
                "Перезаписать?"):
            return
        self._last_dir = folder
        self.start_export_images(Path(folder), fmt)

    def start_export_pdf(self, path: Path) -> Task | None:
        return self._start_export("Экспорт PDF…", export_pdf_job, Path(path),
                                  done_text=lambda p: f"PDF сохранён: {p}")

    def start_export_searchable_pdf(self, path: Path) -> Task | None:
        return self._start_export("Распознавание и экспорт PDF…", export_searchable_pdf_job,
                                  Path(path), done_text=lambda p: f"PDF с текстом сохранён: {p}")

    def start_export_images(self, folder: Path, fmt: str) -> Task | None:
        return self._start_export("Экспорт изображений…", export_images_job, Path(folder), fmt,
                                  done_text=lambda files: f"Сохранено файлов: {len(files)} "
                                                          f"в {Path(folder)}")

    def _start_export(self, title: str, job, *args, done_text) -> Task | None:
        if not len(self.document):
            self._show_info("Нет страниц", "Сначала откройте изображения.")
            return None
        # Снимок страниц: экспорт видит документ таким, каким он был в момент нажатия.
        pages = self.document.pages_snapshot()
        return self._run_busy(title, job, pages, *args, cancellable=True,
                              on_done=lambda result: self.statusBar().showMessage(
                                  done_text(result), 15000))

    def recognize_text(self) -> Task | None:
        entry = self.current_entry()
        if entry is None:
            self._show_info("Нет страницы", "Сначала откройте изображение.")
            return None
        name = f"{entry.page.source_path.stem}.txt"
        # OCR одной страницы нельзя прервать посередине (Tesseract — внешняя
        # программа без колбэков), поэтому кнопки «Отмена» нет.
        return self._run_busy("Распознавание текста…", ocr_job, entry.page.clone(),
                              cancellable=False,
                              on_done=lambda text: self._show_ocr_result(text, name))

    def _show_ocr_result(self, text: str, suggested_name: str) -> None:
        dialog = OcrDialog(text, str(Path(self._last_dir) / suggested_name), self)
        dialog.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose)
        dialog.show()  # не exec(): немодальное окно не блокирует главное
        self.last_ocr_dialog = dialog

    def is_busy(self) -> bool:
        return self._busy_task is not None

    def _run_busy(self, title: str, job, *args, cancellable: bool, on_done) -> Task | None:
        """Запустить задачу с окном прогресса. Пока она идёт, экспорт/OCR недоступны."""
        if self._busy_task is not None:
            return None
        dialog = QProgressDialog(title, "Отмена", 0, 0, self)
        if not cancellable:
            dialog.setCancelButton(None)
        dialog.setWindowTitle("Подождите")
        # WindowModal: пока идёт экспорт, нельзя менять страницы, но окно перерисовывается.
        dialog.setWindowModality(Qt.WindowModality.WindowModal)
        dialog.setMinimumDuration(0)
        dialog.setAutoClose(False)
        dialog.setAutoReset(False)
        dialog.show()

        def on_progress(done: int, total: int) -> None:
            if total > 0:
                dialog.setMaximum(total)
                dialog.setValue(done)
                dialog.setLabelText(f"{title}\nГотово страниц: {done} из {total}")

        def finish() -> None:
            self._busy_task = None
            self._progress = None
            dialog.hide()  # hide, а не close: close у QProgressDialog шлёт canceled
            dialog.deleteLater()
            self._update_actions()

        def done(result) -> None:
            finish()
            on_done(result)

        def failed(message: str) -> None:
            finish()
            self._show_error("Ошибка", message)

        def cancelled() -> None:
            finish()
            self.statusBar().showMessage("Операция отменена", 5000)

        task = run_task(job, *args, pass_progress=cancellable, on_done=done, on_error=failed,
                        on_progress=on_progress, on_cancel=cancelled)
        if cancellable:
            dialog.canceled.connect(task.cancel)
            dialog.canceled.connect(lambda: dialog.setLabelText("Отмена… (дожидаемся текущей страницы)"))
        self._busy_task = task
        self._progress = dialog
        self._update_actions()
        return task

    # ================= Tesseract =================
    def _check_tesseract_on_start(self) -> None:
        # Проверка запускает tesseract.exe (доли секунды) — тоже в фоне.
        run_task(check_tesseract_job, on_done=self._on_tesseract_status,
                 on_error=lambda msg: print("Проверка Tesseract не удалась:", msg))

    def _on_tesseract_status(self, status) -> None:
        self.tesseract_status = status
        if not status.ok:
            self._show_warning(
                "Распознавание текста недоступно",
                f"{status.message}\n\nСканирование и экспорт в PDF/JPG работают и без Tesseract.")

    # ================= состояние интерфейса =================
    def _update_status(self) -> None:
        n = len(self.document)
        index = self.document.index_of(self._current_id)
        text = f"Страниц: {n}"
        if index >= 0:
            text = f"Страница {index + 1} из {n}"
        self._pages_label.setText(text)

        entry = self.current_entry()
        if entry is None:
            self._detect_label.setText("")
        elif entry.page.auto_detected:
            self._detect_label.setText("Документ найден автоматически")
        else:
            self._detect_label.setText("Контур не найден — выставлена рамка по краям")

    def _update_actions(self) -> None:
        has_pages = len(self.document) > 0
        idle = self._busy_task is None
        for a in (self.export_pdf_action, self.export_ocr_action, self.export_images_action):
            a.setEnabled(has_pages and idle)
        self.ocr_action.setEnabled(self._current_id != 0 and idle)
        self.delete_action.setEnabled(self._current_id != 0)

    def closeEvent(self, event: QCloseEvent) -> None:
        # Дожидаемся рабочих потоков: уничтожение работающего QThread роняет программу.
        workers.wait_all()
        event.accept()
