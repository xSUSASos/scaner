"""CLI для проверки core на реальных фото без GUI.

Примеры:
    python cli.py samples/*.jpg -o out
    python cli.py фото.heic -o out --filter bw --bw-block 3 --bw-c 15 --debug

С --debug рядом с результатом сохраняются промежуточные шаги:
    *_1_edges_canny.png / *_1_edges_otsu.png  — карта краёв, по которой искали контур
    *_2_contour.jpg                            — найденный 4-угольник поверх превью
    *_3_warped.jpg                             — после выравнивания перспективы (до фильтра)
"""
from __future__ import annotations

import argparse
import glob
import sys
import time
from pathlib import Path

import cv2
import numpy as np

from core.detect import detect_document
from core.filters import FilterMode, FilterSettings
from core.geometry import to_pixels, warp_document
from core.imageio import ImageLoadError, load_image, make_preview, save_image
from core.page import Page, render


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Сканирование фото документов (проверка core).")
    p.add_argument("inputs", nargs="+", help="файлы изображений (можно маски *.jpg)")
    p.add_argument("-o", "--out", default="out", help="папка для результатов (по умолчанию out)")
    p.add_argument("--filter", choices=[m.value for m in FilterMode], default=FilterMode.MAGIC.value)
    p.add_argument("--bw-block", type=float, default=FilterSettings.bw_block_percent,
                   help="Ч/Б: окно порога, %% длинной стороны")
    p.add_argument("--bw-c", type=int, default=FilterSettings.bw_c, help="Ч/Б: константа C")
    p.add_argument("--brightness", type=int, default=0)
    p.add_argument("--contrast", type=int, default=0)
    p.add_argument("--rotate", type=int, default=0, help="поворот, четверти по часовой")
    p.add_argument("--format", choices=["jpg", "png"], default="jpg")
    p.add_argument("--debug", action="store_true", help="сохранить промежуточные шаги")
    return p.parse_args(argv)


def expand(inputs: list[str]) -> list[Path]:
    # PowerShell не раскрывает маски сам — делаем это здесь.
    paths: list[Path] = []
    for item in inputs:
        matches = glob.glob(item) if any(ch in item for ch in "*?[") else [item]
        paths.extend(Path(m) for m in sorted(matches))
    return paths


def draw_contour(preview: np.ndarray, corners: np.ndarray, found: bool) -> np.ndarray:
    vis = preview.copy()
    pts = to_pixels(corners, preview.shape).round().astype(np.int32)
    color = (0, 200, 0) if found else (0, 0, 255)
    cv2.polylines(vis, [pts], True, color, 3)
    for (x, y), name in zip(pts, ("TL", "TR", "BR", "BL")):
        cv2.circle(vis, (int(x), int(y)), 8, color, -1)
        cv2.putText(vis, name, (int(x) + 10, int(y) - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
    return vis


def process(path: Path, args: argparse.Namespace, out_dir: Path) -> bool:
    t0 = time.perf_counter()
    try:
        original = load_image(path)
    except ImageLoadError as e:
        print(f"[ОШИБКА] {e}")
        return False
    preview = make_preview(original)

    debug: dict = {}
    result = detect_document(preview, debug=debug)
    page = Page(source_path=path, corners=result.corners, auto_detected=result.found,
                filter=FilterSettings(mode=FilterMode(args.filter), bw_block_percent=args.bw_block,
                                      bw_c=args.bw_c, brightness=args.brightness,
                                      contrast=args.contrast),
                rotation=args.rotate)
    out = render(page, original)  # финал — на оригинале

    stem = path.stem
    save_image(out_dir / f"{stem}.{args.format}", out)
    if args.debug:
        for key, img in debug.items():
            if key.startswith("edges_"):
                save_image(out_dir / f"{stem}_1_{key}.png", img)
        save_image(out_dir / f"{stem}_2_contour.jpg", draw_contour(preview, result.corners, result.found))
        save_image(out_dir / f"{stem}_3_warped.jpg", warp_document(preview, result.corners))

    h, w = original.shape[:2]
    how = f"найден ({debug.get('strategy')})" if result.found else "НЕ найден, рамка по краям"
    print(f"{path.name}: {w}x{h} ({w * h / 1e6:.1f} Мп), документ {how}, "
          f"результат {out.shape[1]}x{out.shape[0]}, {time.perf_counter() - t0:.2f} с")
    return True


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    paths = expand(args.inputs)
    if not paths:
        print("Нет входных файлов.")
        return 2
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    ok = sum(process(p, args, out_dir) for p in paths)
    print(f"Готово: {ok}/{len(paths)} -> {out_dir.resolve()}")
    return 0 if ok == len(paths) else 1


if __name__ == "__main__":
    # Консоль Windows может быть не в UTF-8 — не падаем на кириллице в print.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
