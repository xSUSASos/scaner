# Полная сборка: тесты -> встроенный Tesseract -> exe (PyInstaller) -> установщик (Inno Setup).
# Запуск из корня проекта:  pwsh -File build.ps1   [-SkipTests]
# Результат: dist\Scaner\Scaner.exe (папка) и dist\Scaner-Setup-<версия>.exe (установщик).
param([switch]$SkipTests)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$py = ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { throw "Нет .venv. Создайте: py -3.12 -m venv .venv; .venv\Scripts\python.exe -m pip install -r requirements.txt" }

$version = & $py -c "from version import APP_VERSION; print(APP_VERSION)"
Write-Host "== Сборка версии $version" -ForegroundColor Cyan

if (-not $SkipTests) {
    Write-Host "== Тесты" -ForegroundColor Cyan
    & $py -m pytest -q
    if ($LASTEXITCODE) { throw "Тесты не прошли" }
}

# Встроенный Tesseract: копия из установленного UB Mannheim + модели rus/eng.
if (-not (Test-Path "vendor\tesseract\tesseract.exe")) {
    Write-Host "== Подготовка встроенного Tesseract" -ForegroundColor Cyan
    & $py scripts\vendor_tesseract.py
    if ($LASTEXITCODE) { throw "Не удалось подготовить Tesseract (установлен ли он в C:\Program Files\Tesseract-OCR?)" }
}
foreach ($lang in "rus", "eng") {
    $f = "vendor\tesseract\tessdata\$lang.traineddata"
    if (-not (Test-Path $f)) {
        Write-Host "Скачиваю $lang.traineddata" -ForegroundColor Yellow
        Invoke-WebRequest "https://github.com/tesseract-ocr/tessdata/raw/main/$lang.traineddata" -OutFile $f
    }
}

Write-Host "== PyInstaller" -ForegroundColor Cyan
& $py -m PyInstaller scaner.spec --noconfirm --log-level WARN
if ($LASTEXITCODE) { throw "PyInstaller завершился с ошибкой" }

Write-Host "== Установщик (Inno Setup)" -ForegroundColor Cyan
$iscc = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 не найден. Установите: winget install JRSoftware.InnoSetup" }
& $iscc /Q "/DAppVersion=$version" installer\scaner.iss
if ($LASTEXITCODE) { throw "Inno Setup завершился с ошибкой" }

$setup = Get-Item "dist\Scaner-Setup-$version.exe"
Write-Host ("== Готово: {0} ({1:N0} МБ)" -f $setup.FullName, ($setup.Length / 1MB)) -ForegroundColor Green
