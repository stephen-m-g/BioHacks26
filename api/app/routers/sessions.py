"""POST /sessions/{session_id}/compile: build structured lecture notes as a draft."""
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

SYSTEM_PROMPT = (
    "Turn this live lecture into clear, well-structured study notes for high-school senior biology students. "
    "Use ONLY content from the transcript, the annotations and the provided teaching materials; do not add "
    "outside facts. Organize by slide, in teaching order. Bullets should be concise and in plain language. "
    "key_terms: define only terms the teacher explained or the materials define, using that explanation. "
    "figures: reference annotation_ids or asset_ids that illustrate the section, with a one-line caption "
    "based on what he said. review_questions: 3-5 questions answerable from these notes. Return JSON "
    "matching the schema."
)


class KeyTerm(BaseModel):
    term: str
    definition: str


class Figure(BaseModel):
    annotation_id: str | None = None
    asset_id: str | None = None
    caption: str


class Section(BaseModel):
    slide_index: int
    heading: str
    bullets: list[str]
    key_terms: list[KeyTerm]
    figures: list[Figure]


class NotesContent(BaseModel):
    title: str
    overview: str
    sections: list[Section]
    review_questions: list[str]


@router.post("/sessions/{session_id}/compile", response_model=NotesContent)
def compile_session(session_id: str) -> NotesContent:
    # TODO (P2): gather slides, segments by slide, confirmed annotations, placed images, text assets;
    # Gemini -> NotesContent; upsert lecture_notes (content, status 'draft'). Chunk by slide if long.
    return NotesContent(title="", overview="", sections=[], review_questions=[])
