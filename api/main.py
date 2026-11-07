"""FastAPI app: CORS, routes, GET /health. Run: uvicorn main:app --reload --port 8000
Spec: docs/CONTEXT.md (v2)."""
import logging
import os
import time

from dotenv import load_dotenv

load_dotenv()  # before anything reads os.environ

from fastapi import FastAPI  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

import ai  # noqa: E402
import prompts  # noqa: E402
from db import get_db  # noqa: E402
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


# --- Stubs: return each endpoint's empty fallback until it is built ---

@app.post("/assets/{asset_id}/describe", response_model=DescribeOut)
def describe_asset(asset_id: str) -> DescribeOut:
    # TODO: image -> image part; pdf -> Part.from_bytes(mime_type="application/pdf"); text -> text_content.
    return DescribeOut(label="", description="", key_terms=[])


@app.post("/annotations/{annotation_id}/close", response_model=CloseOut)
def close_annotation(annotation_id: str, body: CloseIn | None = None) -> CloseOut:
    # TODO: confirm; candidates = segments with t_start in [drawn_at - 5 s, closed_at] plus those tagged
    # with this annotation_id ([OPEN]); crop = body or asset image cropped to bbox; write label/bubble_text.
    return CloseOut(label=None, bubble_text=None)


@app.post("/sessions/{session_id}/compile", response_model=NotesContent)
def compile_session(session_id: str) -> NotesContent:
    # TODO: blocks in order + confirmed annotations + text/pdf assets -> NotesContent; upsert lecture_notes.
    return NotesContent(title="", overview="", sections=[], review_questions=[])
