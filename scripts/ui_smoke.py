"""Smoke-тест интерфейса без показа окон (QT_QPA_PLATFORM=offscreen).

Запуск:  .venv\\Scripts\\python.exe scripts\\ui_smoke.py
Проверяет: загрузку файлов в фоне, детекцию, переключение фильтров, перетаскивание
угла мышью (с лупой), перестановку и удаление страниц, экспорт PDF/JPG, OCR.
Код выхода 0 — всё прошло.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PySide6.QtCore import QModelIndex, QPoint, Qt  # noqa: E402
from PySide6.QtTest import QTest  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from core.filters import FilterMode  # noqa: E402
from core.imageio import save_image  # noqa: E402
from ui import workers  # noqa: E402
from ui.main_window import MainWindow  # noqa: E402

app = QApplication.instance() or QApplication(sys.argv)


def check(cond: bool, what: str) -> None:
    if not cond:
        raise AssertionError(what)
    print("  ok:", what)


def wait_until(cond, timeout: float = 30.0, what: str = "") -> None:
    """Крутить цикл событий, пока cond() не станет True (сигналы из потоков
    доставляются только через цикл событий GUI-потока)."""
    deadline = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > deadline:
            raise TimeoutError(f"Не дождались: {what}")
        app.processEvents()
        time.sleep(0.01)
    app.processEvents()


def make_document_photo(path: Path, angle: float, seed: int) -> None:
    """Белый повёрнутый «лист» с чёрными строками на тёмно-сером фоне."""
    rng = np.random.default_rng(seed)
    h, w = 1200, 1600
    img = np.full((h, w, 3), 70, np.uint8)
    img += rng.integers(0, 15, img.shape, dtype=np.uint8)  # немного шума
    sheet = np.full((1000, 760, 3), 245, np.uint8)
    for i, y in enumerate(range(90, 930, 55)):
        x2 = 680 - (i % 3) * 120
        cv2.rectangle(sheet, (60, y), (x2, y + 16), (20, 20, 20), -1)
    cv2.putText(sheet, "SCAN TEST", (60, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 0, 0), 3)
    # Вставляем лист с поворотом через аффинное преобразование.
    m = cv2.getRotationMatrix2D((380, 500), angle, 1.0)
    m[:, 2] += [w / 2 - 380, h / 2 - 500]
    mask = cv2.warpAffine(np.full(sheet.shape[:2], 255, np.uint8), m, (w, h))
    warped = cv2.warpAffine(sheet, m, (w, h))
    img[mask > 0] = warped[mask > 0]
    save_image(path, img)


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="скан_тест_"))
    summary: list[str] = []
    try:
        p1 = tmp / "первая страница.jpg"
        p2 = tmp / "вторая страница.png"
        make_document_photo(p1, 12, 1)
        make_document_photo(p2, -8, 2)
        bogus = tmp / "заметки.txt"
        bogus.write_text("не картинка", encoding="utf-8")

        window = MainWindow(check_tesseract_on_start=False)
        messages: list[tuple[str, str, str]] = []
        # Окна сообщений в offscreen-режиме заблокировали бы тест — записываем их.
        window._show_error = lambda t, m: messages.append(("error", t, m))
        window._show_warning = lambda t, m: messages.append(("warning", t, m))
        window._show_info = lambda t, m: messages.append(("info", t, m))
        window.show()

        print("1. Загрузка файлов")
        window.add_files([p1, p2, bogus])
        check(any(k == "info" and "заметки.txt" in m for k, t, m in messages),
              "неподдерживаемый файл пропущен с сообщением")
        wait_until(lambda: len(window.document) == 2 and not window.is_loading(), 60, "загрузка")
        check(not [m for m in messages if m[0] == "error"], "без ошибок загрузки")
        entries = window.document.entries()
        found = [e.page.auto_detected for e in entries]
        check(all(found), f"документ найден автоматически на обеих страницах: {found}")
        check(window.current_entry() is entries[0], "первая страница открыта")
        check(entries[0].preview.shape[:2] == (1200, 1600), "превью хранится (≤1600 px)")
        wait_until(lambda: window.result_view.has_image() and window.renderer.is_idle(),
                   20, "превью результата")
        wait_until(lambda: window.page_list.thumbnails_idle()
                   and all(window.page_list.has_thumbnail(e.id) for e in entries), 20,
                   "миниатюры")
        summary.append(f"загружено 2 стр., детекция {found}")

        print("2. Фильтры")
        for mode in [FilterMode.BW, FilterMode.GRAY, FilterMode.ORIGINAL, FilterMode.MAGIC]:
            before = window.renderer.render_count
            window.filter_panel.select_mode(mode)
            wait_until(lambda: window.renderer.render_count > before and window.renderer.is_idle(),
                       20, f"рендер {mode}")
            check(window.current_entry().page.filter.mode == mode, f"режим {mode.value} применён")
        window.filter_panel.select_mode(FilterMode.BW)
        window.filter_panel.bw_c.set_value(20)  # как движение ползунка: шлёт settingsChanged
        window.filter_panel.brightness.slider.setValue(30)
        wait_until(window.renderer.is_idle, 20, "рендер после ползунков")
        f = window.current_entry().page.filter
        check(f.bw_c == 20 and f.brightness == 30, f"ползунки применены (C={f.bw_c}, ярк={f.brightness})")
        # Быстрая серия изменений: показан должен быть только результат последнего.
        for v in range(-50, 51, 10):
            window.filter_panel.contrast.slider.setValue(v)
        wait_until(window.renderer.is_idle, 20, "рендер после серии")
        check(window.current_entry().page.filter.contrast == 50, "последнее значение контраста")
        window.filter_panel.rotateRequested.emit(+1)
        check(window.current_entry().page.rotation == 1, "поворот вправо")
        wait_until(window.renderer.is_idle, 20, "рендер после поворота")
        summary.append("4 фильтра + ползунки + поворот")

        print("3. Углы: перетаскивание мышью")
        canvas = window.corner_editor.canvas
        canvas.resize(800, 600)
        before = window.current_entry().page.corners.copy()
        start = canvas._to_widget(0).toPoint()
        QTest.mousePress(canvas, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, start)
        for step in range(1, 6):
            QTest.mouseMove(canvas, start + QPoint(step * 6, step * 4))
        check(canvas._drag == 0, "угол захвачен")
        canvas.grab()  # принудительная отрисовка с лупой
        QTest.mouseRelease(canvas, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
                           start + QPoint(30, 20))
        after = window.current_entry().page.corners
        check(not np.allclose(before, after), f"угол сдвинут: {before[0]} -> {after[0]}")
        # Утаскиваем угол за пределы — должен остаться в [0, 1].
        QTest.mousePress(canvas, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
                         canvas._to_widget(2).toPoint())
        QTest.mouseMove(canvas, QPoint(5000, 5000))
        QTest.mouseRelease(canvas, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier,
                           QPoint(5000, 5000))
        c = window.current_entry().page.corners
        check(c.min() >= 0 and c.max() <= 1 and np.allclose(c[2], [1, 1]),
              "угол прижат к границе изображения")
        window.corner_editor.full_frame()
        check(np.allclose(window.current_entry().page.corners, [[0, 0], [1, 0], [1, 1], [0, 1]]),
              "«Весь кадр»")
        window.corner_editor.auto_detect()
        check(window.current_entry().page.auto_detected, "«Авто» снова нашёл документ")
        wait_until(lambda: window.renderer.is_idle() and window.page_list.thumbnails_idle(), 20,
                   "рендер после углов")
        summary.append("перетаскивание угла, лупа, ограничение, Авто/Весь кадр")

        print("4. Перестановка и выбор страниц")
        ids = window.document.ids()
        model = window.page_list.list.model()
        moved = model.moveRow(QModelIndex(), 1, QModelIndex(), 0)
        if not moved:  # запасной путь, если модель не умеет moveRows
            item = window.page_list.list.takeItem(1)
            window.page_list.list.insertItem(0, item)
            window.page_list._schedule_order_check()
        wait_until(lambda: window.document.ids() == ids[::-1], 5, "новый порядок в модели")
        check(True, f"порядок синхронизирован: {ids} -> {window.document.ids()}")
        window.page_list.select(ids[1])
        check(window.current_entry().id == ids[1], "выбор страницы в списке открывает её")
        check(window.corner_editor.canvas.has_image(), "редактор углов показывает страницу")
        wait_until(window.renderer.is_idle, 20, "рендер выбранной страницы")
        summary.append("перестановка и выбор")

        print("5. Экспорт")
        pdf_path = tmp / "результат экспорта.pdf"
        task = window.start_export_pdf(pdf_path)
        check(task is not None and window.is_busy(), "экспорт PDF запущен")
        wait_until(lambda: not window.is_busy(), 120, "экспорт PDF")
        check(not [m for m in messages if m[0] == "error"], f"без ошибок: {messages}")
        from pypdf import PdfReader
        n_pages = len(PdfReader(str(pdf_path)).pages)
        check(n_pages == 2, f"PDF содержит {n_pages} стр.")
        img_dir = tmp / "картинки"
        window.start_export_images(img_dir, "png")
        wait_until(lambda: not window.is_busy(), 120, "экспорт PNG")
        files = sorted(p.name for p in img_dir.iterdir())
        check(len(files) == 2, f"PNG: {files}")
        summary.append(f"PDF ({pdf_path.stat().st_size // 1024} КБ, {n_pages} стр.), PNG x{len(files)}")

        print("6. OCR")
        from core.ocr import check_tesseract
        status = check_tesseract()
        messages.clear()
        window.recognize_text()
        wait_until(lambda: not window.is_busy(), 120, "OCR")
        if status.ok:
            check(window.last_ocr_dialog is not None, "окно с текстом открыто")
            summary.append(f"OCR: {len(window.last_ocr_dialog.text())} символов")
        else:
            check(any(k == "error" and "Tesseract" in m for k, t, m in messages),
                  "без Tesseract показана инструкция по установке")
            summary.append("OCR: Tesseract не установлен — показана инструкция")

        print("7. Удаление")
        messages.clear()
        current = window.current_entry().id
        window.delete_current_page()
        check(len(window.document) == 1 and window.current_entry() is not None
              and window.current_entry().id != current, "страница удалена, открыта соседняя")
        window.delete_current_page()
        check(len(window.document) == 0 and window.current_entry() is None, "документ пуст")
        check(not window.export_pdf_action.isEnabled(), "экспорт выключен без страниц")
        summary.append("удаление")

        window.close()
        workers.wait_all()
        app.processEvents()
        print("\nИТОГ: OK —", "; ".join(summary))
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
