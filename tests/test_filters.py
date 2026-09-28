import cv2
import numpy as np
import pytest

from conftest import make_sheet
from core.filters import (FilterMode, FilterSettings, apply_filter, brightness_contrast,
                          bw_document, magic_color, rotate90, to_gray)


def shadowed_sheet() -> np.ndarray:
    """Лист с сильной тенью: правая половина темнее на 50%."""
    sheet = make_sheet().astype(np.float32)
    ramp = np.linspace(1.0, 0.5, sheet.shape[1], dtype=np.float32)[None, :, None]
    return (sheet * ramp).astype(np.uint8)


def paper_mask(sheet: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(make_sheet(), cv2.COLOR_BGR2GRAY) > 200


def test_magic_removes_shadow():
    img = shadowed_sheet()
    out = cv2.cvtColor(magic_color(img), cv2.COLOR_BGR2GRAY)
    paper = paper_mask(img)
    w = img.shape[1]
    left = out[:, : w // 4][paper[:, : w // 4]].mean()
    right = out[:, -w // 4:][paper[:, -w // 4:]].mean()
    assert left > 235 and right > 235          # бумага белая по всему листу
    assert out[~paper].mean() < 80              # текст остался тёмным


def test_magic_keeps_color():
    out = magic_color(make_sheet())
    b, g, r = out[40:65, 85:300].reshape(-1, 3).mean(axis=0)  # красный заголовок
    assert r > b + 40 and r > g + 40


def test_bw_is_binary_and_handles_shadow():
    img = shadowed_sheet()
    out = bw_document(img)
    assert out.ndim == 2 and set(np.unique(out)) <= {0, 255}
    paper = paper_mask(img)
    assert (out[paper] == 255).mean() > 0.97     # тень не почернела
    assert (out[~paper] == 0).mean() > 0.7       # текст чёрный


def test_bw_resolution_independent():
    """Ч/Б на превью и на увеличенной копии должны выглядеть одинаково."""
    img = shadowed_sheet()
    small = bw_document(img)
    big = bw_document(cv2.resize(img, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC))
    big_down = cv2.resize(big, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_AREA)
    assert np.mean(np.abs(big_down.astype(int) - small) > 127) < 0.03


def test_bw_c_controls_background():
    img = shadowed_sheet()
    low, high = bw_document(img, c=2), bw_document(img, c=30)
    assert (high == 255).mean() >= (low == 255).mean()


def test_gray():
    out = apply_filter(make_sheet(), FilterSettings(mode=FilterMode.GRAY))
    assert out.ndim == 2
    assert to_gray(out) is out


def test_original_is_untouched():
    img = make_sheet()
    assert apply_filter(img, FilterSettings(mode=FilterMode.ORIGINAL)) is img


def test_brightness_contrast():
    img = np.array([[0, 64, 128, 192, 255]], np.uint8)
    assert np.array_equal(brightness_contrast(img, 0, 0), img)
    brighter = brightness_contrast(img, 50, 0)
    assert (brighter >= img).all() and brighter[0, 1] > img[0, 1]
    flat = brightness_contrast(img, 0, -100)
    assert flat.max() - flat.min() <= 1
    steep = brightness_contrast(img, 0, 100)
    assert steep[0, 1] < img[0, 1] and steep[0, 3] > img[0, 3]


@pytest.mark.parametrize("turns,shape", [(0, (2, 3)), (1, (3, 2)), (2, (2, 3)), (3, (3, 2)), (4, (2, 3))])
def test_rotate90(turns, shape):
    img = np.arange(6, dtype=np.uint8).reshape(2, 3)
    assert rotate90(img, turns).shape == shape


def test_rotate90_clockwise_direction():
    img = np.array([[1, 2], [3, 4]], np.uint8)
    assert np.array_equal(rotate90(img, 1), [[3, 1], [4, 2]])
    assert np.array_equal(rotate90(rotate90(img, 1), -1), img)
