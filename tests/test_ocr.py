from __future__ import annotations

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader

from core import export, ocr

TESSERACT_OK = ocr.check_tesseract().ok
needs_tesseract = pytest.mark.skipif(not TESSERACT_OK, reason="Tesseract (rus+eng) не установлен")

FONT_PATH = r"C:\Windows\Fonts\arial.ttf"


def _text_image(text: str = "Привет мир Hello") -> np.ndarray:
    """Белый лист ~A4 при 150 dpi с крупной надписью (BGR).

    cv2.putText не умеет кириллицу, поэтому рисуем через Pillow с TrueType-шрифтом.
    """
    im = Image.new("RGB", (1240, 1754), "white")
    font = ImageFont.truetype(FONT_PATH, 60)
    ImageDraw.Draw(im).text((100, 200), text, fill="black", font=font)
    return np.asarray(im)[:, :, ::-1].copy()


@pytest.fixture
def no_tesseract(monkeypatch):
    monkeypatch.setattr(ocr, "find_tesseract", lambda: None)


def test_status_when_missing(no_tesseract):
    st = ocr.check_tesseract()
    assert not st.ok
    assert st.path is None
    assert st.missing_langs == ("rus", "eng")
    assert "UB Mannheim" in st.message
    assert "Russian" in st.message


def test_image_to_text_raises_when_missing(no_tesseract):
    with pytest.raises(ocr.TesseractNotFoundError) as e:
        ocr.image_to_text(np.zeros((50, 50), np.uint8))
    assert "UB Mannheim" in str(e.value)


def test_image_to_pdf_page_raises_when_missing(no_tesseract):
    with pytest.raises(ocr.TesseractNotFoundError):
        ocr.image_to_pdf_page(np.zeros((50, 50, 3), np.uint8))


def test_searchable_pdf_fails_before_consuming_pages(no_tesseract, tmp_path):
    consumed = []

    def gen():
        consumed.append(1)
        yield np.zeros((50, 50), np.uint8)

    with pytest.raises(ocr.TesseractNotFoundError):
        export.export_searchable_pdf(gen(), tmp_path / "папка.pdf", total=1)
    assert consumed == []


@needs_tesseract
def test_image_to_text_real():
    text = ocr.image_to_text(_text_image())
    assert "Hello" in text
    assert "Привет" in text


@needs_tesseract
def test_searchable_pdf_real(tmp_path):
    folder = tmp_path / "папка"
    folder.mkdir()
    gray = _text_image()[:, :, 0].copy()
    path = export.export_searchable_pdf([_text_image(), gray], folder / "поиск.pdf")
    reader = PdfReader(path)
    assert len(reader.pages) == 2
    assert "Hello" in reader.pages[0].extract_text()
    long_side = max(float(reader.pages[0].mediabox.width), float(reader.pages[0].mediabox.height))
    assert long_side == pytest.approx(export.A4_LONG_SIDE_INCH * 72, rel=0.02)
