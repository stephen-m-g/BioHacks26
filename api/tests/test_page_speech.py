"""Speech under PDF pages: refine places each page's speech under that page; compile keeps it there."""
from datetime import datetime, timedelta, timezone

import main
from schemas import Figure, KeyTerm, NotesContent, RefinedSegment, RefineGemini, Section

T0 = datetime(2026, 11, 7, 19, 0, 0, tzinfo=timezone.utc)


def ts(seconds: float) -> str:
    return (T0 + timedelta(seconds=seconds)).isoformat()


def pdf_session(db, pages=3, before=None, after=None):
    """A session whose board is [before?] [page 1] [page 2] ... [after?]. Returns (session, page blocks)."""
    lec = db.add("lectures", title="Dynamics")
    pdf = db.add("assets", lecture_id=lec["id"], kind="pdf", file_name="forces.pdf", label="Forces worksheet",
                 page_count=pages)
    ses = db.add("sessions", lecture_id=lec["id"], status="live")
    if before:
        db.add("blocks", session_id=ses["id"], kind="text", position=0, text=before)
    blocks = []
    for n in range(1, pages + 1):
        page = db.add("assets", lecture_id=lec["id"], kind="pdf_page", source_asset_id=pdf["id"], page_number=n)
        blocks.append(db.add("blocks", session_id=ses["id"], kind="image", position=n, asset_id=page["id"],
                             aspect=0.77))
    if after:
        db.add("blocks", session_id=ses["id"], kind="text", position=pages + 1, text=after)
    return ses, blocks


def say(db, ses, t, text, page=None, annotation=None):
    return db.add("transcript_segments", session_id=ses["id"], raw_text=text, t_start=ts(t), t_end=ts(t + 0.9),
                  created_at=ts(t + 2), text_block_id=None, page_block_id=page["id"] if page else None,
                  annotation_id=annotation)


def board_texts(db, ses):
    """The board top to bottom: page blocks as 'P<n>', text blocks as their text."""
    pages = {a["id"]: a["page_number"] for a in db.tables["assets"] if a["kind"] == "pdf_page"}
    rows = sorted((b for b in db.tables["blocks"] if b["session_id"] == ses["id"]), key=lambda b: b["position"])
    return [f"P{pages[b['asset_id']]}" if b["kind"] == "image" else b["text"] for b in rows if b.get("text") != ""]


def refine_all(ses):
    while main.refine_session(ses["id"]).block is not None:
        pass


# ---------- refine ----------

def test_each_pages_speech_goes_directly_under_that_page(db, gemini):
    ses, (p1, p2, p3) = pdf_session(db)
    say(db, ses, 1, "Here we're looking at the free-body diagram.", p1)
    say(db, ses, 5, "Now we're going to write Newton's second law.", p2)
    gemini.result = None

    refine_all(ses)

    assert board_texts(db, ses) == [
        "P1", "Here we're looking at the free-body diagram.",
        "P2", "Now we're going to write Newton's second law.",
        "P3",
    ]
    under = {b["text"]: b.get("page_block_id") for b in db.tables["blocks"] if b["kind"] == "text"}
    assert under == {"Here we're looking at the free-body diagram.": p1["id"],
                     "Now we're going to write Newton's second law.": p2["id"]}


def test_a_batch_never_mixes_pages_even_when_short(db, gemini):
    ses, (p1, p2, _) = pdf_session(db)
    a = say(db, ses, 1, "first page words", p1)
    b = say(db, ses, 2, "second page words", p2)
    gemini.result = None

    first = main.refine_session(ses["id"])
    second = main.refine_session(ses["id"])

    assert first.segment_ids == [a["id"]] and first.block["page_block_id"] == p1["id"]
    assert second.segment_ids == [b["id"]] and second.block["page_block_id"] == p2["id"]


def test_returning_to_an_earlier_page_adds_under_it_after_its_earlier_speech(db, gemini):
    ses, (p1, p2, _) = pdf_session(db)
    say(db, ses, 1, "page one first", p1)
    say(db, ses, 5, "page two", p2)
    back = say(db, ses, 9, "back on page one", p1)
    gemini.result = None

    refine_all(ses)

    assert board_texts(db, ses) == ["P1", "page one first", "back on page one", "P2", "page two", "P3"]
    saved = db.get("transcript_segments", back["id"])
    assert saved["t_start"] == ts(9) and saved["page_block_id"] == p1["id"]  # original speech time kept


def test_speech_without_a_page_is_appended_at_the_end_as_before(db, gemini):
    ses, (p1, _, _) = pdf_session(db, after="Closing remarks.")
    say(db, ses, 1, "about page one", p1)
    say(db, ses, 5, "general speech after the pdf")
    gemini.result = None

    refine_all(ses)

    assert board_texts(db, ses) == ["P1", "about page one", "P2", "P3", "Closing remarks.",
                                    "general speech after the pdf"]
    general = next(b for b in db.tables["blocks"] if b.get("text") == "general speech after the pdf")
    assert "page_block_id" not in general  # no page: the insert is the same as before PDFs existed


def test_page_cleanup_uses_that_pages_previous_paragraph_and_the_same_validation(db, gemini):
    ses, (p1, p2, _) = pdf_session(db)
    db.add("blocks", session_id=ses["id"], kind="text", position=1.5, text="Earlier on page one.",
           page_block_id=p1["id"])
    db.add("blocks", session_id=ses["id"], kind="text", position=2.5, text="Earlier on page two.",
           page_block_id=p2["id"])
    seg = say(db, ses, 1, "so um the the normal force", p1)
    gemini.result = RefineGemini(text="", segments=[RefinedSegment(id=seg["id"], text="The normal force is 10 N.")])

    out = main.refine_session(ses["id"])

    prompt = gemini.calls[0][2][0]
    assert "Earlier on page one." in prompt and "Earlier on page two." not in prompt
    assert out.block["text"] == "so the normal force"  # an invented number is rejected; filler still removed
    assert 1.5 < out.block["position"] < 2


def test_filler_only_speech_on_a_page_adds_no_empty_paragraph(db, gemini):
    ses, (p1, _, _) = pdf_session(db)
    seg = say(db, ses, 1, "Um.", p1)
    gemini.result = None

    out = main.refine_session(ses["id"])

    assert out.block["id"] == p1["id"]
    assert not [b for b in db.tables["blocks"] if b["kind"] == "text"]
    assert db.get("transcript_segments", seg["id"])["text_block_id"] == p1["id"]
    assert main.refine_session(ses["id"]).block is None  # refined: compile's flush loop ends


def test_a_page_not_on_the_board_is_ordinary_speech(db, gemini):
    ses, _ = pdf_session(db)
    db.add("transcript_segments", session_id=ses["id"], raw_text="stale page", t_start=ts(1), t_end=ts(2),
           created_at=ts(3), text_block_id=None, page_block_id="deleted-block")
    gemini.result = None

    out = main.refine_session(ses["id"])

    assert "page_block_id" not in out.block and board_texts(db, ses)[-1] == "stale page"


def test_many_paragraphs_under_one_page_make_room_instead_of_running_out_of_positions(db, gemini):
    ses, (p1, p2, p3) = pdf_session(db)
    gemini.result = None
    for i in range(30):
        say(db, ses, i * 10, f"paragraph {i}", p1)
        main.refine_session(ses["id"])

    assert board_texts(db, ses) == ["P1", *[f"paragraph {i}" for i in range(30)], "P2", "P3"]
    positions = sorted(b["position"] for b in db.tables["blocks"])
    assert len(set(positions)) == len(positions)


def test_room_made_under_a_page_is_reported_so_the_board_can_update(db, gemini):
    ses, (p1, p2, p3) = pdf_session(db)
    p2["position"] = p1["position"] + 1e-7
    say(db, ses, 1, "squeezed", p1)
    gemini.result = None

    out = main.refine_session(ses["id"])

    assert {b["id"] for b in out.moved_blocks} == {p2["id"], p3["id"]}
    assert p1["position"] < out.block["position"] < p2["position"]


def test_annotation_and_page_links_coexist(db, gemini):
    ses, (p1, _, _) = pdf_session(db)
    plain = say(db, ses, 1, "this is the free-body diagram", p1)
    circled = say(db, ses, 2, "and this arrow is friction", p1, annotation="ann-1")
    gemini.result = None

    out = main.refine_session(ses["id"])

    assert out.segment_ids == [plain["id"], circled["id"]]
    assert db.get("transcript_segments", circled["id"])["annotation_id"] == "ann-1"
    text = out.block["text"]
    saved = db.get("transcript_segments", circled["id"])
    assert text[saved["text_start"]:saved["text_end"]] == "and this arrow is friction"


# ---------- compile ----------

def test_chronological_order_never_moves_speech_off_its_page():
    blocks = [
        {"id": "p1", "kind": "image", "position": 1},
        {"id": "t1", "kind": "text", "position": 1.5, "text": "late on page one", "page_block_id": "p1"},
        {"id": "p2", "kind": "image", "position": 2},
        {"id": "t2", "kind": "text", "position": 2.5, "text": "early on page two", "page_block_id": "p2"},
    ]
    segments = [{"id": "s1", "text_block_id": "t1", "t_start": ts(9)},
                {"id": "s2", "text_block_id": "t2", "t_start": ts(1)}]
    assert [b["id"] for b in main.chronological_blocks(blocks, segments)] == ["p1", "t1", "p2", "t2"]


def test_compiled_notes_put_each_pages_speech_under_that_page(db, gemini, monkeypatch):
    ses, (p1, p2, p3) = pdf_session(db, before="Today: dynamics.")
    say(db, ses, 1, "Here we're looking at the free-body diagram.", p1)
    say(db, ses, 5, "Now we're going to write Newton's second law.", p2)
    say(db, ses, 9, "One more thing about the diagram.", p1)
    say(db, ses, 12, "That's it for the worksheet.")  # no page: appended after the PDF, as before
    gemini.result = None
    refine_all(ses)
    ann = db.add("annotations", session_id=ses["id"], block_id=p2["id"], status="confirmed", label="F = ma",
                 drawn_at=ts(5), closed_at=ts(6))

    def gemini_notes(task, system, contents, schema, **_):
        if task != "compile":
            return None, 1.0
        texts = [b for b in main.chronological_blocks(
            sorted(db.tables["blocks"], key=lambda b: b["position"]), db.tables["transcript_segments"])
            if b["kind"] == "text"]
        return NotesContent(title="Dynamics", overview="Forces.", review_questions=["What is F?"], sections=[
            Section(id="x", heading="Dynamics", paragraphs=[b["text"] for b in texts],
                    key_terms=[KeyTerm(term="Force", definition="A push or pull.")],
                    figures=[Figure(image_block_id=p2["id"], caption="Newton's second law")], annotation_ids=[]),
        ]), 1.0
    monkeypatch.setattr(main.ai, "generate", gemini_notes)

    notes = main.compile_session(ses["id"])

    layout = [(s.heading, [f.image_block_id for f in s.figures], s.paragraphs) for s in notes.sections]
    assert layout == [
        ("Dynamics", [], ["Today: dynamics."]),
        ("Forces worksheet, page 1", [p1["id"]],
         ["Here we're looking at the free-body diagram.", "One more thing about the diagram."]),
        ("Forces worksheet, page 2", [p2["id"]], ["Now we're going to write Newton's second law."]),
        ("Forces worksheet, page 3", [p3["id"]], []),  # never discussed: shown, nothing invented
        ("Dynamics", [], ["That's it for the worksheet."]),
    ]
    assert [s.id for s in notes.sections] == ["s1", "s2", "s3", "s4", "s5"]
    assert notes.sections[2].annotation_ids == [ann["id"]]
    assert notes.sections[2].figures[0].caption == "Newton's second law"
    assert notes.sections[0].key_terms[0].term == "Force"
    assert notes.overview == "Forces." and notes.review_questions == ["What is F?"]
    blocks_in_notes = [b for s in notes.sections for b in s.paragraph_block_ids]
    assert len(blocks_in_notes) == len(set(blocks_in_notes)) == 5  # every paragraph exactly once
    saved = db.tables["lecture_notes"][0]["content"]
    assert [s["heading"] for s in saved["sections"]] == [s.heading for s in notes.sections]


def test_compile_without_gemini_still_puts_speech_under_its_pages(db, gemini):
    ses, (p1, p2, p3) = pdf_session(db)
    say(db, ses, 1, "page two first", p2)
    say(db, ses, 5, "then page one", p1)
    gemini.result = None

    notes = main.compile_session(ses["id"])

    assert [(s.figures[0].image_block_id, s.paragraphs) for s in notes.sections] == [
        (p1["id"], ["then page one"]), (p2["id"], ["page two first"]), (p3["id"], []),
    ]


def test_boards_without_pdf_pages_compile_exactly_as_before(db, gemini):
    lec = db.add("lectures", title="Cells")
    img = db.add("assets", lecture_id=lec["id"], kind="image", label="Cell")
    ses = db.add("sessions", lecture_id=lec["id"])
    db.add("blocks", session_id=ses["id"], kind="text", position=1, text="Intro.")
    db.add("blocks", session_id=ses["id"], kind="image", position=2, asset_id=img["id"])
    db.add("blocks", session_id=ses["id"], kind="text", position=3, text="More.")
    gemini.result = None

    notes = main.compile_session(ses["id"])

    assert [(s.heading, s.paragraphs) for s in notes.sections] == [("Part 1", ["Intro."]), ("Part 2", ["More."])]
