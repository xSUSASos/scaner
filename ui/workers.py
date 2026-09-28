"""Фоновые задачи в отдельных потоках (QThread).

Зачем: обработка 50-Мп снимка занимает секунды. Если делать её прямо в
обработчике кнопки, GUI-поток не успевает перерисовывать окно — программа
«зависает». Поэтому тяжёлая работа уходит в рабочий поток, а результат
возвращается сигналом.

Почему потоки, а не процессы: numpy и OpenCV отпускают GIL внутри своих
C-функций, так что Python-потоки реально работают параллельно с GUI,
а массивы передаются без копирования между процессами.

Правила, которые соблюдает этот модуль:
1. Рабочий поток НИКОГДА не трогает виджеты — только считает и шлёт сигналы.
2. Сигналы из рабочего потока принимает объект Task, который живёт в
   GUI-потоке. Qt видит, что отправитель и получатель в разных потоках, и
   доставляет сигнал через очередь событий GUI-потока (QueuedConnection).
   Поэтому пользовательские обработчики (on_done и т.п.) всегда выполняются
   в GUI-потоке и могут спокойно менять интерфейс.
3. Пока поток работает, на Task должна быть ссылка — иначе сборщик мусора
   удалит QThread посреди работы и приложение упадёт. Ссылки держит
   множество _active.
"""
from __future__ import annotations

import threading
import traceback
from collections.abc import Callable
from typing import Any

from PySide6.QtCore import QObject, QThread, Signal, Slot


class Cancelled(Exception):
    """Пользователь нажал «Отмена». Бросается из колбэка прогресса."""


def is_expected_error(exc: BaseException) -> bool:
    """Ошибка «из жизни» (нет файла, нет Tesseract), а не баг в программе."""
    return (isinstance(exc, (OSError, ValueError, MemoryError))
            or type(exc).__name__ in {"ImageLoadError", "TesseractNotFoundError"})


def describe_error(exc: BaseException) -> str:
    """Понятный текст ошибки для окна сообщения."""
    from core.imageio import ImageLoadError
    try:
        from core.ocr import TesseractNotFoundError
    except ImportError:  # модуль OCR может отсутствовать — остальное должно работать
        TesseractNotFoundError = ()  # isinstance(x, ()) всегда False

    if isinstance(exc, (ImageLoadError, TesseractNotFoundError)):
        return str(exc)  # у этих исключений текст уже на русском и с подсказкой
    if isinstance(exc, PermissionError):
        return f"Нет доступа к файлу или папке:\n{exc.filename or exc}"
    if isinstance(exc, OSError):
        return f"Ошибка чтения/записи файла:\n{exc}"
    if isinstance(exc, MemoryError):
        return "Недостаточно памяти для обработки изображения."
    if isinstance(exc, ValueError):
        return str(exc)
    return f"Непредвиденная ошибка ({type(exc).__name__}):\n{exc}"


class Worker(QObject):
    """Выполняет функцию fn(*args, **kwargs) в потоке, куда его переместили."""

    finished = Signal(object)   # результат fn
    failed = Signal(str)        # текст ошибки для пользователя
    progress = Signal(int, int)  # (сделано, всего)
    cancelled = Signal()

    def __init__(self, fn: Callable[..., Any], *args, **kwargs):
        super().__init__()
        self._fn, self._args, self._kwargs = fn, args, kwargs
        # threading.Event, а не bool: флаг пишет GUI-поток, читает рабочий.
        self._cancel = threading.Event()

    def request_cancel(self) -> None:
        self._cancel.set()

    def report_progress(self, done: int, total: int) -> None:
        """Колбэк progress для долгих функций (вызывается в рабочем потоке).

        Заодно это «точка отмены»: прервать чужую функцию снаружи нельзя,
        но она регулярно зовёт progress — тут мы и выбрасываем Cancelled.
        """
        if self._cancel.is_set():
            raise Cancelled()
        self.progress.emit(done, total)

    @Slot()
    def run(self) -> None:
        try:
            result = self._fn(*self._args, **self._kwargs)
        except Cancelled:
            self.cancelled.emit()
        except Exception as exc:  # noqa: BLE001 — любую ошибку показываем пользователю
            if not is_expected_error(exc):
                traceback.print_exc()  # неожиданная ошибка — подробности в консоль
            self.failed.emit(describe_error(exc))
        else:
            self.finished.emit(result)
        finally:
            # Останавливаем цикл событий потока прямо отсюда, а не из GUI-потока:
            # так wait_all() дождётся потока, даже если GUI-поток сейчас занят.
            QThread.currentThread().quit()


# Задачи, у которых ещё работает поток (защита от сборщика мусора).
_active: set["Task"] = set()


class Task(QObject):
    """«Пульт» фоновой задачи. Живёт в GUI-потоке, его сигналы — тоже в GUI-потоке."""

    finished = Signal(object)
    failed = Signal(str)
    progress = Signal(int, int)
    cancelled = Signal()

    def __init__(self, fn: Callable[..., Any], *args, pass_progress: bool = False, **kwargs):
        super().__init__()
        self._worker = Worker(fn, *args, **kwargs)
        if pass_progress:
            self._worker._kwargs["progress"] = self._worker.report_progress
        self._thread = QThread()
        self._running = False
        # moveToThread: слот run() будет выполняться в self._thread.
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(self._worker.run)
        self._worker.finished.connect(self._on_finished)
        self._worker.failed.connect(self._on_failed)
        self._worker.progress.connect(self._on_progress)
        self._worker.cancelled.connect(self._on_cancelled)
        self._thread.finished.connect(self._on_thread_finished)

    def start(self) -> "Task":
        _active.add(self)
        self._running = True
        self._thread.start()
        return self

    def cancel(self) -> None:
        self._worker.request_cancel()

    def is_running(self) -> bool:
        return self._running

    def wait(self, timeout_ms: int) -> bool:
        return self._thread.wait(timeout_ms)

    # --- слоты: вызываются в GUI-потоке ---
    @Slot(object)
    def _on_finished(self, result: object) -> None:
        self.finished.emit(result)

    @Slot(str)
    def _on_failed(self, message: str) -> None:
        self.failed.emit(message)

    @Slot(int, int)
    def _on_progress(self, done: int, total: int) -> None:
        self.progress.emit(done, total)

    @Slot()
    def _on_cancelled(self) -> None:
        self.cancelled.emit()

    @Slot()
    def _on_thread_finished(self) -> None:
        self._running = False
        _active.discard(self)


def run_task(fn: Callable[..., Any], *args,
             on_done: Callable[[Any], None] | None = None,
             on_error: Callable[[str], None] | None = None,
             on_progress: Callable[[int, int], None] | None = None,
             on_cancel: Callable[[], None] | None = None,
             pass_progress: bool = False, **kwargs) -> Task:
    """Запустить fn(*args, **kwargs) в фоне.

    pass_progress=True — fn получит именованный аргумент progress(done, total),
    через который сообщает о ходе работы и может быть отменена (Task.cancel()).
    Все on_* вызываются в GUI-потоке.
    """
    task = Task(fn, *args, pass_progress=pass_progress, **kwargs)
    if on_done:
        task.finished.connect(on_done)
    if on_error:
        task.failed.connect(on_error)
    if on_progress:
        task.progress.connect(on_progress)
    if on_cancel:
        task.cancelled.connect(on_cancel)
    return task.start()


def active_count() -> int:
    return len(_active)


def wait_all(timeout_ms: int = 5000) -> None:
    """Перед выходом: попросить задачи остановиться и дождаться потоков.
    Иначе Qt аварийно завершит программу («QThread destroyed while running»)."""
    for task in list(_active):
        task.cancel()
    for task in list(_active):
        task.wait(timeout_ms)
