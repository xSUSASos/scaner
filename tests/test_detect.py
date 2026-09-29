import numpy as np
import pytest

from conftest import TILTED, make_photo
from core.detect import detect_document


def max_corner_error(found, expected) -> float:
    """Максимальная ошибка угла в долях кадра."""
    return float(np.abs(np.asarray(found) - np.asarray(expected)).max())


def test_detects_tilted_sheet(tilted_photo):
    photo, truth = tilted_photo
    result = detect_document(photo)
    assert result.found
    assert max_corner_error(result.corners, truth) < 0.02


def test_detects_under_shadow():
    photo = make_photo(TILTED, shadow=True)
    result = detect_document(photo)
    assert result.found
    assert max_corner_error(result.corners, TILTED) < 0.02


def test_detects_rotated_45_degrees():
    # Ромб: классическое упорядочивание по x+y тут ошибается, наше — нет.
    diamond = np.array([[0.5, 0.05], [0.9, 0.5], [0.5, 0.95], [0.1, 0.5]])
    result = detect_document(make_photo(diamond, size=(1000, 1000)))
    assert result.found
    # Сравниваем как множества точек: порядок у ромба неоднозначен.
    for p in diamond:
        assert np.linalg.norm(result.corners - p, axis=1).min() < 0.02


@pytest.mark.parametrize("seed", range(5))
def test_light_background(seed):
    # Несколько разных листов: раньше тест проходил на одном «удачном» и не ловил
    # потерю края на светлом столе (пороги Canny от медианы).
    photo = make_photo(TILTED, bg=(185, 190, 195), seed=seed)
    result = detect_document(photo)
    assert result.found
    assert max_corner_error(result.corners, TILTED) < 0.02


@pytest.mark.parametrize("scale", [0.5, 3.0])
def test_resolution_independent(scale):
    import cv2
    photo = make_photo(TILTED)
    h, w = photo.shape[:2]
    photo = cv2.resize(photo, (int(w * scale), int(h * scale)))
    result = detect_document(photo)
    assert result.found
    assert max_corner_error(result.corners, TILTED) < 0.02


def test_busy_background_occluded_corner():
    """Регрессия с реального фото: пёстрый фон, угол листа закрыт обложкой, лист
    упирается в край кадра. Раньше побеждал «самый большой» кривой контур."""
    from conftest import make_busy_photo
    truth = np.array([[0.03, 0.07], [0.93, 0.06], [1.0, 0.84], [0.0, 0.86]])
    result = detect_document(make_busy_photo(truth))
    assert result.found
    # Закрытый угол восстанавливается по пересечению сторон — допускаем чуть большую ошибку.
    assert max_corner_error(result.corners, truth) < 0.03


def test_fallback_to_full_frame():
    rng = np.random.default_rng(1)
    noise = rng.integers(100, 140, (600, 800, 3), dtype=np.uint8)
    result = detect_document(noise)
    assert not result.found
    assert np.allclose(result.corners, [[0, 0], [1, 0], [1, 1], [0, 1]])


def test_small_quad_ignored():
    tiny = np.array([[0.45, 0.45], [0.55, 0.45], [0.55, 0.55], [0.45, 0.55]])
    result = detect_document(make_photo(tiny))
    assert not result.found


def test_grayscale_input(tilted_photo):
    import cv2
    photo, truth = tilted_photo
    result = detect_document(cv2.cvtColor(photo, cv2.COLOR_BGR2GRAY))
    assert result.found
    assert max_corner_error(result.corners, truth) < 0.02
