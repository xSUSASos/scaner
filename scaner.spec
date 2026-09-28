# PyInstaller spec: сборка в папку dist/Scaner/ (onedir).
# Обычно запускается из build.ps1; вручную:  .venv\Scripts\pyinstaller scaner.spec --noconfirm
#
# Почему onedir, а не onefile: onefile при каждом запуске распаковывает ~300 МБ
# (Qt + OpenCV + Tesseract) во временную папку — старт 5–10 с. onedir стартует
# сразу, а в один файл его упаковывает установщик (installer/scaner.iss).

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs
from PyInstaller.utils.win32.versioninfo import (FixedFileInfo, StringFileInfo, StringStruct,
                                                 StringTable, VarFileInfo, VarStruct,
                                                 VSVersionInfo)

sys.path.insert(0, SPECPATH)
from version import APP_NAME, APP_VERSION  # noqa: E402

datas = collect_data_files("pillow_heif") + [("assets/icon.png", "assets")]
binaries = collect_dynamic_libs("pillow_heif")

# Встроенный Tesseract (готовится scripts/vendor_tesseract.py). Кладётся в _internal/tesseract,
# core.ocr.bundled_tesseract_dir() ищет его там.
if Path(SPECPATH, "vendor", "tesseract", "tesseract.exe").is_file():
    datas.append(("vendor/tesseract", "tesseract"))
else:
    print("ВНИМАНИЕ: vendor/tesseract не найден — сборка без встроенного OCR")

a = Analysis(
    ["main.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=["pillow_heif"],
    excludes=[
        # Не используются, но хуки иногда их подтягивают — минус десятки МБ.
        "tkinter", "matplotlib", "IPython", "pytest", "pefile",
        "PySide6.QtWebEngineCore", "PySide6.QtWebEngineWidgets", "PySide6.QtQml",
        "PySide6.QtQuick", "PySide6.Qt3DCore", "PySide6.QtMultimedia", "PySide6.QtCharts",
        "PySide6.QtDataVisualization", "PySide6.QtPdf", "PySide6.QtNetwork",
    ],
    noarchive=False,
)

# Лишние DLL, которые хуки подтягивают целиком (~60 МБ):
#  ffmpeg — видео в OpenCV; opengl32sw — программный OpenGL (QtWidgets без него работает);
#  Qt Quick/QML/PDF/виртуальная клавиатура — модули, которые мы не используем.
DROP = ("opencv_videoio_ffmpeg", "opengl32sw", "qt6quick", "qt6qml", "qt6pdf",
        "qt6virtualkeyboard", "qt6network")
a.binaries = [b for b in a.binaries if not any(d in b[0].lower() for d in DROP)]

pyz = PYZ(a.pure)

# Ресурс версии — виден в «Свойства -> Подробно» у Scaner.exe.
nums = tuple(int(x) for x in APP_VERSION.split(".")) + (0,)
version_info = VSVersionInfo(
    ffi=FixedFileInfo(filevers=nums, prodvers=nums),
    kids=[
        StringFileInfo([StringTable("041904B0", [
            StringStruct("FileDescription", APP_NAME),
            StringStruct("ProductName", APP_NAME),
            StringStruct("FileVersion", APP_VERSION),
            StringStruct("ProductVersion", APP_VERSION),
            StringStruct("OriginalFilename", "Scaner.exe"),
        ])]),
        VarFileInfo([VarStruct("Translation", [0x0419, 1200])]),
    ],
)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Scaner",
    icon="assets/icon.ico",
    version=version_info,
    console=False,          # GUI-приложение: без чёрного окна консоли
    upx=False,              # UPX часто ломает Qt-DLL и триггерит антивирусы
)
coll = COLLECT(exe, a.binaries, a.datas, name="Scaner", upx=False)
