"""PDF page rendering (pdf_pages.py) and POST /assets/{id}/pages, with Supabase storage faked."""
import io

import pypdfium2 as pdfium
import pytest
from fastapi import HTTPException
from PIL import Image, ImageDraw

import main
import pdf_pages
from schemas import Figure, NotesContent, Section


def make_pdf(sizes=((612, 792),), rotate: dict | None = None) -> bytes:
    """A real PDF with one page per (width, height) in points, each page marked with its number."""
    images = []
    for i, (w, h) in enumerate(sizes, 1):
        img = Image.new("RGB", (w, h), "white")
        ImageDraw.Draw(img).text((20, 20), f"page {i}", fill="black")
        images.append(img)
    buf = io.BytesIO()
    images[0].save(buf, "PDF", save_all=True, append_images=images[1:], resolution=72)
    if not rotate:
        return buf.getvalue()
    doc = pdfium.PdfDocument(buf.getvalue())
    for index, degrees in rotate.items():
        doc[index].set_rotation(degrees)
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


# ---------- rendering ----------

def test_renders_every_page_in_order_at_its_own_aspect_and_orientation():
    pages = list(pdf_pages.render_pages(make_pdf([(612, 792), (792, 612), (612, 792)])))
    assert [p.number for p in pages] == [1, 2, 3]
    assert pages[0].height == 2000 and abs(pages[0].width - 1545) <= 1  # portrait Letter, long side 2000 px
    assert pages[1].width == 2000 and abs(pages[1].height - 1545) <= 1  # landscape stays landscape
    assert abs(pages[0].width / pages[0].height - 612 / 792) < 0.001
    for page in pages:
        assert Image.open(io.BytesIO(page.png)).size == (page.width, page.height)


def test_applies_the_pages_own_rotation():
    page = next(pdf_pages.render_pages(make_pdf([(612, 792)], rotate={0: 90})))
    assert page.width > page.height


def test_small_pages_are_sharpened_but_not_blown_up_without_limit():
    page = next(pdf_pages.render_pages(make_pdf([(100, 50)])))
    assert (page.width, page.height) == (400, 200)  # capped at 4x (288 dpi)


def test_corrupt_files_get_a_useful_error():
    with pytest.raises(pdf_pages.PdfPagesError) as e:
        list(pdf_pages.render_pages(b"%PDF-1.4 this is not really a pdf"))
    assert e.value.status == 422 and "damaged" in e.value.message


def test_password_protected_pdfs_say_so(monkeypatch):
    def locked(_data):
        raise pdfium.PdfiumError("Failed to load document", err_code=pdfium.raw.FPDF_ERR_PASSWORD)
    monkeypatch.setattr(pdf_pages.pdfium, "PdfDocument", locked)
    with pytest.raises(pdf_pages.PdfPagesError) as e:
        pdf_pages.open_pdf(b"%PDF-1.7")
    assert e.value.status == 422 and "password" in e.value.message


def test_oversized_and_overlong_pdfs_are_refused(monkeypatch):
    monkeypatch.setattr(pdf_pages, "MAX_PDF_BYTES", 10)
    with pytest.raises(pdf_pages.PdfPagesError) as e:
        pdf_pages.open_pdf(make_pdf())
    assert e.value.status == 413
    monkeypatch.setattr(pdf_pages, "MAX_PDF_BYTES", 50 * 1024 * 1024)
    monkeypatch.setattr(pdf_pages, "MAX_PDF_PAGES", 2)
    with pytest.raises(pdf_pages.PdfPagesError) as e:
        pdf_pages.open_pdf(make_pdf([(612, 792)] * 3))
    assert e.value.status == 413 and "3 pages" in e.value.message


# ---------- POST /assets/{id}/pages ----------

class Bucket(dict):
    """In-memory "assets" bucket: path -> bytes, counting downloads."""
    downloads = 0

    def download(self, path):
        self.downloads += 1
        if path not in self:
            raise RuntimeError("Object not found")
        return self[path]

    def upload(self, path, data, content_type):
        self[path] = data


@pytest.fixture
def storage(monkeypatch):
    bucket = Bucket()
    monkeypatch.setattr(main, "download", bucket.download)
    monkeypatch.setattr(main, "upload", bucket.upload)
    return bucket


def pdf_asset(db, storage, data=None, **extra):
    lec = db.add("lectures", title="Forces")
    path = f"{lec['id']}/doc.pdf"
    storage[path] = data if data is not None else make_pdf([(612, 792), (792, 612), (612, 792)])
    return db.add("assets", lecture_id=lec["id"], kind="pdf", storage_path=path, file_name="forces.pdf",
                  page_count=None, **extra)


def test_renders_a_pdf_into_one_page_asset_per_page(db, storage):
    pdf = pdf_asset(db, storage)

    out = main.render_pdf_pages(pdf["id"])

    assert out.page_count == 3 and db.get("assets", pdf["id"])["page_count"] == 3
    assert [p["page_number"] for p in out.pages] == [1, 2, 3]
    assert all(p["kind"] == "pdf_page" and p["source_asset_id"] == pdf["id"] for p in out.pages)
    assert out.pages[0]["storage_path"] == f"{pdf['lecture_id']}/{pdf['id']}/page-0001.png"
    assert out.pages[1]["aspect"] > 1 > out.pages[0]["aspect"]
    assert all(storage[p["storage_path"]].startswith(b"\x89PNG") for p in out.pages)


def test_rendering_again_returns_the_same_pages_without_rerendering_or_duplicating(db, storage):
    pdf = pdf_asset(db, storage)
    first = main.render_pdf_pages(pdf["id"])
    downloads = storage.downloads

    second = main.render_pdf_pages(pdf["id"])

    assert [p["id"] for p in second.pages] == [p["id"] for p in first.pages]
    assert storage.downloads == downloads  # no second download/render
    assert len([a for a in db.tables["assets"] if a["kind"] == "pdf_page"]) == 3


def test_a_failed_render_leaves_no_half_pdf_and_a_retry_does_not_duplicate(db, storage, monkeypatch):
    pdf = pdf_asset(db, storage)
    real_upload = main.upload
    uploads = []

    def flaky(path, data, content_type):
        uploads.append(path)
        if len(uploads) == 2:
            raise RuntimeError("storage hiccup")
        real_upload(path, data, content_type)

    monkeypatch.setattr(main, "upload", flaky)
    with pytest.raises(HTTPException) as e:
        main.render_pdf_pages(pdf["id"])
    assert e.value.status_code == 502
    assert db.get("assets", pdf["id"])["page_count"] is None
    assert not [a for a in db.tables["assets"] if a["kind"] == "pdf_page"]

    monkeypatch.setattr(main, "upload", real_upload)
    out = main.render_pdf_pages(pdf["id"])
    assert out.page_count == 3
    assert len([a for a in db.tables["assets"] if a["kind"] == "pdf_page"]) == 3


def test_existing_pdfs_uploaded_before_this_feature_can_be_rendered_later(db, storage):
    pdf = pdf_asset(db, storage)
    del pdf["page_count"]  # row from before the migration's columns were filled in
    assert main.render_pdf_pages(pdf["id"]).page_count == 3


def test_unusable_pdfs_return_the_message_for_the_teacher(db, storage):
    pdf = pdf_asset(db, storage, data=b"definitely not a pdf")
    with pytest.raises(HTTPException) as e:
        main.render_pdf_pages(pdf["id"])
    assert e.value.status_code == 422 and "damaged" in e.value.detail
    assert db.get("assets", pdf["id"])["page_count"] is None


def test_missing_file_non_pdf_and_unknown_assets(db, storage):
    pdf = pdf_asset(db, storage)
    storage.pop(pdf["storage_path"])
    with pytest.raises(HTTPException) as e:
        main.render_pdf_pages(pdf["id"])
    assert e.value.status_code == 404 and "missing" in e.value.detail

    image = db.add("assets", lecture_id=pdf["lecture_id"], kind="image", storage_path="x.png")
    with pytest.raises(HTTPException) as e:
        main.render_pdf_pages(image["id"])
    assert e.value.status_code == 400

    with pytest.raises(HTTPException) as e:
        main.render_pdf_pages("nope")
    assert e.value.status_code == 404


def test_a_database_without_the_migration_gets_a_clear_error(db, storage, monkeypatch):
    pdf = pdf_asset(db, storage)
    real_table = db.table

    def table(name):
        query = real_table(name)
        original = query.upsert

        def upsert(rows):
            raise RuntimeError('new row violates check constraint "assets_kind_check"')
        query.upsert = upsert if name == "assets" else original
        return query

    monkeypatch.setattr(db, "table", table)
    with pytest.raises(HTTPException) as e:
        main.render_pdf_pages(pdf["id"])
    assert e.value.status_code == 503 and "2026-11-08_pdf_pages.sql" in e.value.detail


# ---------- compile keeps every page ----------

def pdf_board(db):
    lec = db.add("lectures", title="Forces")
    pdf = db.add("assets", lecture_id=lec["id"], kind="pdf", file_name="forces.pdf", label="Forces worksheet",
                 page_count=3)
    pages = [db.add("assets", lecture_id=lec["id"], kind="pdf_page", source_asset_id=pdf["id"], page_number=n)
             for n in (1, 2, 3)]
    ses = db.add("sessions", lecture_id=lec["id"])
    blocks = [db.add("blocks", session_id=ses["id"], kind="image", position=n, asset_id=page["id"], aspect=0.77)
              for n, page in zip((1, 3, 5), pages)]
    text = db.add("blocks", session_id=ses["id"], kind="text", position=2, text="Here is the free-body diagram.")
    return ses, blocks, text


def test_compile_input_names_each_pdf_page(db):
    ses, blocks, _ = pdf_board(db)
    ordered = sorted(db.tables["blocks"], key=lambda b: b["position"])
    doc = main.compile_input("Forces", ordered, [], db.tables["assets"])
    assert f"[IMAGE image_block_id={blocks[1]['id']}] Page 2 of 3 of Forces worksheet (forces.pdf)" in doc


def test_compiled_notes_keep_every_pdf_page_once_in_order_even_if_never_discussed(db, gemini):
    ses, blocks, text = pdf_board(db)
    gemini.result = NotesContent(title="Forces", overview="", review_questions=[], sections=[
        Section(id="s1", heading="Free-body diagrams", paragraphs=[text["text"]], key_terms=[],
                figures=[Figure(image_block_id=blocks[0]["id"], caption="Page 1")], annotation_ids=[]),
    ])

    notes = main.compile_session(ses["id"])

    figures = [f.image_block_id for s in notes.sections for f in s.figures]
    assert figures == [b["id"] for b in blocks]
    assert [p for s in notes.sections for p in s.paragraphs] == [text["text"]]


def test_a_board_with_only_pdf_pages_still_compiles_them(db, gemini):
    lec = db.add("lectures", title="Forces")
    pdf = db.add("assets", lecture_id=lec["id"], kind="pdf", file_name="f.pdf", page_count=1)
    page = db.add("assets", lecture_id=lec["id"], kind="pdf_page", source_asset_id=pdf["id"], page_number=1)
    ses = db.add("sessions", lecture_id=lec["id"])
    block = db.add("blocks", session_id=ses["id"], kind="image", position=1, asset_id=page["id"])

    notes = main.compile_session(ses["id"])

    assert [f.image_block_id for s in notes.sections for f in s.figures] == [block["id"]]
    assert gemini.calls == []  # no speech: nothing for Gemini to organise
