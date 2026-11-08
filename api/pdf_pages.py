"""Render PDF pages to PNG images for the board (PDFium, via pypdfium2).

Pages are rendered at their own aspect ratio and orientation (PDFium applies /Rotate), large enough that small
textbook text and equations stay sharp, one page at a time so a long PDF never holds every bitmap in memory.
"""
import io
from collections.abc import Iterator
from dataclasses import dataclass

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c

MAX_PDF_BYTES = 50 * 1024 * 1024  # Supabase's default upload limit
MAX_PDF_PAGES = 100
TARGET_LONG_SIDE_PX = 2000  # a US Letter page renders at 1545 x 2000 (about 180 dpi)
MAX_SCALE = 4.0  # 288 dpi: small pages (index cards, slides) aren't blown up past this


class PdfPagesError(Exception):
    """A PDF that can't be turned into pages. `status` is the HTTP status; the message is shown to the teacher."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class RenderedPage:
    number: int  # 1-based
    png: bytes
    width: int
    height: int


def open_pdf(data: bytes) -> pdfium.PdfDocument:
    if len(data) > MAX_PDF_BYTES:
        raise PdfPagesError(413, f"This PDF is {len(data) / 1024 / 1024:.0f} MB; the limit is "
                                 f"{MAX_PDF_BYTES // 1024 // 1024} MB.")
    try:
        doc = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as e:
        code = getattr(e, "err_code", None)
        if code == pdfium_c.FPDF_ERR_PASSWORD:
            raise PdfPagesError(422, "This PDF is password-protected. Remove the password and upload it again.") from None
        if code == pdfium_c.FPDF_ERR_SECURITY:
            raise PdfPagesError(422, "This PDF uses an unsupported security handler. Save an unprotected copy and "
                                     "upload it again.") from None
        raise PdfPagesError(422, "This file couldn't be opened as a PDF. It may be damaged.") from None
    count = len(doc)
    if count == 0:
        doc.close()
        raise PdfPagesError(422, "This PDF has no pages.")
    if count > MAX_PDF_PAGES:
        doc.close()
        raise PdfPagesError(413, f"This PDF has {count} pages; the board takes up to {MAX_PDF_PAGES}. "
                                 "Split it and upload the part you'll teach.")
    return doc


def render_scale(width_pt: float, height_pt: float) -> float:
    long_side = max(width_pt, height_pt, 1.0)
    return min(MAX_SCALE, TARGET_LONG_SIDE_PX / long_side)


def render_pages(data: bytes) -> Iterator[RenderedPage]:
    """Yield every page in order as a white-backed PNG. Raises PdfPagesError for unusable PDFs or pages."""
    doc = open_pdf(data)
    try:
        for index in range(len(doc)):
            page = doc[index]
            try:
                width_pt, height_pt = page.get_size()
                bitmap = page.render(scale=render_scale(width_pt, height_pt), may_draw_forms=True)
                image = bitmap.to_pil().convert("RGB")
            except pdfium.PdfiumError:
                raise PdfPagesError(422, f"Page {index + 1} of this PDF couldn't be rendered. It may be damaged.") from None
            finally:
                page.close()
            out = io.BytesIO()
            image.save(out, "PNG", compress_level=6)
            yield RenderedPage(number=index + 1, png=out.getvalue(), width=image.width, height=image.height)
    finally:
        doc.close()
