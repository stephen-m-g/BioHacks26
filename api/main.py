"""FastAPI app: CORS, routes, GET /health. Run: uvicorn main:app --reload --port 8000
Spec: docs/CONTEXT.md (v2)."""
import base64
import io
import logging
import mimetypes
import os
import threading
import time
import uuid
from collections import Counter
from datetime import datetime, timezone

from dotenv import load_dotenv

load_dotenv()  # before anything reads os.environ

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from PIL import Image  # noqa: E402

import ai  # noqa: E402
import cleanup  # noqa: E402
import prompts  # noqa: E402
import scribe  # noqa: E402
from db import download, get_db  # noqa: E402
from schemas import (  # noqa: E402
    CloseGemini, CloseIn, CloseOut, DescribeOut, Figure, NotesContent, RefineGemini, RefineOut, ScribeTokenOut,
    Section,
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


MAX_REFINE_WORDS = 150  # ~1 min of speech; a backlog (after an outage) becomes several paragraphs, not one wall
_refine_locks: dict[str, threading.Lock] = {}
_refine_locks_guard = threading.Lock()


def refine_lock(session_id: str) -> threading.Lock:
    """One lock per session: overlapping refines (two tabs, a reload mid-refine, compile's flush) must not turn
    the same segments into two paragraphs. In-process only, which is fine for a single API process."""
    with _refine_locks_guard:
        return _refine_locks.setdefault(session_id, threading.Lock())


@app.post("/sessions/{session_id}/refine", response_model=RefineOut)
def refine_session(session_id: str) -> RefineOut:
    """Clean the session's unrefined segments into one text block appended to the board.
    Fallback: the joined raw text."""
    with refine_lock(session_id):
        return refine_batch(get_db(), session_id)


def refine_batch(db, session_id: str) -> RefineOut:
    """Refine the oldest unrefined segments (up to ~MAX_REFINE_WORDS) into one text block. Call under refine_lock."""
    t0 = time.perf_counter()
    unrefined = (
        db.table("transcript_segments")
        .select("id, raw_text, t_start, t_end, created_at")
        .eq("session_id", session_id)
        .is_("text_block_id", "null")
        .execute()
        .data
    )
    unrefined.sort(key=segment_order_key)
    segs, words = [], 0
    for s in unrefined:
        segs.append(s)
        words += len(s["raw_text"].split())
        if words >= MAX_REFINE_WORDS:
            break  # the rest goes in the next call
    if not segs:
        return RefineOut(block=None, segment_ids=[])

    vocab = lecture_vocab(db, session_id)
    blocks = (
        db.table("blocks").select("*").eq("session_id", session_id)
        .order("position", desc=True).execute().data
    )
    max_pos = blocks[0]["position"] if blocks else 0.0
    prev_block = next((b for b in blocks if b["kind"] == "text" and b.get("text")), None)
    prev_text = prev_block["text"] if prev_block else ""
    db_read_ms = ms(t0)

    # Fast model, little thinking: eval_refine.py scored lite+LOW 40/40 at ~0.7 s vs 2.6 s for 3.6-flash default.
    out, gemini_ms = ai.generate("refine", prompts.REFINE, [refine_prompt(vocab, prev_text, segs)], RefineGemini,
                                 timeout_ms=10_000, model=os.getenv("GEMINI_REFINE_MODEL") or None, thinking="LOW")
    cleaned_segments, outcomes = choose_refined_segments(segs, out)
    text, offsets = join_refined_segments(cleaned_segments)

    t_write = time.perf_counter()
    if text or not prev_block:
        block = (
            db.table("blocks")
            .insert({"session_id": session_id, "kind": "text", "position": max_pos + 1, "text": text})
            .execute()
            .data[0]
        )
    else:
        block = prev_block  # only filler was said: mark it refined without adding an empty paragraph
    ids = [s["id"] for s in segs]
    for segment, (text_start, text_end) in zip(segs, offsets):
        db.table("transcript_segments").update({
            "text_block_id": block["id"], "text_start": text_start, "text_end": text_end,
        }).eq("id", segment["id"]).execute()
    log.info("[refine] segs=%d words_in=%d words_out=%d left=%d gemini=%s outcomes=%s db=%.0fms gemini=%.0fms "
             "total=%.0fms", len(ids), words, len(text.split()), len(unrefined) - len(ids),
             "ok" if out else "failed", dict(sorted(outcomes.items())), db_read_ms + ms(t_write), gemini_ms, ms(t0))
    return RefineOut(block=block, segment_ids=ids)


def refine_prompt(vocab: list[str], prev_text: str, segments: list[dict]) -> str:
    source = "\n".join(f"[SEGMENT id={segment['id']}] {segment['raw_text'].strip()}" for segment in segments)
    return (
        f"Lecture vocabulary: {', '.join(vocab) if vocab else '(none)'}\n\n"
        f"Previous paragraph: {prev_text[-600:] or '(none)'}\n\n"
        f"New raw speech segments in chronological order:\n{source}"
    )


def choose_refined_segments(segments: list[dict], out: RefineGemini | None) -> tuple[list[str], Counter]:
    """Cleaned text per source segment, in source order; "" when the segment was only filler.

    Each segment is judged on its own against its own raw text, so one bad segment cannot discard the cleanup of
    the others, and words cannot move between stable ids (they would be an insertion in one segment and a content
    deletion in the other). A segment whose Gemini text is missing or unsafe gets the deterministic cleanup.
    Outcome counts (no transcript text) are returned for logging.
    """
    raw_parts = [segment["raw_text"].strip() for segment in segments]
    candidates: list[str | None] = [None] * len(segments)
    outcomes: Counter = Counter()
    if out is None:
        outcomes["gemini_failed"] = len(segments)
    elif out.segments:
        position = {segment["id"]: i for i, segment in enumerate(segments)}
        id_counts = Counter(segment.id for segment in out.segments)
        usable = [segment for segment in out.segments if segment.id in position and id_counts[segment.id] == 1]
        order = [position[segment.id] for segment in usable]
        if order != sorted(order):
            outcomes["reordered_ids"] = len(segments)  # a shuffled map means Gemini lost track of the boundaries
        else:
            for segment in usable:
                candidates[position[segment.id]] = segment.text
        outcomes["unknown_or_duplicate_ids"] += len(out.segments) - len(usable)
    elif len(segments) == 1:
        candidates[0] = out.text
    else:
        outcomes["no_segment_map"] = len(segments)

    cleaned = []
    for raw, candidate in zip(raw_parts, candidates):
        if candidate is not None:
            check = cleanup.check_cleanup(raw, candidate)
            if check.ok:
                cleaned.append(" ".join(candidate.split()))
                outcomes["accepted_changed" if tokens_changed(raw, candidate) else "accepted_unchanged"] += 1
                outcomes["fillers_removed"] += check.fillers
                outcomes["words_removed"] += check.deleted
                outcomes["corrections"] += check.corrected
                continue
            outcomes[f"rejected:{check.reason}"] += 1
        elif out is not None and not outcomes["reordered_ids"] and not outcomes["no_segment_map"]:
            outcomes["missing_id"] += 1
        fallback = cleanup.basic_cleanup(raw)
        outcomes["fallback_cleaned" if fallback != raw else "fallback_raw"] += 1
        cleaned.append(fallback)
    rejected = sum(v for k, v in outcomes.items() if k.startswith("rejected:"))
    if rejected or out is None:
        log.warning("[refine] %d/%d segments used the deterministic fallback (%s)",
                    outcomes["fallback_cleaned"] + outcomes["fallback_raw"], len(segments),
                    ", ".join(k for k in sorted(outcomes) if k.startswith("rejected:")) or "gemini failed")
    return cleaned, +outcomes


def tokens_changed(raw: str, candidate: str) -> bool:
    return cleanup.tokens(raw) != cleanup.tokens(candidate)


def utf16_length(value: str) -> int:
    """Return browser-compatible String.length units for persisted source spans."""
    return len(value.encode("utf-16-le")) // 2


def join_refined_segments(parts: list[str]) -> tuple[str, list[tuple[int | None, int | None]]]:
    """Join with one space and return exact half-open UTF-16 offsets for every source segment.
    A segment with no cleaned text (only filler) gets (None, None): the schema forbids empty spans."""
    text = ""
    offsets: list[tuple[int | None, int | None]] = []
    for part in parts:
        part = part.strip()
        if not part:
            offsets.append((None, None))
            continue
        if text:
            text += " "
        start = utf16_length(text)
        text += part
        offsets.append((start, utf16_length(text)))
    return text, offsets


def segment_order_key(segment: dict) -> tuple[str, str, str, str]:
    """Speech occurrence first; callback/save time and id only break ties deterministically."""
    created = segment.get("created_at") or ""
    start = segment.get("t_start") or created
    end = segment.get("t_end") or start
    return start, end, created, segment.get("id") or ""


def choose_refined_text(raw: str, candidate: str | None) -> str:
    """Use Gemini's cleanup only when every change is a safe edit (see cleanup.check_cleanup); else the raw text.

    The raw text is the source of truth: fillers, stutters, false starts and sound-alike corrections
    ("a tee pee" -> "ATP") pass, while summaries, paraphrases, truncation and changed numbers or negations don't.
    """
    raw = raw.strip()
    candidate = (candidate or "").strip()
    if not candidate:
        return raw
    check = cleanup.check_cleanup(raw, candidate)
    if not check.ok:
        log.warning("[close] rejected unfaithful Gemini output (%s)", check.reason)
        return raw
    return candidate


VOCAB_TTL_S = 120
_vocab_cache: dict[str, tuple[float, list[str]]] = {}


def lecture_vocab(db, session_id: str) -> list[str]:
    """Union of key_terms over the session's lecture assets (filled in by /describe). Cached ~2 min per session:
    every refine reads it (2 DB round trips) and assets rarely change mid-class. Empty results aren't cached, so
    terms from a /describe that is still running show up as soon as they exist."""
    hit = _vocab_cache.get(session_id)
    if hit and time.monotonic() - hit[0] < VOCAB_TTL_S:
        return hit[1]
    session = db.table("sessions").select("lecture_id").eq("id", session_id).limit(1).execute().data
    if not session:
        return []
    assets = db.table("assets").select("key_terms").eq("lecture_id", session[0]["lecture_id"]).execute().data
    vocab = sorted({t for a in assets for t in (a.get("key_terms") or [])})
    if vocab:
        _vocab_cache[session_id] = (time.monotonic(), vocab)
    return vocab


@app.post("/sessions/{session_id}/scribe-token", response_model=ScribeTokenOut)
def scribe_token(session_id: str) -> ScribeTokenOut:
    """Single-use ElevenLabs Scribe Realtime token for a live session's teacher client.
    There is no user auth yet: issuance is limited to existing live sessions and rate-limited."""
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        raise HTTPException(503, "ElevenLabs is not configured on the server")
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(404, "session not found") from None
    rows = get_db().table("sessions").select("status").eq("id", session_id).limit(1).execute().data
    if not rows:
        raise HTTPException(404, "session not found")
    if rows[0].get("status") != "live":
        raise HTTPException(409, "session is not live")
    if not scribe.per_session_limiter.allow(session_id) or not scribe.global_limiter.allow("all"):
        raise HTTPException(429, "too many token requests; try again in a minute")
    t0 = time.perf_counter()
    try:
        token = scribe.create_realtime_token(api_key)
    except scribe.ScribeTokenError as e:
        log.warning("[scribe-token] %s", e)
        raise HTTPException(502, "could not get an ElevenLabs token") from None
    log.info("[scribe-token] issued in %.0fms", ms(t0))
    return ScribeTokenOut(token=token)


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
    """Confirm a lasso and clean all speech deterministically captured while it was open."""
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

    segs = reconcile_annotation_segments(db, ann, closed_at)
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
        lines = [f"{i}. {s['raw_text'].strip()}" for i, s in enumerate(segs, 1)]
        contents.append("Captured transcript (numbered, all lines belong to this annotation):\n" + "\n".join(lines) +
                        "\n\nClean every line in order. Return all line numbers in used_segments.")
    else:
        contents.append("Transcript: (he said nothing). Return bubble_text \"\" and used_segments [].")

    out, gemini_ms = ai.generate("close", prompts.CLOSE, contents, CloseGemini, timeout_ms=20_000)
    if out:
        label = out.label.strip() or "Annotation"
        raw = " ".join(s["raw_text"].strip() for s in segs)
        bubble = choose_refined_text(raw, out.bubble_text) or None
    else:
        label = "Annotation"
        bubble = " ".join(s["raw_text"].strip() for s in segs) or None
    if not segs:
        bubble = None

    t_write = time.perf_counter()
    db.table("annotations").update({"label": label, "bubble_text": bubble}).eq("id", annotation_id).execute()
    log.info("[close] segs=%d image=%s db=%.0fms gemini=%.0fms total=%.0fms%s", len(segs),
             "yes" if image else "no", db_ms + ms(t_write), gemini_ms, ms(t0), "" if out else " (fallback)")
    return CloseOut(label=label, bubble_text=bubble)


def reconcile_annotation_segments(db, ann: dict, closed_at: datetime) -> list[dict]:
    """Link only unowned segments fully contained in [drawn_at, closed_at]; never steal or guess crossings."""
    drawn_at = parse_ts(ann["drawn_at"]) if ann.get("drawn_at") else closed_at
    cols = "id, raw_text, t_start, t_end, created_at, annotation_id"
    rows = (db.table("transcript_segments").select(cols)
            .eq("session_id", ann["session_id"]).execute().data)
    link, unlink = [], []
    for segment in rows:
        start = parse_ts(segment["t_start"]) if segment.get("t_start") else None
        end = parse_ts(segment["t_end"]) if segment.get("t_end") else start
        contained = start is not None and end is not None and drawn_at <= start and end <= closed_at
        if segment.get("annotation_id") == ann["id"] and not contained:
            unlink.append(segment["id"])
        elif segment.get("annotation_id") is None and contained:
            link.append(segment["id"])
    if unlink:
        db.table("transcript_segments").update({"annotation_id": None}).in_("id", unlink).execute()
    if link:
        db.table("transcript_segments").update({"annotation_id": ann["id"]}).in_("id", link).execute()
    captured = [
        segment for segment in rows
        if segment["id"] not in unlink and (segment.get("annotation_id") == ann["id"] or segment["id"] in link)
        and (segment.get("raw_text") or "").strip()
    ]
    return sorted(captured, key=segment_order_key)


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
    # Speech that was never refined (e.g. the tab closed without End session) becomes paragraphs first.
    with refine_lock(session_id):
        while refine_batch(db, session_id).block is not None:
            pass
    blocks = db.table("blocks").select("*").eq("session_id", session_id).order("position").execute().data
    segments = (db.table("transcript_segments").select("id, text_block_id, t_start, t_end, created_at")
                .eq("session_id", session_id).execute().data)
    blocks = chronological_blocks(blocks, segments)
    anns = (db.table("annotations").select("id, session_id, block_id, status, drawn_at, closed_at, label, bubble_text")
            .eq("session_id", session_id).eq("status", "confirmed").execute().data)
    for ann in anns:
        closed_at = parse_ts(ann["closed_at"]) if ann.get("closed_at") else datetime.now(timezone.utc)
        reconcile_annotation_segments(db, ann, closed_at)
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


def chronological_blocks(blocks: list[dict], segments: list[dict]) -> list[dict]:
    """Order text blocks by their earliest spoken segment while leaving image slots in place."""
    ordered = sorted(blocks, key=lambda block: (block.get("position", 0), block.get("id") or ""))
    by_block: dict[str, list[dict]] = {}
    for segment in segments:
        if segment.get("text_block_id"):
            by_block.setdefault(segment["text_block_id"], []).append(segment)
    timed_indexes = [
        index for index, block in enumerate(ordered)
        if block["kind"] == "text" and by_block.get(block["id"])
    ]
    timed_blocks = sorted(
        (ordered[index] for index in timed_indexes),
        key=lambda block: (min(segment_order_key(segment) for segment in by_block[block["id"]]), block["id"]),
    )
    for index, block in zip(timed_indexes, timed_blocks):
        ordered[index] = block
    return ordered


def compile_input(title: str, blocks: list, anns: list, assets: list) -> str:
    """The whole session as one text document, with the ids Gemini may reference."""
    assets_by_id = {a["id"]: a for a in assets}
    anns_by_block: dict[str, list] = {}
    for a in anns:
        anns_by_block.setdefault(a["block_id"], []).append(a)
    lines = [f"LECTURE TITLE: {title}", "", "BOARD, in teaching order:"]
    for b in blocks:
        if b["kind"] == "text" and (b.get("text") or "").strip():
            lines.append(f"[TEXT text_block_id={b['id']}] {b['text'].strip()}")
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


DEFAULT_TITLE = "Untitled lecture"  # what the web app names a lecture until he renames it


def clean_notes(notes: NotesContent, blocks: list, anns: list, title: str) -> NotesContent:
    """Validate Gemini metadata without allowing it to replace the cleaned transcript.

    Drop invented ids, renumber sections, and cap review questions. If Gemini omitted, duplicated, reordered,
    or rewrote any cleaned text block, use deterministic board sections while retaining its clearly separated
    overview and review questions. His own title wins unless it is still the default.
    """
    image_ids = {b["id"] for b in blocks if b["kind"] == "image"}
    ann_ids = {a["id"] for a in anns}
    for i, s in enumerate(notes.sections, 1):
        s.id = f"s{i}"
        s.figures = [f for f in s.figures if f.image_block_id in image_ids]
        s.annotation_ids = [a for a in s.annotation_ids if a in ann_ids]
    notes.title = title if title and title != DEFAULT_TITLE else (notes.title.strip() or title)
    notes.review_questions = notes.review_questions[:5]
    source_paragraphs = [b["text"].strip() for b in blocks
                         if b["kind"] == "text" and (b.get("text") or "").strip()]
    compiled_paragraphs = [paragraph for section in notes.sections for paragraph in section.paragraphs]
    if compiled_paragraphs != source_paragraphs:
        log.warning("[compile] rejected Gemini paragraphs that did not preserve the complete transcript")
        fallback = fallback_notes(notes.title, blocks, anns)
        fallback.overview = notes.overview.strip()
        fallback.review_questions = notes.review_questions
        return fallback
    text_blocks = [b for b in blocks if b["kind"] == "text" and (b.get("text") or "").strip()]
    block_index = 0
    for section in notes.sections:
        count = len(section.paragraphs)
        section.paragraph_block_ids = [block["id"] for block in text_blocks[block_index:block_index + count]]
        block_index += count
    ensure_annotation_figures(notes, blocks, anns)
    return notes


def ensure_annotation_figures(notes: NotesContent, blocks: list, anns: list) -> None:
    """Every annotated image appears once; its section owns every confirmed annotation on that image."""
    if not notes.sections:
        return
    valid_images = {block["id"] for block in blocks if block["kind"] == "image"}
    seen: set[str] = set()
    for section in notes.sections:
        unique = []
        for figure in section.figures:
            if figure.image_block_id in valid_images and figure.image_block_id not in seen:
                seen.add(figure.image_block_id)
                unique.append(figure)
        section.figures = unique

    annotated_images = []
    for block in blocks:
        if block["kind"] == "image" and any(ann["block_id"] == block["id"] for ann in anns):
            annotated_images.append(block["id"])
    for image_id in annotated_images:
        if image_id not in seen:
            notes.sections[-1].figures.append(Figure(image_block_id=image_id, caption=""))
            seen.add(image_id)

    ordered_annotations = sorted(anns, key=lambda ann: (ann.get("drawn_at") or "", ann["id"]))
    for section in notes.sections:
        figure_ids = {figure.image_block_id for figure in section.figures}
        section.annotation_ids = [ann["id"] for ann in ordered_annotations if ann["block_id"] in figure_ids]


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
            s.paragraph_block_ids.append(b["id"])
    sections = [s for s in sections if s.paragraphs or s.figures]
    return NotesContent(title=title, overview="", sections=sections, review_questions=[])


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def truncate_words(text: str, n: int) -> str:
    words = text.split()
    return text if len(words) <= n else " ".join(words[:n]) + "…"
