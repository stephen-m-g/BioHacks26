"""Fake the teacher's microphone: insert transcript segments into a live session, like the browser's
speech recognition would. The /teach page picks them up over realtime and /refine cleans them.

Usage (venv active, from api/):
  python simulate.py                 # newest live session, one line every 4 s
  python simulate.py <session_id>    # a specific session (the id in /teach/<session_id>)
  python simulate.py --every 2       # faster

Like the frontend, a segment gets the session's pending annotation_id if a lasso is open,
so you can lasso something on an image, let a few lines play, then press ✓ to test /close.
"""
import argparse
import sys
import time
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv

load_dotenv()
from db import get_db  # noqa: E402

# A short lecture as a recognizer might hear a teacher with mild dysarthria (misheard terms on purpose).
LINES = [
    "okay so today we're looking at the plant cell and how it gets energy",
    "this big round part in the middle is the new clee us it holds the DNA",
    "around everything is the cell mem brain it controls what goes in and out",
    "now this little oval one is the my toe con dree a",
    "the my toe con dree a is where cellular res per a shun happens",
    "it takes glue coast and oxygen and makes a tee pee",
    "a tee pee is the energy currency of the cell",
    "and over here the green one is the chloro plast",
    "the chloro plast does photo synthesis it uses light to make glue coast",
    "so the chloro plast makes the sugar and the my toe con dree a burns it",
    "um plants have both animal cells only have the my toe con dree a",
    "for next class read about the cal vin cycle in the stroma",
]


def pick_session(db, session_id: str | None) -> str:
    if session_id:
        return session_id
    rows = (db.table("sessions").select("id, started_at").eq("status", "live")
            .order("started_at", desc=True).limit(1).execute().data)
    if not rows:
        sys.exit("No live session. Start one from the dashboard (or pass a session id).")
    return rows[0]["id"]


def pending_annotation(db, session_id: str) -> str | None:
    rows = (db.table("annotations").select("id").eq("session_id", session_id).eq("status", "pending")
            .order("drawn_at", desc=True).limit(1).execute().data)
    return rows[0]["id"] if rows else None


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("session_id", nargs="?")
    p.add_argument("--every", type=float, default=4.0, help="seconds between lines (default 4)")
    args = p.parse_args()

    db = get_db()
    session_id = pick_session(db, args.session_id)
    print(f"speaking into session {session_id} ({len(LINES)} lines, every {args.every:g}s; Ctrl+C to stop)")
    for i, text in enumerate(LINES, 1):
        now = datetime.now(timezone.utc)
        duration = timedelta(seconds=min(args.every, 0.4 * len(text.split())))
        ann = pending_annotation(db, session_id)
        db.table("transcript_segments").insert({
            "session_id": session_id,
            "t_start": (now - duration).isoformat(),
            "t_end": now.isoformat(),
            "raw_text": text,
            "confidence": 0.7,
            "annotation_id": ann,
        }).execute()
        print(f"  {i:2}/{len(LINES)} {'[lasso] ' if ann else ''}{text}")
        if i < len(LINES):
            time.sleep(args.every)
    print("done. The board refines every 15 s; End session to compile.")


if __name__ == "__main__":
    main()
