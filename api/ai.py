"""Gemini client + the one structured-output call every endpoint uses."""
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

QUOTA_COOLDOWN_S = 600  # skip a model whose daily quota is used up for this long
_cooldown_until: dict[str, float] = {}


@lru_cache
def get_client() -> genai.Client:
    return genai.Client(api_key=os.environ["GEMINI_API_KEY"])


def models_to_try() -> list[str]:
    """GEMINI_MODEL, then the optional GEMINI_FALLBACK_MODEL (its own quota and load), minus any model whose
    quota ran out recently. If every model is cooling down, try them anyway."""
    primary = os.environ["GEMINI_MODEL"]
    backup = os.getenv("GEMINI_FALLBACK_MODEL", "").strip()
    models = [primary] + ([backup] if backup and backup != primary else [])
    now = time.monotonic()
    return [m for m in models if _cooldown_until.get(m, 0) <= now] or models


def generate(task: str, system: str, contents: list[Any], schema: type[T],
             timeout_ms: int = 20_000) -> tuple[T | None, float]:
    """Structured-output Gemini call; returns (parsed model or None, total ms). None means both attempts failed,
    so the caller applies its endpoint's fallback.
    Two attempts: the second goes to the backup model if there is one, else the same model again (skipped when its
    quota is used up). timeout_ms is per attempt; the API rejects deadlines under 10 s, so it is floored."""
    config = types.GenerateContentConfig(
        system_instruction=system,
        response_mime_type="application/json",
        response_schema=schema,
        http_options=types.HttpOptions(timeout=max(timeout_ms, 10_000)),
    )
    models = models_to_try()
    t0 = time.perf_counter()
    for attempt in (1, 2):
        model = models[min(attempt - 1, len(models) - 1)]
        t_try = time.perf_counter()
        try:
            resp = get_client().models.generate_content(model=model, contents=contents, config=config)
            if isinstance(resp.parsed, schema):
                log.info("[%s] %s attempt %d ok %.0fms", task, model, attempt, (time.perf_counter() - t_try) * 1000)
                return resp.parsed, (time.perf_counter() - t0) * 1000
            log.warning("[%s] %s attempt %d: unparseable response", task, model, attempt)
        except Exception as e:  # noqa: BLE001 - never let Gemini 500 an endpoint
            msg = str(e)
            log.warning("[%s] %s attempt %d failed after %.0fms: %s",
                        task, model, attempt, (time.perf_counter() - t_try) * 1000, msg[:200])
            if "RESOURCE_EXHAUSTED" in msg:  # quota used up: skip this model for a while
                _cooldown_until[model] = time.monotonic() + QUOTA_COOLDOWN_S
                if len(models) == 1:
                    break  # no other model, and a retry can't succeed
    return None, (time.perf_counter() - t0) * 1000


def image_part(data: bytes, mime_type: str = "image/png") -> types.Part:
    """Inline file part: images, and PDFs with mime_type="application/pdf"."""
    return types.Part.from_bytes(data=data, mime_type=mime_type)
