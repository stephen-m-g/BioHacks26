"""Gemini client + the one structured-output call every endpoint uses."""
import logging
import os
import threading
import time
from typing import Any, TypeVar

from google import genai
from google.genai import types
from pydantic import BaseModel

log = logging.getLogger("ai")

T = TypeVar("T", bound=BaseModel)

QUOTA_COOLDOWN_S = 600  # skip a model whose daily quota is used up for this long
_cooldown_until: dict[str, float] = {}


_client: genai.Client | None = None
_client_lock = threading.Lock()


def get_client() -> genai.Client:
    """One shared client, created under a lock. FastAPI runs requests in threads, and a second Client made by a
    concurrent first call would be garbage-collected mid-request; Client.__del__ then closes its HTTP connection
    ("Cannot send a request, as the client has been closed")."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    return _client


def models_to_try(preferred: str | None = None) -> list[str]:
    """The task's preferred model (default GEMINI_MODEL), then the optional GEMINI_FALLBACK_MODEL (its own quota
    and load), then GEMINI_MODEL; minus any model whose quota ran out recently. If all are cooling down, try them
    anyway."""
    primary = os.environ["GEMINI_MODEL"]
    backup = os.getenv("GEMINI_FALLBACK_MODEL", "").strip()
    models = list(dict.fromkeys(m for m in (preferred or primary, backup, primary) if m))
    now = time.monotonic()
    return [m for m in models if _cooldown_until.get(m, 0) <= now] or models


def _config(system: str, schema: type, timeout_ms: int, thinking: str | None) -> types.GenerateContentConfig:
    return types.GenerateContentConfig(
        system_instruction=system,
        response_mime_type="application/json",
        response_schema=schema,
        http_options=types.HttpOptions(timeout=max(timeout_ms, 10_000)),
        thinking_config=types.ThinkingConfig(thinking_level=thinking) if thinking else None,
    )


def generate(task: str, system: str, contents: list[Any], schema: type[T], timeout_ms: int = 20_000,
             model: str | None = None, thinking: str | None = None) -> tuple[T | None, float]:
    """Structured-output Gemini call; returns (parsed model or None, total ms). None means both attempts failed,
    so the caller applies its endpoint's fallback.
    model: preferred model for this task (default GEMINI_MODEL). thinking: a thinking level such as "LOW" (every
    current Flash model accepts LOW; 3.7/3.8 reject MINIMAL); dropped for the retry if a model rejects it.
    Two attempts: the second goes to the next model if there is one, else the same model again (skipped when its
    quota is used up). timeout_ms is per attempt; the API rejects deadlines under 10 s, so it is floored."""
    config = _config(system, schema, timeout_ms, thinking)
    models = models_to_try(model)
    client = get_client()  # keep a reference for the whole call
    t0 = time.perf_counter()
    for attempt in (1, 2):
        model = models[min(attempt - 1, len(models) - 1)]
        t_try = time.perf_counter()
        try:
            resp = client.models.generate_content(model=model, contents=contents, config=config)
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
            elif thinking and "INVALID_ARGUMENT" in msg and "hinking" in msg:
                thinking = None  # this model rejects the thinking setting: retry without it
                config = _config(system, schema, timeout_ms, None)
    return None, (time.perf_counter() - t0) * 1000


def image_part(data: bytes, mime_type: str = "image/png") -> types.Part:
    """Inline file part: images, and PDFs with mime_type="application/pdf"."""
    return types.Part.from_bytes(data=data, mime_type=mime_type)
