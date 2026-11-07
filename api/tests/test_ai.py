"""ai.generate: retries, backup model, quota cool-down, timeout floor. The Gemini client is faked."""
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

import ai
from schemas import RefineGemini

OK = RefineGemini(text="ok")
QUOTA = RuntimeError("429 RESOURCE_EXHAUSTED. quota exceeded")
OVERLOADED = RuntimeError("503 UNAVAILABLE. high demand")


class FakeModels:
    """Each generate_content call takes the next scripted outcome: an exception to raise, or a parsed value."""

    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.models, self.configs = [], []

    def generate_content(self, model, contents, config):
        self.models.append(model)
        self.configs.append(config)
        out = self.outcomes.pop(0)
        if isinstance(out, Exception):
            raise out
        return SimpleNamespace(parsed=out)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("GEMINI_MODEL", "main-model")
    monkeypatch.delenv("GEMINI_FALLBACK_MODEL", raising=False)
    ai._cooldown_until.clear()

    def install(*outcomes):
        fake = FakeModels(*outcomes)
        monkeypatch.setattr(ai, "get_client", lambda: SimpleNamespace(models=fake))
        return fake

    yield install
    ai._cooldown_until.clear()


def run():
    return ai.generate("t", "system", ["hi"], RefineGemini)[0]


def test_first_try_succeeds(client):
    fake = client(OK)
    assert run() == OK and fake.models == ["main-model"]


def test_retries_once_on_the_same_model_without_a_backup(client):
    fake = client(OVERLOADED, OK)
    assert run() == OK and fake.models == ["main-model", "main-model"]


def test_unparseable_twice_gives_none(client):
    fake = client(None, "not a RefineGemini")
    assert run() is None and len(fake.models) == 2


def test_quota_without_backup_does_not_retry(client):
    fake = client(QUOTA, OK)
    assert run() is None and fake.models == ["main-model"]


def test_retry_goes_to_the_backup_model(client, monkeypatch):
    monkeypatch.setenv("GEMINI_FALLBACK_MODEL", "backup-model")
    fake = client(OVERLOADED, OK)
    assert run() == OK and fake.models == ["main-model", "backup-model"]


def test_used_up_model_is_skipped_until_its_cooldown_ends(client, monkeypatch):
    monkeypatch.setenv("GEMINI_FALLBACK_MODEL", "backup-model")
    fake = client(QUOTA, OK, OK)
    assert run() == OK                       # main-model 429 -> backup-model
    assert run() == OK                       # main-model skipped while cooling down
    assert fake.models == ["main-model", "backup-model", "backup-model"]
    monkeypatch.setattr(ai.time, "monotonic", lambda: 10**12)  # cool-down over
    assert ai.models_to_try() == ["main-model", "backup-model"]


def test_if_every_model_is_cooling_down_try_them_anyway(client, monkeypatch):
    monkeypatch.setenv("GEMINI_FALLBACK_MODEL", "backup-model")
    client(QUOTA, QUOTA)
    assert run() is None
    assert ai.models_to_try() == ["main-model", "backup-model"]


def test_backup_equal_to_main_is_ignored(client, monkeypatch):
    monkeypatch.setenv("GEMINI_FALLBACK_MODEL", "main-model")
    assert ai.models_to_try() == ["main-model"]


def test_task_model_goes_first_then_backup_then_main(client, monkeypatch):
    assert ai.models_to_try("fast-model") == ["fast-model", "main-model"]
    monkeypatch.setenv("GEMINI_FALLBACK_MODEL", "backup-model")
    assert ai.models_to_try("fast-model") == ["fast-model", "backup-model", "main-model"]
    assert ai.models_to_try("backup-model") == ["backup-model", "main-model"]  # no duplicates


def test_task_model_is_used_for_the_first_attempt(client, monkeypatch):
    monkeypatch.setenv("GEMINI_FALLBACK_MODEL", "backup-model")
    fake = client(OVERLOADED, OK)
    assert ai.generate("t", "s", ["hi"], RefineGemini, model="fast-model")[0] == OK
    assert fake.models == ["fast-model", "backup-model"]


def test_thinking_level_is_sent_and_dropped_if_a_model_rejects_it(client):
    rejected = RuntimeError("400 INVALID_ARGUMENT. Thinking level MINIMAL is not supported for this model.")
    fake = client(rejected, OK)
    assert ai.generate("t", "s", ["hi"], RefineGemini, thinking="MINIMAL")[0] == OK
    assert fake.configs[0].thinking_config.thinking_level.value == "MINIMAL"
    assert fake.configs[1].thinking_config is None


def test_concurrent_first_calls_share_one_client(monkeypatch):
    """A second Client from a racing first call gets garbage-collected mid-request, and Client.__del__ closes its
    HTTP connection ("client has been closed"). Seen with 6 parallel calls in eval_refine.py."""
    made = []

    class SlowClient:
        def __init__(self, api_key):
            time.sleep(0.05)  # widen the race window
            made.append(self)

    monkeypatch.setenv("GEMINI_API_KEY", "x")
    monkeypatch.setattr(ai.genai, "Client", SlowClient)
    monkeypatch.setattr(ai, "_client", None)
    with ThreadPoolExecutor(8) as pool:
        got = list(pool.map(lambda _: ai.get_client(), range(8)))
    assert len(made) == 1 and all(g is made[0] for g in got)


def test_timeout_is_floored_at_10_seconds(client):
    fake = client(OK)
    ai.generate("t", "system", ["hi"], RefineGemini, timeout_ms=1_500)
    assert fake.configs[0].http_options.timeout == 10_000
