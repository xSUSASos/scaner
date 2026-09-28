import numpy as np

from conftest import TILTED, make_photo
from core.filters import FilterMode
from core.imageio import make_preview, save_image
from core.page import new_page, render, render_full


def test_new_page_detects(cyr_dir):
    path = cyr_dir / "лист.png"
    save_image(path, make_photo(TILTED))
    page = new_page(path)
    assert page.auto_detected
    assert np.abs(page.corners - TILTED).max() < 0.02


def test_preview_and_full_render_match(cyr_dir):
    """Главное свойство архитектуры: превью ≈ уменьшенный финальный результат."""
    import cv2
    photo = make_photo(TILTED, size=(3600, 2700))
    path = cyr_dir / "большое.jpg"
    save_image(path, photo)
    page = new_page(path)
    page.filter.mode = FilterMode.MAGIC
    page.rotation = 1

    preview_out = render(page, make_preview(photo, 1000))
    full_out = render_full(page)
    assert full_out.shape[0] > preview_out.shape[0] * 2          # финал в полном разрешении
    # Пропорции совпадают, картинка похожа.
    assert abs(full_out.shape[1] / full_out.shape[0] -
               preview_out.shape[1] / preview_out.shape[0]) < 0.01
    down = cv2.resize(full_out, (preview_out.shape[1], preview_out.shape[0]),
                      interpolation=cv2.INTER_AREA)
    assert np.abs(down.astype(int) - preview_out).mean() < 12


def test_clone_is_independent(cyr_dir):
    path = cyr_dir / "a.png"
    save_image(path, make_photo(TILTED))
    page = new_page(path)
    copy = page.clone()
    copy.corners[0] = [0, 0]
    copy.filter.bw_c = 99
    assert not np.allclose(page.corners[0], [0, 0])
    assert page.filter.bw_c != 99
