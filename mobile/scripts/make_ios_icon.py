"""Иконка и заставка для iOS-приложения (Capacitor).

Берём рисунок из ../../scripts/make_icon.py (десктопная иконка) и делаем:
  * AppIcon 1024x1024 — полный квадрат без прозрачности (скругление iOS рисует сама,
    прозрачные пиксели App Store/Xcode не принимают);
  * Splash 2732x2732 (3 копии, как в шаблоне Capacitor) — белый фон, иконка в центре.

Запуск из корня репозитория (нужен Pillow, он есть в десктопном venv):
    .venv\\Scripts\\python.exe mobile\\scripts\\make_ios_icon.py
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

MOBILE = Path(__file__).resolve().parents[1]
REPO = MOBILE.parent
sys.path.insert(0, str(REPO / "scripts"))
from make_icon import S, draw  # noqa: E402  (десктопный рисунок 1024x1024, RGBA)

ASSETS = MOBILE / "ios" / "App" / "App" / "Assets.xcassets"
ICON = ASSETS / "AppIcon.appiconset" / "AppIcon-512@2x.png"  # имя из Contents.json шаблона
SPLASHES = [ASSETS / "Splash.imageset" / f"splash-2732x2732{s}.png" for s in ("", "-1", "-2")]
SPLASH_BG = (255, 255, 255)  # = backgroundColor в capacitor.config.json


def full_square_icon() -> Image.Image:
    """Десктопная иконка имеет прозрачные поля вокруг скруглённого квадрата.
    Подкладываем под неё тот же градиент во весь квадрат — поля исчезают."""
    top, bottom = (38, 132, 255), (18, 76, 196)
    bg = Image.new("RGB", (S, S))
    d = ImageDraw.Draw(bg)
    for y in range(S):
        t = y / (S - 1)
        d.line([(0, y), (S, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    art = draw()
    bg.paste(art, (0, 0), art)  # альфа рисунка как маска
    return bg  # RGB — без альфа-канала


def splash(icon_rgba: Image.Image) -> Image.Image:
    size, logo = 2732, 512
    img = Image.new("RGB", (size, size), SPLASH_BG)
    small = icon_rgba.resize((logo, logo), Image.LANCZOS)
    img.paste(small, ((size - logo) // 2, (size - logo) // 2), small)
    return img


if __name__ == "__main__":
    if not ASSETS.exists():
        sys.exit(f"Нет {ASSETS}. Сначала: npx cap add ios")
    icon = full_square_icon()
    icon.save(ICON)
    print(ICON.relative_to(REPO))
    sp = splash(draw())  # на заставке — скруглённая версия с прозрачными краями
    for p in SPLASHES:
        sp.save(p, optimize=True)
        print(p.relative_to(REPO))
