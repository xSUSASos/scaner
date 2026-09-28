import itertools

import cv2
import numpy as np
import pytest

from conftest import TILTED, make_photo, make_sheet
from core.geometry import (full_frame_corners, order_points, output_size, to_normalized,
                           to_pixels, warp_document)

TL_TR_BR_BL = np.array([[10, 20], [110, 25], [105, 220], [5, 210]], dtype=float)


@pytest.mark.parametrize("perm", list(itertools.permutations(range(4))))
def test_order_points_any_input_order(perm):
    assert np.allclose(order_points(TL_TR_BR_BL[list(perm)]), TL_TR_BR_BL)


def test_order_points_rotated_rectangle():
    # Прямоугольник, повёрнутый на 40°: сумма x+y здесь почти не различает углы.
    rect = cv2.boxPoints(((200, 200), (300, 100), 40))
    ordered = order_points(rect)
    # Проверяем обход по часовой стрелке (в экранных координатах площадь со знаком > 0).
    x, y = ordered[:, 0], ordered[:, 1]
    signed_area = 0.5 * np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y)
    assert signed_area > 0
    assert np.argmin(ordered.sum(axis=1)) == 0


def test_pixel_normalized_roundtrip():
    shape = (900, 1200, 3)
    px = to_pixels(TILTED, shape)
    assert np.allclose(to_normalized(px, shape), TILTED)
    assert np.allclose(to_pixels(full_frame_corners(), shape)[2], [1199, 899])


def test_output_size_uses_longest_sides():
    corners = np.array([[0, 0], [100, 0], [120, 50], [-10, 50]], dtype=float)
    # ширина: max(100, 130) = 130; высота: max(|BL-TL|=51, |BR-TR|=√(20²+50²)≈53.9) -> 54; +1 пиксель
    assert output_size(corners) == (131, 55)


def test_warp_full_frame_is_identity():
    img = make_sheet(200, 300)
    out = warp_document(img, full_frame_corners())
    assert out.shape == img.shape
    assert np.abs(out.astype(int) - img).mean() < 1


def test_warp_keeps_aspect_for_rotated_sheet():
    """Лист просто повёрнут и уменьшен (без наклона камеры) -> пропорции A4 сохраняются."""
    sheet = make_sheet()
    sh, sw = sheet.shape[:2]
    rect = cv2.boxPoints(((600, 450), (sw * 0.6, sh * 0.6), 15))
    corners = order_points(rect) / [1199, 899]
    out = warp_document(make_photo(corners), corners)
    assert abs(out.shape[1] / out.shape[0] - sw / sh) < 0.01


def test_warp_restores_sheet():
    """Перспектива «туда» (conftest) и «обратно» (warp) даёт исходный лист."""
    photo = make_photo(TILTED)
    out = warp_document(photo, TILTED)
    sheet = make_sheet()
    resized = cv2.resize(out, (sheet.shape[1], sheet.shape[0]), interpolation=cv2.INTER_AREA)
    gray_a = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY).astype(float)
    gray_b = cv2.cvtColor(sheet, cv2.COLOR_BGR2GRAY).astype(float)
    corr = np.corrcoef(gray_a.ravel(), gray_b.ravel())[0, 1]
    assert corr > 0.8


def test_warp_accepts_unordered_corners():
    photo = make_photo(TILTED)
    a = warp_document(photo, TILTED)
    b = warp_document(photo, TILTED[[2, 0, 3, 1]])
    assert a.shape == b.shape and np.array_equal(a, b)


def test_warp_grayscale():
    gray = cv2.cvtColor(make_photo(TILTED), cv2.COLOR_BGR2GRAY)
    assert warp_document(gray, TILTED).ndim == 2
