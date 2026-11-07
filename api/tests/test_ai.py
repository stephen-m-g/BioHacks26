"""ai.generate: retries, backup model, quota cool-down, timeout floor. The Gemini client is faked."""
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


def test_timeout_is_floored_at_10_seconds(client):
    fake = client(OK)
    ai.generate("t", "system", ["hi"], RefineGemini, timeout_ms=1_500)
    assert fake.configs[0].http_options.timeout == 10_000
