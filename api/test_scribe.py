"""Scribe token endpoint tests. Run: .venv/bin/python -m unittest test_scribe -v"""
import os
import unittest
from unittest import mock

import httpx
from fastapi.testclient import TestClient

import main
import scribe

SESSION = "11111111-1111-1111-1111-111111111111"


class FakeQuery:
    def __init__(self, rows):
        self.rows = rows

    def __getattr__(self, _name):
        return lambda *_args, **_kwargs: self

    def execute(self):
        return mock.Mock(data=self.rows)


class FakeDb:
    def __init__(self, rows):
        self.rows = rows

    def table(self, _name):
        return FakeQuery(self.rows)


class ScribeTokenEndpointTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        scribe.per_session_limiter.hits.clear()
        scribe.global_limiter.hits.clear()
        self.env = mock.patch.dict(os.environ, {"ELEVENLABS_API_KEY": "server-secret"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def post(self, rows, session_id=SESSION, token="sutkn_test"):
        with (
            mock.patch.object(main, "get_db", return_value=FakeDb(rows)),
            mock.patch.object(scribe, "create_realtime_token", return_value=token) as mint,
        ):
            return self.client.post(f"/sessions/{session_id}/scribe-token"), mint

    def test_issues_token_for_live_session_without_leaking_key(self):
        res, mint = self.post([{"status": "live"}])
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"token": "sutkn_test"})
        self.assertNotIn("server-secret", res.text)
        mint.assert_called_once_with("server-secret")

    def test_rejects_unknown_ended_and_malformed_sessions(self):
        self.assertEqual(self.post([])[0].status_code, 404)
        self.assertEqual(self.post([{"status": "ended"}])[0].status_code, 409)
        res, mint = self.post([{"status": "live"}], session_id="not-a-uuid")
        self.assertEqual(res.status_code, 404)
        mint.assert_not_called()

    def test_reports_missing_server_key(self):
        with mock.patch.dict(os.environ, {"ELEVENLABS_API_KEY": ""}):
            res, mint = self.post([{"status": "live"}])
        self.assertEqual(res.status_code, 503)
        mint.assert_not_called()

    def test_rate_limits_each_session(self):
        for _ in range(scribe.per_session_limiter.limit):
            self.assertEqual(self.post([{"status": "live"}])[0].status_code, 200)
        self.assertEqual(self.post([{"status": "live"}])[0].status_code, 429)

    def test_maps_upstream_failure_to_bad_gateway(self):
        with (
            mock.patch.object(main, "get_db", return_value=FakeDb([{"status": "live"}])),
            mock.patch.object(scribe, "create_realtime_token", side_effect=scribe.ScribeTokenError("401")),
        ):
            res = self.client.post(f"/sessions/{SESSION}/scribe-token")
        self.assertEqual(res.status_code, 502)


class CreateRealtimeTokenTest(unittest.TestCase):
    def client_for(self, handler):
        return httpx.Client(transport=httpx.MockTransport(handler))

    def test_sends_key_header_and_returns_token(self):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            seen["key"] = request.headers.get("xi-api-key")
            return httpx.Response(200, json={"token": "sutkn_abc"})

        self.assertEqual(scribe.create_realtime_token("k", self.client_for(handler)), "sutkn_abc")
        self.assertEqual(seen["url"], "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe")
        self.assertEqual(seen["key"], "k")

    def test_raises_on_error_status_bad_body_and_network_failure(self):
        cases = [
            lambda _r: httpx.Response(401, json={"detail": "bad key"}),
            lambda _r: httpx.Response(200, text="not json"),
            lambda _r: httpx.Response(200, json={"token": ""}),
        ]
        for handler in cases:
            with self.assertRaises(scribe.ScribeTokenError):
                scribe.create_realtime_token("k", self.client_for(handler))

        def offline(request):
            raise httpx.ConnectError("offline", request=request)

        with self.assertRaises(scribe.ScribeTokenError):
            scribe.create_realtime_token("k", self.client_for(offline))


class SlidingWindowLimiterTest(unittest.TestCase):
    def test_frees_capacity_after_the_window(self):
        now = [0.0]
        limiter = scribe.SlidingWindowLimiter(limit=2, window_s=60, clock=lambda: now[0])
        self.assertTrue(limiter.allow("a"))
        self.assertTrue(limiter.allow("a"))
        self.assertFalse(limiter.allow("a"))
        self.assertTrue(limiter.allow("b"))
        now[0] = 60.0
        self.assertTrue(limiter.allow("a"))


if __name__ == "__main__":
    unittest.main()
