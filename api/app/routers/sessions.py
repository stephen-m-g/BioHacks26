"""Session endpoints: batch refine of live speech, and compiling the study document."""
from fastapi import APIRouter
from pydantic import BaseModel

from .. import gemini
from ..db import get_db

router = APIRouter()

# ---------------------------------------------------------------------------
# POST /sessions/{session_id}/refine
# ---------------------------------------------------------------------------

REFINE_PROMPT = (
    "You correct live speech-recognition output from a high-school biology teacher who has ALS with mild "
    "dysarthria: his speech is slower and slightly slurred, more so later in the day, so the recognizer "
    "mishears words. You get the lecture vocabulary, the previous paragraph for context, and new raw speech. "
    "Fix words in the new speech that were likely misheard, preferring terms from the lecture vocabulary when "
    "the sounds are similar. Fix punctuation and capitalization and join it into one readable paragraph. Keep "
    "his wording, meaning and sentence order. Never add facts, summarize, or rephrase for style. Do not repeat "
    "the previous paragraph. If a stretch is unintelligible, keep it as-is and wrap it in [?]. "
    "Return JSON {text}."
)


class RefineGemini(BaseModel):
    text: str


class RefineOut(BaseModel):
    block: dict | None
    segment_ids: list[str]


@router.post("/sessions/{session_id}/refine", response_model=RefineOut)
def refine_session(session_id: str) -> RefineOut:
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

    raw = " ".join(s["raw_text"].strip() for s in segs if s["raw_text"].strip())
    prompt = (
        f"Lecture vocabulary: {', '.join(vocab) if vocab else '(none)'}\n\n"
        f"Previous paragraph: {prev_text[-600:] or '(none)'}\n\n"
        f"New raw speech: {raw}"
    )
    out = gemini.generate_json(REFINE_PROMPT, [prompt], RefineGemini)
    text = (out or {}).get("text") or raw  # fallback: raw text

    block = (
        db.table("blocks")
        .insert({"session_id": session_id, "kind": "text", "position": max_pos + 1, "text": text})
        .execute()
        .data[0]
    )
    ids = [s["id"] for s in segs]
    db.table("transcript_segments").update({"text_block_id": block["id"]}).in_("id", ids).execute()
    return RefineOut(block=block, segment_ids=ids)


# ---------------------------------------------------------------------------
# POST /sessions/{session_id}/compile
# ---------------------------------------------------------------------------

COMPILE_PROMPT = (
    "Turn this live lecture into a clear, well-structured study document for high-school senior biology "
    "students. Use ONLY content from the transcript, the annotations and the provided teaching materials; do "
    "not add outside facts. Organize into sections in teaching order. Paragraphs should be concise and in "
    "plain language; you may mark key terms with **bold**. key_terms: define only terms the teacher explained "
    "or the materials define, using that explanation. figures: reference image_block_ids of images that "
    "illustrate the section, with a one-line caption based on what he said. annotation_ids: the annotations "
    "whose content is discussed in that section. review_questions: 3-5 questions answerable from these notes. "
    "Return JSON matching the schema."
)


class KeyTerm(BaseModel):
    term: str
    definition: str


class Figure(BaseModel):
    image_block_id: str
    caption: str


class Section(BaseModel):
    id: str
    heading: str
    paragraphs: list[str]
    key_terms: list[KeyTerm]
    figures: list[Figure]
    annotation_ids: list[str]


class NotesContent(BaseModel):
    title: str
    overview: str
    sections: list[Section]
    review_questions: list[str]


@router.post("/sessions/{session_id}/compile", response_model=NotesContent)
def compile_session(session_id: str) -> NotesContent:
    # TODO (P2): gather blocks in order (text paragraphs + image blocks with asset label/description),
    # confirmed annotations (id, block_id, label, bubble_text) and the lecture's text/pdf assets;
    # Gemini -> NotesContent; upsert lecture_notes (session_id, content).
    return NotesContent(title="", overview="", sections=[], review_questions=[])
