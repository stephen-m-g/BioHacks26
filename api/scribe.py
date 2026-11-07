"""ElevenLabs Scribe v2 Realtime single-use tokens. ELEVENLABS_API_KEY never leaves the server."""
import os
import threading
import time
from collections import deque

import httpx

DEFAULT_API_URL = "https://api.elevenlabs.io"
TOKEN_TIMEOUT_S = 10.0


class ScribeTokenError(Exception):
    """ElevenLabs refused or failed to issue a token."""


class SlidingWindowLimiter:
    """At most `limit` hits per key within `window_s` seconds. Thread-safe (sync routes run in a pool)."""

    def __init__(self, limit: int, window_s: float, clock=time.monotonic):
        self.limit = limit
        self.window_s = window_s
        self.clock = clock
        self.hits: dict[str, deque[float]] = {}
        self.lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = self.clock()
        with self.lock:
            hits = self.hits.setdefault(key, deque())
            while hits and now - hits[0] >= self.window_s:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            return True


# A teacher client mints one token per (re)connect; reconnects back off after 3 failures.
per_session_limiter = SlidingWindowLimiter(limit=10, window_s=60)
global_limiter = SlidingWindowLimiter(limit=60, window_s=60)


def create_realtime_token(api_key: str, client: httpx.Client | None = None) -> str:
    """POST /v1/single-use-token/realtime_scribe. The token expires after 15 minutes and is consumed on use."""
    base = (os.getenv("ELEVENLABS_API_URL") or DEFAULT_API_URL).rstrip("/")
    url = f"{base}/v1/single-use-token/realtime_scribe"
    try:
        if client is None:
            with httpx.Client(timeout=TOKEN_TIMEOUT_S) as owned:
                res = owned.post(url, headers={"xi-api-key": api_key})
        else:
            res = client.post(url, headers={"xi-api-key": api_key})
    except httpx.HTTPError as e:
        raise ScribeTokenError(f"token request failed: {type(e).__name__}") from e
    if res.status_code != 200:
        raise ScribeTokenError(f"ElevenLabs returned {res.status_code}")
    try:
        token = res.json().get("token")
    except (ValueError, AttributeError):
        token = None
    if not isinstance(token, str) or not token:
        raise ScribeTokenError("ElevenLabs response had no token")
    return token
