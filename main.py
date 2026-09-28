"""Точка входа: python main.py [файлы...]

Ресурсы и модули ищутся относительно этого файла (или папки сборки
PyInstaller), а не текущей рабочей папки — программу можно запускать откуда угодно.
"""
from __future__ import annotations

import sys
from pathlib import Path


def _app_dir() -> Path:
    # В сборке PyInstaller код лежит во временной папке sys._MEIPASS.
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent


def main() -> int:
    app_dir = str(_app_dir())
    if app_dir not in sys.path:
        sys.path.insert(0, app_dir)

    # Импорты Qt — внутри main(): `import main` не должен создавать окон.
    from PySide6.QtGui import QIcon
    from PySide6.QtWidgets import QApplication

    from ui.main_window import MainWindow

    if sys.platform == "win32":
        # Свой AppUserModelID — иначе Windows группирует окно на панели задач
        # с python.exe и показывает его иконку, а не нашу.
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Scaner.DocumentScanner")

    app = QApplication(sys.argv)
    from version import APP_NAME, APP_VERSION
    app.setApplicationName(APP_NAME)
    app.setApplicationVersion(APP_VERSION)
    app.setWindowIcon(QIcon(str(_app_dir() / "assets" / "icon.png")))
    window = MainWindow()
    window.show()
    files = [a for a in sys.argv[1:] if not a.startswith("-")]
    if files:  # например, «Открыть с помощью» или перетаскивание на ярлык
        window.add_files(files)
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
