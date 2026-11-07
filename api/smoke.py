"""Hit every endpoint of a running API so you can test without the frontend.

Usage:  python smoke.py [http://localhost:8000]
TODO step 2+: insert fake lecture/session/segment rows with db.get_db() and use their ids.
"""
import sys

import httpx

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8000"
FAKE = "00000000-0000-0000-0000-000000000000"

checks = [
    ("GET", "/health", None),
    ("POST", f"/assets/{FAKE}/describe", None),
    ("POST", f"/sessions/{FAKE}/refine", None),  # 500 until the v2 schema.sql is run in Supabase
    ("POST", f"/annotations/{FAKE}/close", {"crop_png_base64": None}),
    ("POST", f"/sessions/{FAKE}/compile", None),
]

failed = 0
with httpx.Client(timeout=30) as client:
    for method, path, body in checks:
        r = client.request(method, BASE + path, json=body)
        print(f"{r.status_code}  {method} {path}  {r.text[:200]}")
        failed += r.status_code >= 400
sys.exit(1 if failed else 0)
