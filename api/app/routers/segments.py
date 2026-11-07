"""POST /segments/{segment_id}/clean: fix misheard words in a transcript segment (~2 s budget)."""
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

SYSTEM_PROMPT = (
    "You correct live speech-recognition output from a high-school biology teacher who has ALS with mild "
    "dysarthria: his speech is slower and slightly slurred, more so later in the day, so the recognizer "
    "mishears words. Fix words that were likely misheard, preferring terms from the provided lecture "
    "vocabulary when the sounds are similar. Fix punctuation and capitalization. Keep his wording, meaning "
    "and sentence order. Never add facts, summarize, or rephrase for style. If a stretch is unintelligible, "
    "keep it as-is and wrap it in [?]. Return JSON {clean_text}."
)


class CleanOut(BaseModel):
    clean_text: str


@router.post("/segments/{segment_id}/clean", response_model=CleanOut)
def clean_segment(segment_id: str) -> CleanOut:
    # TODO (P2): load segment; vocabulary = union of key_terms from the lecture's assets;
    # context = last 3 clean_text segments of the session. Fallback on failure: clean_text = raw_text.
    # Write clean_text back to transcript_segments.
    return CleanOut(clean_text="")
