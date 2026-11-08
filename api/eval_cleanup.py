"""Live check of /refine's filler cleanup on tests/fixtures/refine_cleanup_cases.json.

  python eval_cleanup.py            # one call per case with the endpoint's prompt, model and validator
  python eval_cleanup.py --reps 3

For each segment prints the raw speech, the expected conservative cleanup, Gemini's output, and the text the
validator accepted (or the deterministic fallback, with the rejection reason). A case passes when the accepted
text has the same words as the expected cleanup. Costs well under a cent per run.
"""
import argparse
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
import ai  # noqa: E402
import cleanup  # noqa: E402
import main  # noqa: E402
import prompts  # noqa: E402
from schemas import RefineGemini  # noqa: E402

CASES = json.loads((HERE / "tests" / "fixtures" / "refine_cleanup_cases.json").read_text())


def run(case: dict) -> bool:
    segments = [{"id": f"s{i}", "raw_text": s["raw"]} for i, s in enumerate(case["segments"])]
    out, gemini_ms = ai.generate("refine", prompts.REFINE, [main.refine_prompt([], "", segments)], RefineGemini,
                                 timeout_ms=10_000, model=os.getenv("GEMINI_REFINE_MODEL") or None, thinking="LOW")
    final, outcomes = main.choose_refined_segments(segments, out)
    by_id = {s.id: s.text for s in out.segments} if out else {}
    ok = all(cleanup.tokens(f) == cleanup.tokens(s["expected"]) for f, s in zip(final, case["segments"]))
    print(f"\n[{'PASS' if ok else 'DIFF'}] {case['name']} ({gemini_ms:.0f} ms"
          f"{', old validator fell back' if case['old_validator_fell_back'] else ''})")
    for seg, s, accepted in zip(segments, case["segments"], final):
        gem = by_id.get(seg["id"])
        check = cleanup.check_cleanup(s["raw"], gem) if gem is not None else None
        print(f"  raw:      {s['raw']!r}\n  expected: {s['expected']!r}\n  gemini:   {gem!r}"
              f"{'' if check is None or check.ok else f'  REJECTED ({check.reason})'}\n  accepted: {accepted!r}")
    print(f"  outcomes: {dict(sorted(outcomes.items()))}")
    return ok


def main_() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=1)
    args = ap.parse_args()
    results = [run(case) for _ in range(args.reps) for case in CASES]
    print(f"\n{sum(results)}/{len(results)} cases match the expected conservative cleanup")


if __name__ == "__main__":
    sys.exit(main_())
