"""Hit every endpoint of a running API with unknown ids, to check routing and error handling.

Usage:  python smoke.py [http://localhost:8000]
For a real end-to-end run, start a session in the web app and use simulate.py.
"""
import sys

import httpx

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8000"
FAKE = "00000000-0000-0000-0000-000000000000"

checks = [  # (method, path, body, expected status)
    ("GET", "/health", None, 200),
    ("POST", f"/assets/{FAKE}/describe", None, 404),
    ("POST", f"/sessions/{FAKE}/refine", None, 200),  # nothing to refine -> {"block": null}
    ("POST", f"/annotations/{FAKE}/close", {"crop_png_base64": None}, 404),
    ("POST", f"/sessions/{FAKE}/compile", None, 404),
]

failed = 0
with httpx.Client(timeout=30) as client:
    for method, path, body, expected in checks:
        r = client.request(method, BASE + path, json=body)
        ok = r.status_code == expected
        failed += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {r.status_code} (want {expected})  {method} {path}  {r.text[:120]}")
sys.exit(1 if failed else 0)
