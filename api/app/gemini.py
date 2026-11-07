"""Gemini helper: structured JSON output, retry once on parse failure, log latency."""
import json
import logging
import time
from functools import lru_cache
from typing import Any

from google import genai
from google.genai import types

from . import config

log = logging.getLogger("gemini")


@lru_cache
def get_client() -> genai.Client:
    if not config.GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY not set")
    return genai.Client(api_key=config.GEMINI_API_KEY)


def generate_json(system_instruction: str, contents: list[Any], response_schema: Any) -> dict | None:
    """Call Gemini with JSON output. Returns the parsed dict, or None after two failed attempts
    so callers can apply their own fallback (e.g. clean_text = raw_text)."""
    cfg = types.GenerateContentConfig(
        system_instruction=system_instruction,
        response_mime_type="application/json",
        response_schema=response_schema,
    )
    for attempt in range(2):
        t0 = time.perf_counter()
        try:
            resp = get_client().models.generate_content(model=config.GEMINI_MODEL, contents=contents, config=cfg)
            log.info("gemini %s ok in %.0f ms (attempt %d)", config.GEMINI_MODEL, (time.perf_counter() - t0) * 1000, attempt + 1)
            return json.loads(resp.text)
        except Exception as e:  # noqa: BLE001 - parse or API error: retry once, then fall back
            log.warning("gemini attempt %d failed after %.0f ms: %s", attempt + 1, (time.perf_counter() - t0) * 1000, e)
    return None
