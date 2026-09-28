import cli
from conftest import TILTED, make_photo
from core.imageio import load_image, save_image


def test_cli_end_to_end(cyr_dir):
    src = cyr_dir / "фото документа.jpg"
    save_image(src, make_photo(TILTED))
    out = cyr_dir / "результат"
    code = cli.main([str(cyr_dir / "*.jpg"), "-o", str(out), "--filter", "bw", "--debug"])
    assert code == 0
    result = load_image(out / "фото документа.jpg")
    assert result.shape[0] > 500
    assert (out / "фото документа_2_contour.jpg").exists()
    assert (out / "фото документа_1_edges_canny.png").exists()


def test_cli_bad_file(cyr_dir):
    bad = cyr_dir / "битый.jpg"
    bad.write_bytes(b"xx")
    assert cli.main([str(bad), "-o", str(cyr_dir / "o")]) == 1
