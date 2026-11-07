"""POST /annotations/{annotation_id}/close: confirm a lasso annotation and link his words to it."""
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

SYSTEM_PROMPT = (
    "A biology teacher drew a loop around part of an image on his board while talking. You get an image of "
    "what he selected, a description of the whole image, and a transcript of what he said from just before "
    "selecting it until he confirmed. Segments he spoke while the selection was open are marked [OPEN]; they "
    "are likely, but not certainly, about it. Return JSON {label: 2-5 word name of the selected thing, "
    "bubble_text: the sentences from the transcript that are about the selected thing}. bubble_text must be "
    "HIS words copied from the transcript, max 70 words; you may drop unrelated sentences and filler words "
    "(um, uh, okay so) and join the kept sentences; you may not add or paraphrase content."
)


class CloseIn(BaseModel):
    crop_png_base64: str | None = None


class CloseOut(BaseModel):
    label: str | None
    bubble_text: str | None


@router.post("/annotations/{annotation_id}/close", response_model=CloseOut)
def close_annotation(annotation_id: str, body: CloseIn | None = None) -> CloseOut:
    # TODO (P2): set status='confirmed', closed_at=now() (if not already set by the frontend).
    # Candidate segments: same session with t_start in [drawn_at - 5 s, closed_at], plus any with
    # annotation_id = id (mark those [OPEN]). Use the time window as a guide, let Gemini decide.
    # Context: crop (body.crop_png_base64) or the block's asset image cropped to bbox, + asset description.
    # Write label and bubble_text; set annotation_id on the segments it used.
    return CloseOut(label=None, bubble_text=None)
