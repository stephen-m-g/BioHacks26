"""FastAPI app: CORS, routes, GET /health. Run: uvicorn main:app --reload --port 8000
Spec: docs/CONTEXT.md (v2)."""
import base64
import io
import logging
import mimetypes
import os
import time
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv

load_dotenv()  # before anything reads os.environ

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from PIL import Image  # noqa: E402

import ai  # noqa: E402
import prompts  # noqa: E402
from db import download, get_db  # noqa: E402
from schemas import (  # noqa: E402
    CloseGemini, CloseIn, CloseOut, DescribeOut, Figure, NotesContent, RefineGemini, RefineOut, Section,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("main")

REQUIRED_ENV = ["GEMINI_API_KEY", "GEMINI_MODEL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WEB_ORIGIN"]
missing = [k for k in REQUIRED_ENV if not os.getenv(k)]
if missing:
    log.warning("missing env vars in api/.env: %s", ", ".join(missing))

# Dev: allow every origin (cloudflared URL, teammates' localhost). Set False before the final deploy.
ALLOW_ALL_ORIGINS = True
origins = [o.strip() for o in os.getenv("WEB_ORIGIN", "").split(",") if o.strip()]
if ALLOW_ALL_ORIGINS:
    origins.append("*")

app = FastAPI(title="BioHacks26 API")
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["*"], allow_headers=["*"])


def ms(t0: float) -> float:
    return (time.perf_counter() - t0) * 1000


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/sessions/{session_id}/refine", response_model=RefineOut)
def refine_session(session_id: str) -> RefineOut:
    """Clean the session's unrefined segments into one text block appended to the board.
    Fallback: the joined raw text."""
    t0 = time.perf_counter()
    db = get_db()
    segs = (
        db.table("transcript_segments")
        .select("id, raw_text, t_start, created_at")
        .eq("session_id", session_id)
        .is_("text_block_id", "null")
        .order("created_at")
        .execute()
        .data
    )
    if not segs:
        return RefineOut(block=None, segment_ids=[])

    vocab = lecture_vocab(db, session_id)
    blocks = (
        db.table("blocks").select("kind, position, text").eq("session_id", session_id)
        .order("position", desc=True).execute().data
    )
    max_pos = blocks[0]["position"] if blocks else 0.0
    prev_text = next((b["text"] for b in blocks if b["kind"] == "text" and b.get("text")), "")
    db_read_ms = ms(t0)

    raw = " ".join(s["raw_text"].strip() for s in segs if s["raw_text"].strip())
    prompt = (
        f"Lecture vocabulary: {', '.join(vocab) if vocab else '(none)'}\n\n"
        f"Previous paragraph: {prev_text[-600:] or '(none)'}\n\n"
        f"New raw speech: {raw}"
    )
    out, gemini_ms = ai.generate("refine", prompts.REFINE, [prompt], RefineGemini, timeout_ms=10_000)
    text = (out.text if out else "") or raw

    t_write = time.perf_counter()
    block = (
        db.table("blocks")
        .insert({"session_id": session_id, "kind": "text", "position": max_pos + 1, "text": text})
        .execute()
        .data[0]
    )
    ids = [s["id"] for s in segs]
    db.table("transcript_segments").update({"text_block_id": block["id"]}).in_("id", ids).execute()
    log.info("[refine] segs=%d db=%.0fms gemini=%.0fms total=%.0fms%s", len(ids),
             db_read_ms + ms(t_write), gemini_ms, ms(t0), "" if out else " (fallback: raw)")
    return RefineOut(block=block, segment_ids=ids)


def lecture_vocab(db, session_id: str) -> list[str]:
    """Union of key_terms over the session's lecture assets (filled in by /describe)."""
    session = db.table("sessions").select("lecture_id").eq("id", session_id).limit(1).execute().data
    if not session:
        return []
    assets = db.table("assets").select("key_terms").eq("lecture_id", session[0]["lecture_id"]).execute().data
    return sorted({t for a in assets for t in (a.get("key_terms") or [])})


@app.post("/assets/{asset_id}/describe", response_model=DescribeOut)
def describe_asset(asset_id: str) -> DescribeOut:
    """Label an uploaded image / PDF / text and store label, description, key_terms on the row.
    Fallback: label = file name (or "Text note"), the rest empty."""
    t0 = time.perf_counter()
    db = get_db()
    rows = db.table("assets").select("*").eq("id", asset_id).limit(1).execute().data
    if not rows:
        raise HTTPException(404, "asset not found")
    asset = rows[0]
    fallback = DescribeOut(label=asset.get("file_name") or "Text note", description="", key_terms=[])

    contents = asset_contents(asset)
    db_ms = ms(t0)
    out, gemini_ms = (None, 0.0)
    if contents:
        out, gemini_ms = ai.generate("describe", prompts.DESCRIBE, contents, DescribeOut, timeout_ms=30_000)
    result = DescribeOut(label=out.label, description=out.description, key_terms=out.key_terms[:15]) if out else fallback

    t_write = time.perf_counter()
    db.table("assets").update(result.model_dump()).eq("id", asset_id).execute()
    log.info("[describe] kind=%s db=%.0fms gemini=%.0fms total=%.0fms%s", asset.get("kind"),
             db_ms + ms(t_write), gemini_ms, ms(t0), "" if out else " (fallback)")
    return result


def asset_contents(asset: dict) -> list | None:
    """Gemini contents for an asset: the file as a part (image/pdf) or its text. None if unavailable."""
    name = asset.get("file_name") or ""
    if asset.get("kind") == "text":
        text = (asset.get("text_content") or "").strip()
        return [f"File name: {name or '(typed text)'}\n\nTeaching material:\n{text[:30_000]}"] if text else None
    path = asset.get("storage_path") or ""
    if not path:
        return None
    try:
        t0 = time.perf_counter()
        data = download(path)
        log.info("[describe] downloaded %d KB in %.0fms", len(data) // 1024, ms(t0))
    except Exception as e:  # noqa: BLE001 - missing file -> fallback, not a 500
        log.warning("[describe] download failed for %s: %s", path, e)
        return None
    mime = "application/pdf" if asset["kind"] == "pdf" else (mimetypes.guess_type(path)[0] or "image/png")
    return [ai.image_part(data, mime), f"File name: {name}"]


@app.post("/annotations/{annotation_id}/close", response_model=CloseOut)
def close_annotation(annotation_id: str, body: CloseIn | None = None) -> CloseOut:
    """Confirm a lasso and pick the teacher's words about it.
    Fallback: label "Annotation", bubble_text = joined candidate text (max 70 words)."""
    t0 = time.perf_counter()
    db = get_db()
    rows = db.table("annotations").select("*").eq("id", annotation_id).limit(1).execute().data
    if not rows:
        raise HTTPException(404, "annotation not found")
    ann = rows[0]
    # The frontend also sets these, but its update can land after this call.
    closed_at = parse_ts(ann["closed_at"]) if ann.get("closed_at") else datetime.now(timezone.utc)
    if ann.get("status") != "confirmed" or not ann.get("closed_at"):
        db.table("annotations").update({"status": "confirmed", "closed_at": closed_at.isoformat()}) \
            .eq("id", annotation_id).execute()

    segs = close_candidates(db, ann, closed_at)
    asset = block_asset(db, ann.get("block_id"))
    vocab = lecture_vocab(db, ann["session_id"]) if segs else []
    image = selection_image(body, asset, ann.get("bbox"))
    db_ms = ms(t0)

    contents: list = []
    if image:
        contents.append(ai.image_part(*image))
    contents.append(f"Whole image: {asset.get('label') or '(unlabelled)'}. {asset.get('description') or ''}".strip())
    if vocab:
        contents.append(f"Lecture vocabulary: {', '.join(vocab)}")
    if segs:
        lines = [f"{i}. {'[OPEN] ' if s.get('annotation_id') == annotation_id else ''}{s['raw_text'].strip()}"
                 for i, s in enumerate(segs, 1)]
        contents.append("Transcript (numbered):\n" + "\n".join(lines) +
                        "\n\nAlso return used_segments: the line numbers your bubble_text came from.")
    else:
        contents.append("Transcript: (he said nothing). Return bubble_text \"\" and used_segments [].")

    out, gemini_ms = ai.generate("close", prompts.CLOSE, contents, CloseGemini, timeout_ms=20_000)
    if out:
        label = out.label.strip() or "Annotation"
        bubble = truncate_words(out.bubble_text.strip(), 70) or None
        used = [segs[n - 1] for n in out.used_segments if 1 <= n <= len(segs)] if bubble else []
    else:
        label = "Annotation"
        # Without Gemini, speech from while the lasso was open ([OPEN]) is the best guess; else the whole window.
        used = [s for s in segs if s.get("annotation_id") == annotation_id] or segs
        bubble = truncate_words(" ".join(s["raw_text"].strip() for s in used), 70) or None
    if not segs:
        bubble = None

    t_write = time.perf_counter()
    db.table("annotations").update({"label": label, "bubble_text": bubble}).eq("id", annotation_id).execute()
    # Link the segments used (without stealing another annotation's), and untag tagged ones it didn't use.
    link = [s["id"] for s in used if s.get("annotation_id") in (None, annotation_id)]
    if link:
        db.table("transcript_segments").update({"annotation_id": annotation_id}).in_("id", link).execute()
    unused = [s["id"] for s in segs if s.get("annotation_id") == annotation_id and s["id"] not in link]
    if unused and out:
        db.table("transcript_segments").update({"annotation_id": None}).in_("id", unused).execute()
    log.info("[close] segs=%d used=%d image=%s db=%.0fms gemini=%.0fms total=%.0fms%s", len(segs), len(link),
             "yes" if image else "no", db_ms + ms(t_write), gemini_ms, ms(t0), "" if out else " (fallback)")
    return CloseOut(label=label, bubble_text=bubble)


def close_candidates(db, ann: dict, closed_at: datetime) -> list[dict]:
    """Segments from 5 s before the lasso until it was confirmed, plus any tagged with it, in time order."""
    drawn_at = parse_ts(ann["drawn_at"]) if ann.get("drawn_at") else closed_at
    cols = "id, raw_text, t_start, created_at, annotation_id"
    window = (
        db.table("transcript_segments").select(cols)
        .eq("session_id", ann["session_id"])
        .gte("t_start", (drawn_at - timedelta(seconds=5)).isoformat())
        .lte("t_start", closed_at.isoformat())
        .execute().data
    )
    tagged = db.table("transcript_segments").select(cols).eq("annotation_id", ann["id"]).execute().data
    by_id = {s["id"]: s for s in window + tagged if (s.get("raw_text") or "").strip()}
    return sorted(by_id.values(), key=lambda s: s.get("t_start") or s.get("created_at") or "")


def block_asset(db, block_id: str | None) -> dict:
    if not block_id:
        return {}
    blocks = db.table("blocks").select("asset_id").eq("id", block_id).limit(1).execute().data
    if not blocks or not blocks[0].get("asset_id"):
        return {}
    assets = (db.table("assets").select("id, label, description, storage_path, kind")
              .eq("id", blocks[0]["asset_id"]).limit(1).execute().data)
    return assets[0] if assets else {}


def selection_image(body: CloseIn | None, asset: dict, bbox: dict | None) -> tuple[bytes, str] | None:
    """(bytes, mime) of what he selected: the frontend's crop if sent, else the asset cropped to bbox."""
    if body and body.crop_png_base64:
        try:
            b64 = body.crop_png_base64.split(",", 1)[-1]  # tolerate a data: URL prefix
            return base64.b64decode(b64), "image/png"
        except ValueError:
            log.warning("[close] bad crop_png_base64, using the asset image")
    path = asset.get("storage_path") or ""
    if not path or path.startswith("data:"):
        return None
    try:
        data = download(path)
    except Exception as e:  # noqa: BLE001
        log.warning("[close] download failed for %s: %s", path, e)
        return None
    try:
        return crop_to_bbox(data, bbox), "image/png"
    except Exception as e:  # noqa: BLE001 - odd format (e.g. HEIC): send the whole image instead
        log.warning("[close] crop failed (%s), sending the whole image", e)
        return data, mimetypes.guess_type(path)[0] or "image/png"


def crop_to_bbox(data: bytes, bbox: dict | None, pad: float = 0.08) -> bytes:
    """Crop an image to a normalized {x, y, w, h} box plus a small margin, as PNG."""
    img = Image.open(io.BytesIO(data))
    img.load()
    if bbox:
        W, H = img.size
        x0 = max(0.0, bbox["x"] - pad * bbox["w"]) * W
        y0 = max(0.0, bbox["y"] - pad * bbox["h"]) * H
        x1 = min(1.0, bbox["x"] + bbox["w"] * (1 + pad)) * W
        y1 = min(1.0, bbox["y"] + bbox["h"] * (1 + pad)) * H
        if x1 - x0 >= 4 and y1 - y0 >= 4:
            img = img.crop((int(x0), int(y0), int(x1), int(y1)))
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


@app.post("/sessions/{session_id}/compile", response_model=NotesContent)
def compile_session(session_id: str) -> NotesContent:
    """Build the study document and upsert lecture_notes. Fallback: sections straight from the board."""
    t0 = time.perf_counter()
    db = get_db()
    rows = db.table("sessions").select("*").eq("id", session_id).limit(1).execute().data
    if not rows:
        raise HTTPException(404, "session not found")
    lecture_id = rows[0]["lecture_id"]
    lecture = db.table("lectures").select("title").eq("id", lecture_id).limit(1).execute().data
    # sessions.title (renamable per session) wins over the lecture title.
    title = rows[0].get("title") or (lecture[0]["title"] if lecture else "") or "Lecture notes"
    blocks = db.table("blocks").select("*").eq("session_id", session_id).order("position").execute().data
    anns = (db.table("annotations").select("id, block_id, label, bubble_text")
            .eq("session_id", session_id).eq("status", "confirmed").execute().data)
    assets = (db.table("assets").select("id, kind, label, description, text_content, file_name")
              .eq("lecture_id", lecture_id).execute().data)
    db_ms = ms(t0)

    out, gemini_ms = (None, 0.0)
    if any(b["kind"] == "text" and (b.get("text") or "").strip() for b in blocks):
        doc = compile_input(title, blocks, anns, assets)
        out, gemini_ms = ai.generate("compile", prompts.COMPILE, [doc], NotesContent, timeout_ms=120_000)
    notes = clean_notes(out, blocks, anns, title) if out else fallback_notes(title, blocks, anns)

    t_write = time.perf_counter()
    db.table("lecture_notes").upsert({"session_id": session_id, "content": notes.model_dump()}).execute()
    log.info("[compile] blocks=%d anns=%d sections=%d db=%.0fms gemini=%.0fms total=%.0fms%s", len(blocks),
             len(anns), len(notes.sections), db_ms + ms(t_write), gemini_ms, ms(t0), "" if out else " (fallback)")
    return notes


def compile_input(title: str, blocks: list, anns: list, assets: list) -> str:
    """The whole session as one text document, with the ids Gemini may reference."""
    assets_by_id = {a["id"]: a for a in assets}
    anns_by_block: dict[str, list] = {}
    for a in anns:
        anns_by_block.setdefault(a["block_id"], []).append(a)
    lines = [f"LECTURE TITLE: {title}", "", "BOARD, in teaching order:"]
    for b in blocks:
        if b["kind"] == "text" and (b.get("text") or "").strip():
            lines.append(f"[TEXT] {b['text'].strip()}")
        elif b["kind"] == "image":
            a = assets_by_id.get(b.get("asset_id"), {})
            lines.append(f"[IMAGE image_block_id={b['id']}] {a.get('label') or 'image'}: {a.get('description') or ''}")
            for ann in anns_by_block.get(b["id"], []):
                lines.append(f"    [ANNOTATION annotation_id={ann['id']}] {ann.get('label') or ''}: "
                             f"\"{ann.get('bubble_text') or ''}\"")
    materials = [a for a in assets if a["kind"] in ("text", "pdf")]
    if materials:
        lines += ["", "TEACHING MATERIALS (prepared before class):"]
        for a in materials:
            body = (a.get("text_content") or "")[:4000] if a["kind"] == "text" else ""
            name = a.get("label") or a.get("file_name") or "material"
            lines.append(f"- {name}: {a.get('description') or ''} {body}".strip())
    lines += ["", "Section ids: use s1, s2, ... in order."]
    return "\n".join(lines)


def clean_notes(notes: NotesContent, blocks: list, anns: list, title: str) -> NotesContent:
    """Drop ids Gemini invented, renumber sections, cap review questions."""
    image_ids = {b["id"] for b in blocks if b["kind"] == "image"}
    ann_ids = {a["id"] for a in anns}
    for i, s in enumerate(notes.sections, 1):
        s.id = f"s{i}"
        s.figures = [f for f in s.figures if f.image_block_id in image_ids]
        s.annotation_ids = [a for a in s.annotation_ids if a in ann_ids]
    notes.title = notes.title or title
    notes.review_questions = notes.review_questions[:5]
    return notes


def fallback_notes(title: str, blocks: list, anns: list) -> NotesContent:
    """No Gemini: a new section at each image; paragraphs = the refined text blocks."""
    sections: list[Section] = []
    for b in blocks:
        if b["kind"] == "image" or not sections:
            n = len(sections) + 1
            sections.append(Section(id=f"s{n}", heading=f"Part {n}", paragraphs=[], key_terms=[],
                                    figures=[], annotation_ids=[]))
        s = sections[-1]
        if b["kind"] == "image":
            s.figures.append(Figure(image_block_id=b["id"], caption=""))
            s.annotation_ids += [a["id"] for a in anns if a["block_id"] == b["id"]]
        elif (b.get("text") or "").strip():
            s.paragraphs.append(b["text"].strip())
    sections = [s for s in sections if s.paragraphs or s.figures]
    return NotesContent(title=title, overview="", sections=sections, review_questions=[])


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def truncate_words(text: str, n: int) -> str:
    words = text.split()
    return text if len(words) <= n else " ".join(words[:n]) + "…"
