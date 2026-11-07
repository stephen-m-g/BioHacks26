"""Gemini client + one function per task (describe, clean, link, compile)."""
import logging
import os
import time
from functools import lru_cache
from typing import Any, TypeVar

from google import genai
from google.genai import types
from pydantic import BaseModel

log = logging.getLogger("ai")

T = TypeVar("T", bound=BaseModel)


@lru_cache
def get_client() -> genai.Client:
    return genai.Client(api_key=os.environ["GEMINI_API_KEY"])


def generate(task: str, system: str, contents: list[Any], schema: type[T],
             timeout_ms: int = 20_000) -> tuple[T | None, float]:
    """Structured-output Gemini call. Retries once; returns (parsed model or None, total ms).
    None means both attempts failed, so the caller applies its endpoint's fallback.
    timeout_ms is per attempt. The API rejects deadlines under 10 s (400 INVALID_ARGUMENT), so it is floored."""
    config = types.GenerateContentConfig(
        system_instruction=system,
        response_mime_type="application/json",
        response_schema=schema,
        http_options=types.HttpOptions(timeout=max(timeout_ms, 10_000)),
    )
    t0 = time.perf_counter()
    for attempt in (1, 2):
        t_try = time.perf_counter()
        try:
            resp = get_client().models.generate_content(
                model=os.environ["GEMINI_MODEL"], contents=contents, config=config
            )
            if isinstance(resp.parsed, schema):
                log.info("[%s] gemini attempt %d ok %.0fms", task, attempt, (time.perf_counter() - t_try) * 1000)
                return resp.parsed, (time.perf_counter() - t0) * 1000
            log.warning("[%s] gemini attempt %d: unparseable response", task, attempt)
        except Exception as e:  # noqa: BLE001 - never let Gemini 500 an endpoint
            log.warning("[%s] gemini attempt %d failed after %.0fms: %s",
                        task, attempt, (time.perf_counter() - t_try) * 1000, e)
    return None, (time.perf_counter() - t0) * 1000


def image_part(data: bytes, mime_type: str = "image/png") -> types.Part:
    return types.Part.from_bytes(data=data, mime_type=mime_type)
