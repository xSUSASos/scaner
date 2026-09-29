# Scaner — оцифровка фото документов (аналог CamScanner для Windows)

Автопоиск листа на фото, ручная правка углов с лупой, выравнивание перспективы, фильтры
(«Магия цвета», Ч/Б, серый), многостраничность, экспорт в PDF / PDF с текстовым слоем / JPG / PNG,
распознавание текста (rus+eng).

## Установка (для пользователя)

Запустить `dist\Scaner-Setup-<версия>.exe`. Права администратора не нужны: программа ставится в
`%LOCALAPPDATA%\Programs\Scaner`, создаёт ярлыки в «Пуске» и (по желанию) на рабочем столе,
удаляется через «Параметры → Приложения». **Tesseract OCR (rus+eng) встроен** — распознавание
работает сразу, ничего дополнительно ставить не нужно.

Тихая установка: `Scaner-Setup-1.0.0.exe /VERYSILENT /CURRENTUSER /TASKS="desktopicon"`

## Мобильная версия (iPhone)

Та же обработка (порт core на OpenCV.js, результаты совпадают с десктопом) в виде PWA:
**https://xsusasos.github.io/scaner/** → в Safari «Поделиться» → «На экран Домой».
Нативная сборка `.ipa` (Capacitor) и все способы установки — в [mobile/INSTALL_IOS.md](mobile/INSTALL_IOS.md).
Код — в папке [mobile/](mobile/).

## Требования для разработки

- Windows 10/11, Python **3.12**
- Для сборки: Inno Setup 6 (`winget install JRSoftware.InnoSetup`) и установленный Tesseract
  UB Mannheim (из него `scripts\vendor_tesseract.py` берёт переносимую копию в `vendor\tesseract`).
- При запуске из исходников программа ищет Tesseract так: `vendor\tesseract` → PATH →
  `C:\Program Files\Tesseract-OCR`. Если не найден — показывает инструкцию по установке.

## Установка и запуск

```powershell
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe main.py
```

> Используйте `python -m pip` из `.venv`: «голый» `pip` в PATH может принадлежать другому Python.

## CLI (проверка обработки без GUI)

```powershell
.venv\Scripts\python.exe cli.py samples\*.jpg -o out --filter magic --debug
```

Фильтры: `original`, `magic`, `bw`, `gray`. Для Ч/Б: `--bw-block 2.5` (окно, % стороны), `--bw-c 12`.
`--debug` сохраняет карту краёв, найденный контур и выровненный кадр — удобно подбирать параметры
детекции (`DetectParams` в `core/detect.py`).

## Тесты

```powershell
.venv\Scripts\python.exe -m pytest
```

Core покрыт тестами на синтетических изображениях с известной геометрией (наклон, тень, поворот 45°,
кириллические пути, EXIF, HEIC, экспорт). Тесты настоящего OCR пропускаются, если Tesseract не установлен.

## Сборка exe и установщика

```powershell
pwsh -File build.ps1            # тесты -> vendor\tesseract -> PyInstaller -> Inno Setup
pwsh -File build.ps1 -SkipTests
```

Результат: `dist\Scaner\Scaner.exe` (папка) и `dist\Scaner-Setup-<версия>.exe` (~120 МБ).
Версия — в `version.py`. Иконка перерисовывается `scripts\make_icon.py`.

## Структура

```
core/        обработка изображений, без Qt
  imageio.py   загрузка/сохранение (кириллица, EXIF, HEIC), превью
  detect.py    поиск документа (Canny + контуры + approxPolyDP)
  geometry.py  порядок углов, перспектива
  filters.py   фильтры, яркость/контраст, поворот
  page.py      страница-«рецепт» и конвейер render()
  ocr.py       Tesseract: проверка, текст, PDF-страница с текстом
  export.py    PDF, PDF с текстом, JPG/PNG, .txt
ui/          интерфейс PySide6 (обработка в QThread)
cli.py       консольная проверка core
version.py   название и версия
build.ps1    полная сборка установщика
installer/   скрипт Inno Setup
assets/      иконка
scripts/     vendor_tesseract.py, make_icon.py, ui_smoke.py
vendor/      встроенный Tesseract (генерируется)
main.py      запуск GUI
tests/       pytest
docs/STAGES.md  что сделано на каждом этапе и почему
```

## Лицензия

Код проекта — [MIT](LICENSE).

Установщик включает сторонние компоненты со своими лицензиями: Tesseract OCR и языковые модели
tessdata (Apache 2.0), Qt / PySide6 (LGPL v3), OpenCV (Apache 2.0), NumPy (BSD), Pillow (MIT-CMU),
pillow-heif / libheif (BSD / LGPL), img2pdf (LGPL v3), pypdf (BSD).
