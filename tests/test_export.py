from __future__ import annotations

import numpy as np
import pytest
from pypdf import PdfReader

from core.export import A4_LONG_SIDE_INCH, auto_dpi, export_images, export_pdf, is_binary, save_text
from core.imageio import load_image

A4_LONG_PT = A4_LONG_SIDE_INCH * 72


def _color(h=1754, w=1240) -> np.ndarray:
    rng = np.random.default_rng(0)
    img = np.full((h, w, 3), 230, np.uint8)
    img[100:300, 100:600] = rng.integers(0, 255, (200, 500, 3), dtype=np.uint8)
    return img


def _gray(h=1754, w=1240) -> np.ndarray:
    return np.tile(np.linspace(0, 255, w, dtype=np.uint8), (h, 1))


def _binary(h=1754, w=1240) -> np.ndarray:
    img = np.full((h, w), 255, np.uint8)
    img[200:260, 100:1100] = 0
    return img


@pytest.fixture
def out_dir(tmp_path):
    d = tmp_path / "папка экспорта"
    d.mkdir()
    return d


def test_auto_dpi():
    assert auto_dpi(np.zeros((1754, 1240), np.uint8)) == 150   # A4 при 150 dpi
    assert auto_dpi(np.zeros((1240, 1754, 3), np.uint8)) == 150  # альбомная — та же
    assert auto_dpi(np.zeros((3508, 2480), np.uint8)) == 300
    assert auto_dpi(np.zeros((10, 10), np.uint8)) == 72         # нижняя граница
    assert auto_dpi(np.zeros((20000, 100), np.uint8)) == 1200   # верхняя граница


def test_is_binary():
    assert is_binary(_binary())
    assert not is_binary(_gray())
    assert not is_binary(_color())


def test_export_pdf_pages_and_size(out_dir):
    progress: list[tuple[int, int]] = []
    pages = [_color(), _gray(), _binary(), _color(1240, 1754)]
    path = export_pdf(pages, out_dir / "документ.pdf", progress=lambda d, t: progress.append((d, t)))

    assert path.is_file()
    reader = PdfReader(path)
    assert len(reader.pages) == 4
    for page in reader.pages:
        w, h = float(page.mediabox.width), float(page.mediabox.height)
        assert max(w, h) == pytest.approx(A4_LONG_PT, rel=0.02)
    # Последняя страница альбомная.
    last = reader.pages[3].mediabox
    assert float(last.width) > float(last.height)
    assert progress == [(1, 4), (2, 4), (3, 4), (4, 4)]


def test_export_pdf_consumes_generator_lazily(out_dir):
    produced: list[int] = []
    progress: list[int] = []

    def gen():
        for i in range(3):
            # Страница i+1 создаётся только после того, как страница i закодирована.
            assert len(progress) == i
            produced.append(i)
            yield _binary() if i == 1 else _color()

    path = export_pdf(gen(), out_dir / "ген.pdf", total=3,
                      progress=lambda d, t: progress.append(d))
    assert produced == [0, 1, 2]
    assert len(PdfReader(path).pages) == 3


def test_export_pdf_empty_raises(out_dir):
    with pytest.raises(ValueError):
        export_pdf(iter([]), out_dir / "пусто.pdf")


@pytest.mark.parametrize("fmt", ["jpg", "png"])
def test_export_images(out_dir, fmt):
    pages = [_color(), _gray(), _binary()]
    progress: list[tuple[int, int]] = []
    files = export_images((p for p in pages), out_dir / "страницы", "скан", fmt=fmt, total=3,
                          progress=lambda d, t: progress.append((d, t)))

    assert [f.name for f in files] == [f"скан_00{i}.{fmt}" for i in (1, 2, 3)]
    for f, src in zip(files, pages):
        img = load_image(f)
        assert img.shape[:2] == src.shape[:2]
    assert progress == [(1, 3), (2, 3), (3, 3)]


def test_save_text(out_dir):
    path = save_text("Привет мир\nHello", out_dir / "текст.txt")
    assert path.read_bytes() == "Привет мир\nHello".encode("utf-8")
