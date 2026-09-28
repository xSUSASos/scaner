import io

import numpy as np
import pytest
from PIL import Image, ImageOps

from core.imageio import (ImageLoadError, apply_exif_orientation, load_image, make_preview,
                          save_image)


def quadrant_image(w=64, h=40) -> np.ndarray:
    """4 цветных квадранта — по ним однозначно видно поворот/отражение."""
    img = np.zeros((h, w, 3), np.uint8)
    img[: h // 2, : w // 2] = (0, 0, 255)
    img[: h // 2, w // 2:] = (0, 255, 0)
    img[h // 2:, : w // 2] = (255, 0, 0)
    img[h // 2:, w // 2:] = (255, 255, 255)
    return img


@pytest.mark.parametrize("ext", [".png", ".jpg"])
def test_roundtrip_cyrillic_path(cyr_dir, ext):
    img = quadrant_image()
    path = cyr_dir / f"страница{ext}"
    save_image(path, img)
    loaded = load_image(path)
    assert loaded.shape == img.shape
    assert np.abs(loaded.astype(int) - img).mean() < 8  # JPEG — с потерями


def test_save_grayscale(cyr_dir):
    gray = np.tile(np.arange(256, dtype=np.uint8), (10, 1))
    save_image(cyr_dir / "серый.png", gray)
    assert load_image(cyr_dir / "серый.png").shape == (10, 256, 3)


@pytest.mark.parametrize("orientation", range(1, 9))
def test_exif_orientation_matches_pillow(cyr_dir, orientation):
    """Наш поворот по EXIF должен совпадать с эталонным ImageOps.exif_transpose."""
    rgb = quadrant_image()[:, :, ::-1]
    pil = Image.fromarray(np.ascontiguousarray(rgb))
    exif = Image.Exif()
    exif[0x0112] = orientation
    path = cyr_dir / f"exif_{orientation}.jpg"
    buf = io.BytesIO()
    pil.save(buf, "JPEG", quality=100, exif=exif.tobytes())
    path.write_bytes(buf.getvalue())

    with Image.open(path) as im:
        expected = np.asarray(ImageOps.exif_transpose(im).convert("RGB"))[:, :, ::-1]
    loaded = load_image(path)
    assert loaded.shape == expected.shape
    assert np.abs(loaded.astype(int) - expected).mean() < 3


def test_apply_exif_orientation_identity():
    img = quadrant_image()
    assert apply_exif_orientation(img, 1) is img


def test_heic_roundtrip(cyr_dir):
    pillow_heif = pytest.importorskip("pillow_heif")
    rgb = quadrant_image(128, 96)[:, :, ::-1]
    path = cyr_dir / "фото.heic"
    try:
        pillow_heif.from_bytes(mode="RGB", size=(128, 96),
                               data=np.ascontiguousarray(rgb).tobytes()).save(str(path), quality=95)
    except Exception as e:  # сборка без HEVC-энкодера
        pytest.skip(f"HEIC encoder unavailable: {e}")
    loaded = load_image(path)
    assert loaded.shape == (96, 128, 3)
    assert np.abs(loaded.astype(int) - quadrant_image(128, 96)).mean() < 12


def test_load_errors(cyr_dir):
    with pytest.raises(ImageLoadError):
        load_image(cyr_dir / "нет_файла.jpg")
    bad = cyr_dir / "битый.jpg"
    bad.write_bytes(b"not an image at all")
    with pytest.raises(ImageLoadError):
        load_image(bad)


def test_make_preview():
    big = np.zeros((4000, 6000, 3), np.uint8)
    prev = make_preview(big, 1600)
    assert max(prev.shape[:2]) == 1600
    assert prev.shape[:2] == (1067, 1600)
    small = np.zeros((100, 50, 3), np.uint8)
    assert make_preview(small).shape == small.shape  # не увеличиваем
