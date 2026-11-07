"""FastAPI app: CORS, routes, GET /health. Run: uvicorn main:app --reload --port 8000
Spec: docs/CONTEXT.md (v2)."""
import logging
import mimetypes
import os
import time

from dotenv import load_dotenv

load_dotenv()  # before anything reads os.environ

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

import ai  # noqa: E402
import prompts  # noqa: E402
from db import download, get_db  # noqa: E402
from schemas import CloseIn, CloseOut, DescribeOut, NotesContent, RefineGemini, RefineOut  # noqa: E402

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

    session = db.table("sessions").select("lecture_id").eq("id", session_id).single().execute().data
    assets = db.table("assets").select("key_terms").eq("lecture_id", session["lecture_id"]).execute().data
    vocab = sorted({t for a in assets for t in (a.get("key_terms") or [])})
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


# --- Stubs: return each endpoint's empty fallback until it is built ---


@app.post("/annotations/{annotation_id}/close", response_model=CloseOut)
def close_annotation(annotation_id: str, body: CloseIn | None = None) -> CloseOut:
    # TODO: confirm; candidates = segments with t_start in [drawn_at - 5 s, closed_at] plus those tagged
    # with this annotation_id ([OPEN]); crop = body or asset image cropped to bbox; write label/bubble_text.
    return CloseOut(label=None, bubble_text=None)


@app.post("/sessions/{session_id}/compile", response_model=NotesContent)
def compile_session(session_id: str) -> NotesContent:
    # TODO: blocks in order + confirmed annotations + text/pdf assets -> NotesContent; upsert lecture_notes.
    return NotesContent(title="", overview="", sections=[], review_questions=[])
