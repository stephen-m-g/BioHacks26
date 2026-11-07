"""POST /sessions/{id}/scribe-token and scribe.py, with Supabase (conftest.py) and ElevenLabs faked."""
import httpx
import pytest
from fastapi.testclient import TestClient

import main
import scribe


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "server-secret")
    scribe.per_session_limiter.hits.clear()
    scribe.global_limiter.hits.clear()
    return TestClient(main.app)


@pytest.fixture
def mint(monkeypatch):
    calls = []

    def fake(api_key):
        calls.append(api_key)
        return "sutkn_test"

    monkeypatch.setattr(scribe, "create_realtime_token", fake)
    return calls


def post(client, session_id):
    return client.post(f"/sessions/{session_id}/scribe-token")


# ---------- endpoint ----------

def test_issues_token_for_live_session_without_leaking_key(client, db, mint):
    s = db.add("sessions", status="live")
    res = post(client, s["id"])
    assert res.status_code == 200
    assert res.json() == {"token": "sutkn_test"}
    assert "server-secret" not in res.text
    assert mint == ["server-secret"]


def test_rejects_unknown_ended_and_malformed_sessions(client, db, mint):
    ended = db.add("sessions", status="ended")
    assert post(client, "11111111-1111-1111-1111-111111111111").status_code == 404
    assert post(client, ended["id"]).status_code == 409
    assert post(client, "not-a-uuid").status_code == 404
    assert mint == []


def test_reports_missing_server_key(client, db, mint, monkeypatch):
    monkeypatch.setenv("ELEVENLABS_API_KEY", "")
    s = db.add("sessions", status="live")
    assert post(client, s["id"]).status_code == 503
    assert mint == []


def test_rate_limits_each_session(client, db, mint):
    s = db.add("sessions", status="live")
    for _ in range(scribe.per_session_limiter.limit):
        assert post(client, s["id"]).status_code == 200
    assert post(client, s["id"]).status_code == 429
    assert post(client, db.add("sessions", status="live")["id"]).status_code == 200


def test_maps_upstream_failure_to_bad_gateway(client, db, monkeypatch):
    def fail(_key):
        raise scribe.ScribeTokenError("ElevenLabs returned 401")

    monkeypatch.setattr(scribe, "create_realtime_token", fail)
    assert post(client, db.add("sessions", status="live")["id"]).status_code == 502


# ---------- create_realtime_token ----------

def mock_client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_sends_key_header_and_returns_token(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_URL", raising=False)
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("xi-api-key")
        return httpx.Response(200, json={"token": "sutkn_abc"})

    assert scribe.create_realtime_token("k", mock_client(handler)) == "sutkn_abc"
    assert seen == {"url": "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", "key": "k"}


@pytest.mark.parametrize("response", [
    httpx.Response(401, json={"detail": "bad key"}),
    httpx.Response(200, text="not json"),
    httpx.Response(200, json={"token": ""}),
])
def test_raises_on_error_status_or_bad_body(response):
    with pytest.raises(scribe.ScribeTokenError):
        scribe.create_realtime_token("k", mock_client(lambda _r: response))


def test_raises_on_network_failure():
    def offline(request):
        raise httpx.ConnectError("offline", request=request)

    with pytest.raises(scribe.ScribeTokenError):
        scribe.create_realtime_token("k", mock_client(offline))


# ---------- SlidingWindowLimiter ----------

def test_limiter_frees_capacity_after_the_window():
    now = [0.0]
    limiter = scribe.SlidingWindowLimiter(limit=2, window_s=60, clock=lambda: now[0])
    assert limiter.allow("a") and limiter.allow("a")
    assert not limiter.allow("a")
    assert limiter.allow("b")
    now[0] = 60.0
    assert limiter.allow("a")
