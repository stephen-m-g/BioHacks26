"""Test setup: import the api modules, and an in-memory stand-in for the Supabase client (no network)."""
import sys
import uuid
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main  # noqa: E402

PRIMARY_KEYS = {"lecture_notes": "session_id"}


def _cmp(v):
    """Timestamps compare as datetimes, everything else as is."""
    if isinstance(v, str) and len(v) >= 19 and v[4] == "-" and v[10] == "T":
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    return v


class Result:
    def __init__(self, data):
        self.data = data


class Query:
    """Supports the query-builder calls main.py makes: select/eq/gte/lte/is_/in_/order/limit,
    insert/update/upsert, execute."""

    def __init__(self, db, table):
        self.db, self.table = db, table
        self.rows = db.tables.setdefault(table, [])
        self.filters, self.op, self.payload, self.sort, self.max = [], "select", None, None, None

    def select(self, *_):
        return self

    def eq(self, col, val):
        self.filters.append(lambda r: r.get(col) == val)
        return self

    def gte(self, col, val):
        self.filters.append(lambda r: r.get(col) is not None and _cmp(r[col]) >= _cmp(val))
        return self

    def lte(self, col, val):
        self.filters.append(lambda r: r.get(col) is not None and _cmp(r[col]) <= _cmp(val))
        return self

    def is_(self, col, val):
        assert val == "null"
        self.filters.append(lambda r: r.get(col) is None)
        return self

    def in_(self, col, vals):
        self.filters.append(lambda r: r.get(col) in vals)
        return self

    def order(self, col, desc=False):
        self.sort = (col, desc)
        return self

    def limit(self, n):
        self.max = n
        return self

    def insert(self, row):
        self.op, self.payload = "insert", row
        return self

    def update(self, values):
        self.op, self.payload = "update", values
        return self

    def upsert(self, row):
        self.op, self.payload = "upsert", row
        return self

    def execute(self):
        if self.op == "insert":
            row = {"id": str(uuid.uuid4()), "created_at": "2026-11-07T19:00:00+00:00", **self.payload}
            self.rows.append(row)
            return Result([dict(row)])
        if self.op == "upsert":
            key = PRIMARY_KEYS.get(self.table, "id")
            self.rows[:] = [r for r in self.rows if r.get(key) != self.payload[key]]
            self.rows.append(dict(self.payload))
            return Result([dict(self.payload)])
        hits = [r for r in self.rows if all(f(r) for f in self.filters)]
        if self.op == "update":
            for r in hits:
                r.update(self.payload)
            return Result([dict(r) for r in hits])
        if self.sort:
            col, desc = self.sort
            hits.sort(key=lambda r: (r.get(col) is None, _cmp(r.get(col)) if r.get(col) is not None else 0),
                      reverse=desc)
        if self.max is not None:
            hits = hits[: self.max]
        return Result([dict(r) for r in hits])


class FakeDB:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {}

    def table(self, name):
        return Query(self, name)

    def add(self, table, **row):
        row.setdefault("id", str(uuid.uuid4()))
        self.tables.setdefault(table, []).append(row)
        return row

    def get(self, table, id_):
        return next(r for r in self.tables[table] if r["id"] == id_)


@pytest.fixture
def db(monkeypatch):
    fake = FakeDB()
    monkeypatch.setattr(main, "get_db", lambda: fake)
    return fake


@pytest.fixture
def gemini(monkeypatch):
    """Replace ai.generate. Set .result to what Gemini "returns" (a model, or None for the fallback);
    every call is recorded in .calls as (task, system, contents, schema)."""

    class Fake:
        result = None
        calls: list = []

        def __call__(self, task, system, contents, schema, timeout_ms=20_000):
            self.calls.append((task, system, contents, schema))
            return self.result, 1.0

    fake = Fake()
    fake.calls = []
    monkeypatch.setattr(main.ai, "generate", fake)
    return fake
