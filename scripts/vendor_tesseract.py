r"""Собрать переносимую копию Tesseract в vendor/tesseract (для встраивания в приложение).

Берём установленную сборку UB Mannheim и копируем только то, что нужно для
распознавания: tesseract.exe + DLL из его транзитивных зависимостей (считаем
по таблице импорта PE-файлов) + configs/pdf.ttf. Утилиты обучения моделей
(~150 МБ) не нужны. Языковые модели rus/eng кладутся в vendor/tesseract/tessdata отдельно.

Запуск: python scripts/vendor_tesseract.py ["C:\Program Files\Tesseract-OCR"]
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pefile

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else r"C:\Program Files\Tesseract-OCR")
DST = Path(__file__).resolve().parents[1] / "vendor" / "tesseract"


def dll_closure(exe: Path) -> set[str]:
    """Все DLL из папки SRC, от которых транзитивно зависит exe (системные не трогаем)."""
    local = {p.name.lower(): p for p in SRC.glob("*.dll")}
    seen: set[str] = set()
    stack = [exe]
    while stack:
        pe = pefile.PE(str(stack.pop()), fast_load=True)
        pe.parse_data_directories(directories=[
            pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"],
            pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT"]])
        entries = getattr(pe, "DIRECTORY_ENTRY_IMPORT", []) + getattr(pe, "DIRECTORY_ENTRY_DELAY_IMPORT", [])
        for entry in entries:
            name = entry.dll.decode().lower()
            if name in local and name not in seen:
                seen.add(name)
                stack.append(local[name])
        pe.close()
    return {local[n].name for n in seen}


def main() -> None:
    exe = SRC / "tesseract.exe"
    if not exe.is_file():
        sys.exit(f"Не найден {exe}")
    DST.mkdir(parents=True, exist_ok=True)
    shutil.copy2(exe, DST)
    dlls = sorted(dll_closure(exe))
    for name in dlls:
        shutil.copy2(SRC / name, DST)
    tessdata = DST / "tessdata"
    tessdata.mkdir(exist_ok=True)
    # configs/pdf нужен для вывода PDF, pdf.ttf — «невидимый» шрифт текстового слоя.
    shutil.copytree(SRC / "tessdata" / "configs", tessdata / "configs", dirs_exist_ok=True)
    shutil.copy2(SRC / "tessdata" / "pdf.ttf", tessdata)
    size = sum(p.stat().st_size for p in DST.rglob("*") if p.is_file()) / 1e6
    print(f"DLL: {len(dlls)}; vendor/tesseract: {size:.0f} МБ")
    missing = [l for l in ("rus", "eng") if not (tessdata / f"{l}.traineddata").exists()]
    if missing:
        print("Нет языковых моделей:", ", ".join(missing),
              "— скачайте из https://github.com/tesseract-ocr/tessdata в", tessdata)


if __name__ == "__main__":
    main()
