"""Endpoint logic and helpers in main.py, with Supabase and Gemini faked (see conftest.py)."""
import base64
import io
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from PIL import Image

import main
from schemas import CloseGemini, DescribeOut, Figure, KeyTerm, NotesContent, RefineGemini, Section

T0 = datetime(2026, 11, 7, 19, 0, 0, tzinfo=timezone.utc)


def ts(seconds: float) -> str:
    return (T0 + timedelta(seconds=seconds)).isoformat()


def png(w=1000, h=500) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", (w, h), "white").save(b, "PNG")
    return b.getvalue()


# ---------- helpers ----------

def test_truncate_words():
    assert main.truncate_words("a b c", 5) == "a b c"
    assert main.truncate_words(" ".join(["w"] * 80), 70) == " ".join(["w"] * 70) + "…"


@pytest.mark.parametrize("value", [
    "2026-11-07T19:00:05.169366+00:00", "2026-11-07T19:00:05.16+00:00", "2026-11-07T19:00:05Z",
])
def test_parse_ts_handles_postgres_formats(value):
    t = main.parse_ts(value)
    assert t.tzinfo is not None and t.replace(microsecond=0) == T0 + timedelta(seconds=5)


def close_to(size, expected, tol=1):
    return all(abs(a - b) <= tol for a, b in zip(size, expected))


def test_crop_to_bbox_crops_with_margin():
    out = Image.open(io.BytesIO(main.crop_to_bbox(png(1000, 500), {"x": 0.5, "y": 0.2, "w": 0.2, "h": 0.4})))
    assert close_to(out.size, (232, 232))  # 200x200 px box plus an 8% margin on each side


def test_crop_to_bbox_clamps_at_edges_and_skips_tiny_or_missing_boxes():
    edge = Image.open(io.BytesIO(main.crop_to_bbox(png(1000, 500), {"x": 0.9, "y": 0.0, "w": 0.1, "h": 0.5})))
    assert close_to(edge.size, (108, 270))  # clamped at the right and top edges
    assert Image.open(io.BytesIO(main.crop_to_bbox(png(), None))).size == (1000, 500)
    tiny = {"x": 0.5, "y": 0.5, "w": 0.001, "h": 0.001}
    assert Image.open(io.BytesIO(main.crop_to_bbox(png(), tiny))).size == (1000, 500)


def test_selection_image_prefers_the_frontend_crop_and_tolerates_data_urls():
    raw = png(10, 10)
    body = main.CloseIn(crop_png_base64="data:image/png;base64," + base64.b64encode(raw).decode())
    assert main.selection_image(body, {}, None) == (raw, "image/png")
    assert main.selection_image(None, {}, None) is None  # no crop, no asset file


def test_selection_image_falls_back_to_the_whole_image_if_it_cannot_crop(monkeypatch):
    monkeypatch.setattr(main, "download", lambda path: b"not an image")
    data, mime = main.selection_image(None, {"storage_path": "lec/x.png"}, {"x": 0, "y": 0, "w": 1, "h": 1})
    assert data == b"not an image" and mime == "image/png"


# ---------- /annotations/{id}/close ----------

def lasso_session(db, closed_at=12):
    """A session with an image block, a lasso drawn at t=10 s, and speech around it."""
    lec = db.add("lectures", title="Cells")
    db.add("assets", lecture_id=lec["id"], kind="text", key_terms=["mitochondria", "ATP"])
    asset = db.add("assets", lecture_id=lec["id"], kind="image", storage_path="lec/cell.png",
                   label="Plant cell", description="A plant cell.")
    ses = db.add("sessions", lecture_id=lec["id"], title=None, status="live")
    block = db.add("blocks", session_id=ses["id"], kind="image", position=1, asset_id=asset["id"])
    other = db.add("annotations", session_id=ses["id"], block_id=block["id"], status="confirmed")
    ann = db.add("annotations", session_id=ses["id"], block_id=block["id"], status="confirmed",
                 drawn_at=ts(10), closed_at=ts(closed_at) if closed_at else None,
                 bbox={"x": 0.6, "y": 0.2, "w": 0.2, "h": 0.2})
    seg = lambda t, text, tag=None: db.add(  # noqa: E731
        "transcript_segments", session_id=ses["id"], t_start=ts(t), raw_text=text, annotation_id=tag)
    segs = {
        "long_before": seg(0, "this is the nucleus"),                    # outside the window
        "before": seg(7, "now this little oval one"),                    # in the 5 s before drawn_at
        "open1": seg(10.5, "the my toe con dree a makes a tee pee", ann["id"]),
        "open_noise": seg(11, "can someone close the door", ann["id"]),
        "other_ann": seg(11.5, "and this was for another circle", other["id"]),
        "after": seg(20, "the chloroplast is green"),                   # after closed_at
    }
    return ses, ann, segs


@pytest.fixture
def no_download(monkeypatch):
    monkeypatch.setattr(main, "download", lambda path: png())


def test_close_sends_only_captured_lines_and_gemini_cannot_drop_any(db, gemini, no_download):
    ses, ann, segs = lasso_session(db)
    gemini.result = CloseGemini(label="Mitochondrion", bubble_text="The mitochondria make ATP.",
                                used_segments=[1, 2])

    out = main.close_annotation(ann["id"], None)

    assert out.label == "Mitochondrion"
    assert out.bubble_text == "the my toe con dree a makes a tee pee can someone close the door"
    contents = gemini.calls[0][2]
    transcript = next(c for c in contents if isinstance(c, str) and c.startswith("Captured transcript"))
    assert "1. the my toe con dree a" in transcript
    assert "2. can someone close the door" in transcript
    assert "little oval" not in transcript and "another circle" not in transcript
    assert "nucleus" not in transcript and "chloroplast" not in transcript
    assert any("mitochondria" in c for c in contents if isinstance(c, str))  # lecture vocabulary
    rows = {k: db.get("transcript_segments", s["id"]) for k, s in segs.items()}
    assert rows["before"]["annotation_id"] is None
    assert rows["open1"]["annotation_id"] == ann["id"]
    assert rows["open_noise"]["annotation_id"] == ann["id"]
    assert rows["other_ann"]["annotation_id"] != ann["id"]
    assert db.get("annotations", ann["id"])["label"] == "Mitochondrion"


def test_close_never_steals_another_annotations_line_even_if_gemini_picks_it(db, gemini, no_download):
    ses, ann, segs = lasso_session(db)
    gemini.result = CloseGemini(label="x", bubble_text="y", used_segments=[1, 2, 3, 4])  # 4 = other's line
    main.close_annotation(ann["id"], None)
    assert db.get("transcript_segments", segs["other_ann"]["id"])["annotation_id"] != ann["id"]


def test_close_fallback_prefers_speech_from_while_the_lasso_was_open(db, gemini, no_download):
    ses, ann, segs = lasso_session(db)
    gemini.result = None
    out = main.close_annotation(ann["id"], None)
    assert out.label == "Annotation"
    assert out.bubble_text == "the my toe con dree a makes a tee pee can someone close the door"


def test_close_with_no_speech_has_no_bubble(db, gemini, no_download):
    lec = db.add("lectures", title="Cells")
    ses = db.add("sessions", lecture_id=lec["id"])
    ann = db.add("annotations", session_id=ses["id"], block_id=None, status="confirmed",
                 drawn_at=ts(10), closed_at=ts(12))
    gemini.result = CloseGemini(label="Cell nucleus", bubble_text="", used_segments=[])
    out = main.close_annotation(ann["id"], None)
    assert (out.label, out.bubble_text) == ("Cell nucleus", None)


def test_close_confirms_if_the_frontends_update_has_not_landed(db, gemini, no_download):
    ses, ann, _ = lasso_session(db, closed_at=None)
    db.get("annotations", ann["id"])["status"] = "pending"
    gemini.result = None
    main.close_annotation(ann["id"], None)
    row = db.get("annotations", ann["id"])
    assert row["status"] == "confirmed" and row["closed_at"]


def test_close_does_not_truncate_captured_explanation(db, gemini, no_download):
    ses, ann, _ = lasso_session(db)
    db.add(
        "transcript_segments", session_id=ses["id"], raw_text=" ".join(["word"] * 90),
        t_start=ts(11.5), t_end=ts(11.9), created_at=ts(20), annotation_id=ann["id"],
    )
    gemini.result = None
    assert len(main.close_annotation(ann["id"], None).bubble_text.split()) == 105


def test_close_unknown_annotation_is_404(db, gemini):
    with pytest.raises(HTTPException) as e:
        main.close_annotation("nope", None)
    assert e.value.status_code == 404


def test_close_uses_only_speech_fully_inside_the_capture_interval_and_keeps_all_of_it(db, gemini, no_download):
    ses, ann, segs = lasso_session(db)
    before = db.get("transcript_segments", segs["before"]["id"])
    before["t_end"] = ts(8)
    before["created_at"] = ts(30)
    crossing = db.add(
        "transcript_segments", session_id=ses["id"], raw_text="crosses the checkmark",
        t_start=ts(11.8), t_end=ts(12.2), created_at=ts(40), annotation_id=ann["id"],
    )
    for key in ("open1", "open_noise", "other_ann", "after"):
        row = db.get("transcript_segments", segs[key]["id"])
        row.setdefault("t_end", row["t_start"])
        row.setdefault("created_at", row["t_start"])
    gemini.result = CloseGemini(
        label="Mitochondrion",
        bubble_text="The mitochondria make ATP.",
        used_segments=[1],
    )

    out = main.close_annotation(ann["id"], None)

    assert "my toe con dree a" in out.bubble_text
    assert "close the door" in out.bubble_text
    assert db.get("transcript_segments", segs["before"]["id"])["annotation_id"] is None
    assert db.get("transcript_segments", crossing["id"])["annotation_id"] is None
    assert db.get("transcript_segments", segs["after"]["id"])["annotation_id"] is None


def test_close_links_delayed_untagged_speech_by_occurrence_time_not_save_time(db, gemini, no_download):
    ses, ann, _ = lasso_session(db)
    delayed = db.add(
        "transcript_segments", session_id=ses["id"], raw_text="spoken before the checkmark",
        t_start=ts(11.2), t_end=ts(11.8), created_at=ts(30), annotation_id=None,
    )
    gemini.result = None

    main.close_annotation(ann["id"], None)

    assert db.get("transcript_segments", delayed["id"])["annotation_id"] == ann["id"]


# ---------- /sessions/{id}/compile ----------

def board(db, session_title=None):
    lec = db.add("lectures", title="Lecture title")
    db.add("assets", lecture_id=lec["id"], kind="text", label="Plan", text_content="ATP is energy.")
    img = db.add("assets", lecture_id=lec["id"], kind="image", label="Cell", description="A cell.")
    ses = db.add("sessions", lecture_id=lec["id"], title=session_title)
    t1 = db.add("blocks", session_id=ses["id"], kind="text", position=1, text="Intro paragraph.")
    i1 = db.add("blocks", session_id=ses["id"], kind="image", position=2, asset_id=img["id"])
    t2 = db.add("blocks", session_id=ses["id"], kind="text", position=3, text="Mitochondria make ATP.")
    a1 = db.add("annotations", session_id=ses["id"], block_id=i1["id"], status="confirmed",
                label="Mitochondrion", bubble_text="They make ATP.")
    db.add("annotations", session_id=ses["id"], block_id=i1["id"], status="rejected")
    return ses, {"t1": t1, "i1": i1, "t2": t2, "a1": a1}


def test_compile_input_lists_ids_annotations_and_materials(db):
    ses, b = board(db)
    blocks = sorted([r for r in db.tables["blocks"]], key=lambda r: r["position"])
    doc = main.compile_input("T", blocks, [b["a1"]], db.tables["assets"])
    assert f"[IMAGE image_block_id={b['i1']['id']}] Cell: A cell." in doc
    assert f"[ANNOTATION annotation_id={b['a1']['id']}] Mitochondrion" in doc
    assert f"[TEXT text_block_id={b['t1']['id']}] Intro paragraph." in doc
    assert f"[TEXT text_block_id={b['t2']['id']}] Mitochondria make ATP." in doc
    assert "ATP is energy." in doc


def test_compile_drops_invented_ids_and_saves_notes(db, gemini):
    ses, b = board(db, session_title="Renamed session")
    gemini.result = NotesContent(title="", overview="o", review_questions=[f"q{i}" for i in range(7)], sections=[
        Section(id="intro", heading="H1", paragraphs=["Intro paragraph."],
                key_terms=[KeyTerm(term="ATP", definition="energy")],
                figures=[Figure(image_block_id=b["i1"]["id"], caption="c"),
                         Figure(image_block_id="made-up", caption="x")],
                annotation_ids=[b["a1"]["id"], "made-up"]),
        Section(id="intro", heading="H2", paragraphs=["Mitochondria make ATP."], key_terms=[], figures=[],
                annotation_ids=[]),
    ])

    notes = main.compile_session(ses["id"])

    assert [s.id for s in notes.sections] == ["s1", "s2"]
    assert [f.image_block_id for f in notes.sections[0].figures] == [b["i1"]["id"]]
    assert notes.sections[0].annotation_ids == [b["a1"]["id"]]
    assert len(notes.review_questions) == 5
    assert notes.title == "Renamed session"  # sessions.title wins over the lecture title
    saved = db.tables["lecture_notes"]
    assert len(saved) == 1 and saved[0]["content"]["sections"][0]["id"] == "s1"
    # only confirmed annotations reach Gemini
    assert "annotation_id=" + b["a1"]["id"] in gemini.calls[0][2][0]


def test_compile_includes_every_confirmed_annotation_and_its_image_once(db, gemini):
    lec = db.add("lectures", title="Cells")
    image_a = db.add("assets", lecture_id=lec["id"], kind="image", label="Cell A")
    image_b = db.add("assets", lecture_id=lec["id"], kind="image", label="Cell B")
    ses = db.add("sessions", lecture_id=lec["id"])
    text = db.add("blocks", session_id=ses["id"], kind="text", position=1, text="Cell structures.")
    block_a = db.add("blocks", session_id=ses["id"], kind="image", position=2, asset_id=image_a["id"])
    block_b = db.add("blocks", session_id=ses["id"], kind="image", position=3, asset_id=image_b["id"])
    confirmed = [
        db.add("annotations", session_id=ses["id"], block_id=block_a["id"], status="confirmed", label=f"A{i}")
        for i in range(4)
    ]
    confirmed.append(db.add(
        "annotations", session_id=ses["id"], block_id=block_b["id"], status="confirmed", label="B",
    ))
    db.add("annotations", session_id=ses["id"], block_id=block_a["id"], status="pending", label="pending")
    db.add("annotations", session_id=ses["id"], block_id=block_a["id"], status="rejected", label="rejected")
    gemini.result = NotesContent(title="Cells", overview="", review_questions=[], sections=[
        Section(
            id="s1", heading="Structures", paragraphs=[text["text"]], key_terms=[],
            figures=[Figure(image_block_id=block_a["id"], caption="A")],
            annotation_ids=[confirmed[0]["id"]],
        ),
    ])

    notes = main.compile_session(ses["id"])

    figures = [figure.image_block_id for section in notes.sections for figure in section.figures]
    annotation_ids = [annotation_id for section in notes.sections for annotation_id in section.annotation_ids]
    assert figures == [block_a["id"], block_b["id"]]
    assert len(annotation_ids) == len(set(annotation_ids)) == 5
    assert set(annotation_ids) == {annotation["id"] for annotation in confirmed}


def test_compile_rejects_generated_prose_and_saves_the_complete_cleaned_transcript(db, gemini):
    ses, _ = board(db)
    gemini.result = NotesContent(title="AI title", overview="Optional summary.", review_questions=["What makes ATP?"], sections=[
        Section(id="s1", heading="Cellular energy", paragraphs=[
            "The lesson introduces cellular structures and explains energy production in polished study prose."
        ], key_terms=[], figures=[], annotation_ids=[]),
    ])

    notes = main.compile_session(ses["id"])

    paragraphs = [paragraph for section in notes.sections for paragraph in section.paragraphs]
    assert paragraphs == ["Intro paragraph.", "Mitochondria make ATP."]
    assert notes.overview == "Optional summary."
    assert notes.review_questions == ["What makes ATP?"]
    saved = db.tables["lecture_notes"][0]["content"]
    assert [p for section in saved["sections"] for p in section["paragraphs"]] == paragraphs


def test_compile_keeps_each_cleaned_transcript_block_once_in_chronological_order(db, gemini):
    ses, b = board(db)
    gemini.result = NotesContent(title="Lecture title", overview="", review_questions=[], sections=[
        Section(id="s1", heading="Introduction", paragraphs=["Intro paragraph."], key_terms=[],
                figures=[Figure(image_block_id=b["i1"]["id"], caption="Cell")], annotation_ids=[]),
        Section(id="s2", heading="ATP", paragraphs=["Mitochondria make ATP."], key_terms=[],
                figures=[], annotation_ids=[b["a1"]["id"]]),
    ])

    notes = main.compile_session(ses["id"])

    assert [p for section in notes.sections for p in section.paragraphs] == [
        "Intro paragraph.", "Mitochondria make ATP.",
    ]
    assert [section.heading for section in notes.sections] == ["Introduction", "ATP"]


def test_compile_recovers_spoken_order_when_earlier_speech_was_refined_later(db, gemini):
    lec = db.add("lectures", title="Mountain ranges")
    ses = db.add("sessions", lecture_id=lec["id"])
    later_block = db.add(
        "blocks", session_id=ses["id"], kind="text", position=1,
        text="So here we have the tip of the mountain.", created_at=ts(5),
    )
    earlier_block = db.add(
        "blocks", session_id=ses["id"], kind="text", position=2,
        text="Today we're going to be learning about mountain ranges.", created_at=ts(8),
    )
    db.add(
        "transcript_segments", session_id=ses["id"], raw_text=later_block["text"],
        t_start=ts(3), t_end=ts(4), created_at=ts(5), text_block_id=later_block["id"],
    )
    db.add(
        "transcript_segments", session_id=ses["id"], raw_text=earlier_block["text"],
        t_start=ts(1), t_end=ts(2), created_at=ts(8), text_block_id=earlier_block["id"],
    )
    gemini.result = None

    notes = main.compile_session(ses["id"])

    assert [paragraph for section in notes.sections for paragraph in section.paragraphs] == [
        "Today we're going to be learning about mountain ranges.",
        "So here we have the tip of the mountain.",
    ]


@pytest.mark.parametrize("session_title, lecture_title, expected", [
    ("Cell energy, period 3", "Cells", "Cell energy, period 3"),   # his session name wins over Gemini's
    (None, "Cells", "Cells"),                                     # then his lecture name
    ("Untitled lecture", "Untitled lecture", "Gemini's title"),   # default name: Gemini's title is better
])
def test_compile_title_prefers_his_own_name(db, gemini, session_title, lecture_title, expected):
    lec = db.add("lectures", title=lecture_title)
    ses = db.add("sessions", lecture_id=lec["id"], title=session_title)
    db.add("blocks", session_id=ses["id"], kind="text", position=1, text="Some speech.")
    gemini.result = NotesContent(title="Gemini's title", overview="", sections=[], review_questions=[])
    assert main.compile_session(ses["id"]).title == expected


def test_compile_fallback_builds_sections_from_the_board(db, gemini):
    ses, b = board(db)
    gemini.result = None
    notes = main.compile_session(ses["id"])
    assert notes.title == "Lecture title"
    assert [s.paragraphs for s in notes.sections] == [["Intro paragraph."], ["Mitochondria make ATP."]]
    assert notes.sections[1].figures[0].image_block_id == b["i1"]["id"]
    assert notes.sections[1].annotation_ids == [b["a1"]["id"]]


def test_compile_empty_session_skips_gemini(db, gemini):
    lec = db.add("lectures", title="L")
    ses = db.add("sessions", lecture_id=lec["id"])
    notes = main.compile_session(ses["id"])
    assert notes.sections == [] and gemini.calls == []
    assert db.tables["lecture_notes"][0]["session_id"] == ses["id"]


def test_compile_unknown_session_is_404(db, gemini):
    with pytest.raises(HTTPException) as e:
        main.compile_session("nope")
    assert e.value.status_code == 404


# ---------- /sessions/{id}/refine ----------

def test_refine_appends_a_block_and_marks_segments(db, gemini):
    lec = db.add("lectures", title="L")
    db.add("assets", lecture_id=lec["id"], kind="text", key_terms=["ATP"])
    ses = db.add("sessions", lecture_id=lec["id"])
    db.add("blocks", session_id=ses["id"], kind="text", position=4, text="Earlier paragraph.")
    s1 = db.add("transcript_segments", session_id=ses["id"], raw_text="makes a tee pee", text_block_id=None,
                created_at=ts(1))
    db.add("transcript_segments", session_id=ses["id"], raw_text="done", text_block_id="old", created_at=ts(0))
    gemini.result = RefineGemini(text="Makes ATP.")

    out = main.refine_session(ses["id"])

    assert out.block["position"] == 5 and out.block["text"] == "Makes ATP."
    assert out.segment_ids == [s1["id"]]
    assert db.get("transcript_segments", s1["id"])["text_block_id"] == out.block["id"]
    prompt = gemini.calls[0][2][0]
    assert "ATP" in prompt and "Earlier paragraph." in prompt and "makes a tee pee" in prompt


def test_refine_orders_rapid_segments_by_speech_time_not_delayed_save_time(db, gemini):
    lec = db.add("lectures", title="Mountains")
    ses = db.add("sessions", lecture_id=lec["id"])
    later = db.add(
        "transcript_segments", session_id=ses["id"], raw_text="So here we have the tip of the mountain.",
        t_start=ts(4), t_end=ts(5), created_at=ts(6), text_block_id=None,
    )
    earlier = db.add(
        "transcript_segments", session_id=ses["id"], raw_text="Today we're going to learn about mountain ranges.",
        t_start=ts(1), t_end=ts(3), created_at=ts(8), text_block_id=None,
    )
    gemini.result = None

    out = main.refine_session(ses["id"])

    assert out.segment_ids == [earlier["id"], later["id"]]
    assert out.block["text"] == (
        "Today we're going to learn about mountain ranges. "
        "So here we have the tip of the mountain."
    )


def test_refine_uses_stable_ids_when_speech_times_are_identical(db, gemini):
    lec = db.add("lectures", title="Mountains")
    ses = db.add("sessions", lecture_id=lec["id"])
    for segment_id, text in [("segment-b", "second"), ("segment-a", "first")]:
        db.add(
            "transcript_segments", id=segment_id, session_id=ses["id"], raw_text=text,
            t_start=ts(1), t_end=ts(2), created_at=ts(3), text_block_id=None,
        )
    gemini.result = None

    out = main.refine_session(ses["id"])

    assert out.segment_ids == ["segment-a", "segment-b"]
    assert out.block["text"] == "first second"


def test_refine_accepts_near_verbatim_cleanup_that_only_removes_fillers_and_a_false_start():
    raw = (
        "Okay so um this here is the dirt path, and uh it goes all the way down the, "
        "sorry, along the mountain."
    )
    cleaned = "This here is the dirt path, and it goes all the way along the mountain."

    assert main.choose_refined_text(raw, cleaned) == cleaned
    assert "dirt path" in cleaned and "along the mountain" in cleaned
    assert " um " not in f" {cleaned.lower()} " and " uh " not in f" {cleaned.lower()} "


@pytest.mark.parametrize("rewritten", [
    "The mountain contains a continuous dirt trail that traverses its terrain.",
    "The teacher discussed a mountain path.",
])
def test_refine_rejects_paraphrased_or_truncated_output_and_preserves_raw_speech(rewritten):
    raw = (
        "Okay so um this here is the dirt path, and uh it goes all the way down the, "
        "sorry, along the mountain."
    )

    assert main.choose_refined_text(raw, rewritten) == raw


def test_refine_uses_the_refine_model_with_low_thinking(db, gemini, monkeypatch):
    lec = db.add("lectures", title="L")
    ses = db.add("sessions", lecture_id=lec["id"])
    gemini.result = RefineGemini(text="x")
    for env, expected in [("fast-model", ("fast-model", "LOW")), (None, (None, "LOW"))]:
        if env:
            monkeypatch.setenv("GEMINI_REFINE_MODEL", env)
        else:
            monkeypatch.delenv("GEMINI_REFINE_MODEL", raising=False)
        db.add("transcript_segments", session_id=ses["id"], raw_text="words", text_block_id=None, created_at=ts(0))
        main.refine_session(ses["id"])
        assert gemini.options[-1] == expected


def test_refine_splits_a_backlog_into_paragraphs_of_about_150_words(db, gemini):
    lec = db.add("lectures", title="L")
    ses = db.add("sessions", lecture_id=lec["id"])
    for i in range(10):  # 200 words of unrefined speech, e.g. after an outage
        db.add("transcript_segments", session_id=ses["id"], raw_text=" ".join(["word"] * 20), text_block_id=None,
               created_at=ts(i))
    gemini.result = None
    first = main.refine_session(ses["id"])
    second = main.refine_session(ses["id"])
    assert len(first.segment_ids) == 8 and len(second.segment_ids) == 2  # 8 x 20 = 160 >= 150
    assert main.refine_session(ses["id"]).block is None


def test_overlapping_refines_do_not_duplicate_a_paragraph(db, gemini):
    """Two tabs / a reload mid-refine: both calls would read the same segments without the per-session lock."""
    lec = db.add("lectures", title="L")
    ses = db.add("sessions", lecture_id=lec["id"])
    for i in range(3):
        db.add("transcript_segments", session_id=ses["id"], raw_text=f"line {i}", text_block_id=None,
               created_at=ts(i))
    gemini.result, gemini.delay = RefineGemini(text="Lines."), 0.2
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda _: main.refine_session(ses["id"]), range(2)))
    assert sorted(len(r.segment_ids) for r in results) == [0, 3]
    assert len([b for b in db.tables["blocks"] if b["kind"] == "text"]) == 1


def test_lecture_vocab_is_cached_per_session_but_not_when_empty(db, monkeypatch):
    lec = db.add("lectures", title="L")
    ses = db.add("sessions", lecture_id=lec["id"])
    assert main.lecture_vocab(db, ses["id"]) == []            # describe hasn't finished yet: not cached
    asset = db.add("assets", lecture_id=lec["id"], kind="text", key_terms=["ATP"])
    assert main.lecture_vocab(db, ses["id"]) == ["ATP"]       # picked up right away
    asset["key_terms"] = ["ATP", "glucose"]
    assert main.lecture_vocab(db, ses["id"]) == ["ATP"]       # cached
    now = main.time.monotonic()
    monkeypatch.setattr(main.time, "monotonic", lambda: now + main.VOCAB_TTL_S + 1)
    assert main.lecture_vocab(db, ses["id"]) == ["ATP", "glucose"]  # expired -> re-read


def test_compile_folds_unrefined_speech_into_the_board_first(db, gemini):
    ses, b = board(db)
    seg = db.add("transcript_segments", session_id=ses["id"], raw_text="and that is the end of class",
                 text_block_id=None, created_at=ts(99))
    gemini.result = None  # fallbacks for both the flush refine and compile
    notes = main.compile_session(ses["id"])
    assert db.get("transcript_segments", seg["id"])["text_block_id"]
    assert "and that is the end of class" in notes.sections[-1].paragraphs


def test_compile_refines_every_batch_in_a_long_lecture_without_truncating_the_end(db, gemini):
    lec = db.add("lectures", title="Long lecture")
    ses = db.add("sessions", lecture_id=lec["id"])
    segments = []
    for i in range(21):
        raw = " ".join([f"segment-{i}"] + ["word"] * 149)
        segments.append(db.add(
            "transcript_segments", session_id=ses["id"], raw_text=raw,
            text_block_id=None, created_at=ts(i),
        ))
    gemini.result = None

    notes = main.compile_session(ses["id"])

    assert all(db.get("transcript_segments", s["id"])["text_block_id"] for s in segments)
    assert any("segment-20" in paragraph for section in notes.sections for paragraph in section.paragraphs)


def test_refine_fallback_uses_raw_text_and_nothing_to_do_returns_null(db, gemini):
    lec = db.add("lectures", title="L")
    ses = db.add("sessions", lecture_id=lec["id"])
    assert main.refine_session(ses["id"]).block is None
    db.add("transcript_segments", session_id=ses["id"], raw_text="raw words", text_block_id=None, created_at=ts(0))
    gemini.result = None
    assert main.refine_session(ses["id"]).block["text"] == "raw words"


# ---------- /assets/{id}/describe ----------

def test_describe_text_caps_key_terms_and_saves(db, gemini):
    lec = db.add("lectures", title="L")
    a = db.add("assets", lecture_id=lec["id"], kind="text", text_content="Photosynthesis in the stroma.")
    gemini.result = DescribeOut(label="Photosynthesis", description="d", key_terms=[f"t{i}" for i in range(20)])
    out = main.describe_asset(a["id"])
    assert out.label == "Photosynthesis" and len(out.key_terms) == 15
    assert "Photosynthesis in the stroma." in gemini.calls[0][2][0]
    assert db.get("assets", a["id"])["label"] == "Photosynthesis"


def test_describe_sends_pdfs_as_pdf_parts(db, gemini, monkeypatch):
    monkeypatch.setattr(main, "download", lambda path: b"%PDF-1.4 fake")
    lec = db.add("lectures", title="L")
    a = db.add("assets", lecture_id=lec["id"], kind="pdf", storage_path="lec/notes.pdf", file_name="notes.pdf")
    gemini.result = DescribeOut(label="Notes", description="d", key_terms=[])
    main.describe_asset(a["id"])
    part = gemini.calls[0][2][0]
    assert part.inline_data.mime_type == "application/pdf" and part.inline_data.data == b"%PDF-1.4 fake"


def test_describe_missing_file_falls_back_to_the_file_name_without_calling_gemini(db, gemini, monkeypatch):
    def gone(path):
        raise RuntimeError("Object not found")
    monkeypatch.setattr(main, "download", gone)
    lec = db.add("lectures", title="L")
    b = db.add("assets", lecture_id=lec["id"], kind="image", storage_path="lec/x.png", file_name="x.png")
    assert main.describe_asset(b["id"]).label == "x.png"
    assert db.get("assets", b["id"])["label"] == "x.png" and gemini.calls == []


def test_describe_unknown_asset_is_404(db, gemini):
    with pytest.raises(HTTPException) as e:
        main.describe_asset("nope")
    assert e.value.status_code == 404
