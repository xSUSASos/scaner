"""Нарисовать иконку приложения: лист документа в «рамке сканера».

Рисуем в 1024 px и уменьшаем (сглаживание бесплатно), .ico содержит 16..256 px.
Запуск: python scripts/make_icon.py  ->  assets/icon.ico, assets/icon.png
"""
from pathlib import Path

from PIL import Image, ImageDraw

S = 1024
OUT = Path(__file__).resolve().parents[1] / "assets"


def draw() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Фон: скруглённый квадрат с вертикальным градиентом.
    grad = Image.new("RGBA", (S, S))
    top, bottom = (38, 132, 255), (18, 76, 196)
    for y in range(S):
        t = y / (S - 1)
        grad.paste(tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,), (0, y, S, y + 1))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((32, 32, S - 32, S - 32), radius=200, fill=255)
    img.paste(grad, (0, 0), mask)

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
        d.rounded_rectangle(sorted_box(cx, cy, cx + sx * L, cy + sy * w), radius=w // 2, fill=(255, 214, 64))
        d.rounded_rectangle(sorted_box(cx, cy, cx + sx * w, cy + sy * L), radius=w // 2, fill=(255, 214, 64))
    return img


def sorted_box(xa, ya, xb, yb):
    return (min(xa, xb), min(ya, yb), max(xa, xb), max(ya, yb))


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    icon = draw().resize((256, 256), Image.LANCZOS)
    icon.save(OUT / "icon.png")
    icon.save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("assets/icon.ico, assets/icon.png")
