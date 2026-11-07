"""POST /annotations/{annotation_id}/close: confirm an annotation and link his words to it."""
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

SYSTEM_PROMPT = (
    "A biology teacher circled or inserted something on his slide while talking. You get an image of what "
    "he selected, a description of the slide, and the transcript of what he said from just before selecting "
    "it until he confirmed. Return JSON {label: 2-5 word name of the selected thing, bubble_text: the "
    "sentences from the transcript that are about the selected thing}. bubble_text must be HIS words copied "
    "from the transcript, max 70 words; you may drop unrelated sentences and filler words (um, uh, okay so) "
    "and join the kept sentences; you may not add or paraphrase content."
)


class CloseIn(BaseModel):
    crop_png_base64: str | None = None


class CloseOut(BaseModel):
    label: str | None
    bubble_text: str | None


@router.post("/annotations/{annotation_id}/close", response_model=CloseOut)
def close_annotation(annotation_id: str, body: CloseIn | None = None) -> CloseOut:
    # TODO (P2): set status='confirmed', closed_at=now(); collect segments (annotation_id = id OR same
    # session+slide with t_start in [drawn_at - 5 s, drawn_at]); clean_text ?? raw_text in time order;
    # Gemini -> {label, bubble_text}; write them; set annotation_id on the segments used.
    return CloseOut(label=None, bubble_text=None)
