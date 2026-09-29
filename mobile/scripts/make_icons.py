"""Иконки PWA: лист документа в «рамке сканера» (как scripts/make_icon.py десктопа).

Запуск (из папки mobile):  ..\\.venv\\Scripts\\python.exe scripts\\make_icons.py
Результат: icons/icon-180.png (apple-touch-icon), icon-192.png, icon-512.png,
icon-maskable-512.png.

Три вида:
- iOS (180): полный квадрат без прозрачности — iOS сам скругляет углы, а
  прозрачные пиксели заливает ЧЁРНЫМ.
- any (192, 512): скруглённый квадрат с прозрачным фоном, как в десктопе.
- maskable (512): фон до краёв, рисунок уменьшен в «безопасный круг» (80% в
  центре) — Android обрезает иконку кругом, каплей и т.п.
"""
from pathlib import Path

from PIL import Image, ImageDraw

S = 1024
OUT = Path(__file__).resolve().parents[1] / "icons"
TOP, BOTTOM = (38, 132, 255), (18, 76, 196)  # #2684FF -> #124CC4
YELLOW = (255, 214, 64)


def gradient() -> Image.Image:
    grad = Image.new("RGBA", (S, S))
    for y in range(S):
        t = y / (S - 1)
        grad.paste(tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)) + (255,), (0, y, S, y + 1))
    return grad


def sorted_box(xa, ya, xb, yb):
    return (min(xa, xb), min(ya, yb), max(xa, xb), max(ya, yb))


def draw_content(scale: float = 1.0) -> Image.Image:
    """Лист и уголки рамки на прозрачном фоне; scale < 1 — ужать к центру."""
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Лист с загнутым уголком.
    x0, y0, x1, y1, fold = 300, 230, 724, 794, 110
    d.polygon([(x0, y0), (x1 - fold, y0), (x1, y0 + fold), (x1, y1), (x0, y1)], fill=(255, 255, 255))
    d.polygon([(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)], fill=(200, 216, 240))
    for i, y in enumerate(range(y0 + 170, y1 - 60, 72)):  # строки текста
        right = x1 - 70 if i % 3 != 2 else x1 - 170
        d.rounded_rectangle((x0 + 60, y, right, y + 26), radius=13, fill=(120, 150, 200))
    # Уголки рамки сканера.
    w, L, m = 44, 150, 150
    for cx, cy, sx, sy in ((m, m, 1, 1), (S - m, m, -1, 1), (m, S - m, 1, -1), (S - m, S - m, -1, -1)):
        d.rounded_rectangle(sorted_box(cx, cy, cx + sx * L, cy + sy * w), radius=w // 2, fill=YELLOW)
        d.rounded_rectangle(sorted_box(cx, cy, cx + sx * w, cy + sy * L), radius=w // 2, fill=YELLOW)
    if scale != 1.0:
        size = round(S * scale)
        small = layer.resize((size, size), Image.LANCZOS)
        layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        layer.paste(small, ((S - size) // 2, (S - size) // 2), small)
    return layer


def full_square(scale: float) -> Image.Image:
    """Фон до краёв без прозрачности (iOS и maskable)."""
    img = gradient()
    img.alpha_composite(draw_content(scale))
    return img.convert("RGB")


def rounded() -> Image.Image:
    """Скруглённый квадрат с прозрачными углами (purpose: any)."""
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((32, 32, S - 32, S - 32), radius=200, fill=255)
    img.paste(gradient(), (0, 0), mask)
    img.alpha_composite(draw_content())
    return img


def save(img: Image.Image, name: str, size: int) -> None:
    img.resize((size, size), Image.LANCZOS).save(OUT / name, optimize=True)
    print(f"icons/{name}")


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    # Уголки рамки доходят до 50% радиуса от центра; безопасный круг maskable — 40%.
    # 0.78 ужимает рисунок так, что уголки остаются внутри круга.
    save(full_square(1.0), "icon-180.png", 180)
    save(rounded(), "icon-192.png", 192)
    save(rounded(), "icon-512.png", 512)
    save(full_square(0.78), "icon-maskable-512.png", 512)
