"""POST /assets/{asset_id}/describe: Gemini labels an uploaded image/text asset."""
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

SYSTEM_PROMPT = (
    "You are cataloguing teaching materials for a high-school senior biology lecture. Return JSON "
    "{label: 2-6 word title, description: 2-3 sentences describing what the material shows, key_terms: "
    "up to 15 biology terms that appear in or are directly shown by it}. Only describe what is present; "
    "do not add outside facts."
)


class DescribeOut(BaseModel):
    label: str
    description: str
    key_terms: list[str]


@router.post("/assets/{asset_id}/describe", response_model=DescribeOut)
def describe_asset(asset_id: str) -> DescribeOut:
    # TODO (P2): load asset; image -> download public URL, send as image part; text -> send text_content.
    # Call gemini.generate_json(SYSTEM_PROMPT, contents, DescribeOut); write label/description/key_terms.
    return DescribeOut(label="", description="", key_terms=[])
