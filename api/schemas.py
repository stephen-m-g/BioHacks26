"""Pydantic models: request bodies, endpoint responses, Gemini outputs, notes JSON.
Field names are the shared API contract (docs/CONTEXT.md): do not rename."""
from pydantic import BaseModel, Field


# --- /assets/{id}/describe ---
class DescribeOut(BaseModel):
    label: str
    description: str
    key_terms: list[str]


# --- /assets/{id}/pages ---
class PdfPagesOut(BaseModel):
    page_count: int
    pages: list[dict]  # pdf_page asset rows, in page order


# --- /sessions/{id}/refine ---
class RefinedSegment(BaseModel):
    id: str
    text: str


class RefineGemini(BaseModel):
    text: str
    segments: list[RefinedSegment]


class RefineOut(BaseModel):
    block: dict | None
    segment_ids: list[str]


# --- /sessions/{id}/scribe-token ---
class ScribeTokenOut(BaseModel):
    token: str


# --- /annotations/{id}/close ---
class CloseIn(BaseModel):
    crop_png_base64: str | None = None


class CloseOut(BaseModel):
    label: str | None
    bubble_text: str | None


class CloseGemini(BaseModel):
    label: str
    bubble_text: str
    used_segments: list[int]  # transcript line numbers the bubble_text came from


# --- /sessions/{id}/compile (notes v2, also what the frontend renders) ---
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
    paragraph_block_ids: list[str] = Field(default_factory=list)
    key_terms: list[KeyTerm]
    figures: list[Figure]
    annotation_ids: list[str]


class NotesContent(BaseModel):
    title: str
    overview: str
    sections: list[Section]
    review_questions: list[str]
