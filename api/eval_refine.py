"""Benchmark /refine's Gemini step: models x thinking levels on realistic dysarthric misrecognitions.

  python eval_refine.py                                   # default grid
  python eval_refine.py --models gemini-3.6-flash --levels default MINIMAL --reps 2 --show

Uses the endpoint's exact system prompt and prompt format. Each case is scored on expected terms (fixed
mishearings), forbidden text (over-correction, repeating the previous paragraph, invented facts) and length
(no additions or summaries). Costs a few cents per run.
"""
import argparse
import random
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
import ai  # noqa: E402
import prompts  # noqa: E402
from google.genai import types  # noqa: E402
from main import refine_prompt  # noqa: E402
from schemas import RefineGemini  # noqa: E402

VOCAB = sorted({
    "mitochondria", "cellular respiration", "glucose", "ATP", "chloroplast", "photosynthesis", "thylakoid", "stroma",
    "Calvin cycle", "RuBisCO", "meiosis", "mitosis", "homologous chromosomes", "chromosomes", "DNA polymerase",
    "template strand", "enzyme", "catalyst", "activation energy", "osmosis", "semipermeable membrane", "ribosomes",
    "rough ER", "proteins", "alleles", "gene", "phenotype", "genotype", "cell", "nucleus", "cell membrane",
    "glycolysis", "cytoplasm", "pyruvate", "helicase", "nucleotides", "double helix", "phospholipid bilayer",
    "hydrophilic", "hydrophobic", "natural selection", "cell cycle", "interphase", "prophase",
})

# (name, previous paragraph, raw recognizer text, must contain [any of each group], must not contain)
CASES = [
    ("mito", "", "so the my toe con dree a is where cellular res per a shun happens",
     [("mitochondri",), ("cellular respiration",)], []),
    ("atp", "", "it takes glue coast and oxygen and makes a tee pee",
     [("glucose",), ("ATP",)], ["tee pee", "teepee"]),
    ("chloroplast", "", "the chloro plast does photo synthesis in the thy la koid",
     [("chloroplast",), ("photosynthesis",), ("thylakoid",)], []),
    ("meiosis", "", "during my oh sis the homo log us chromosomes pair up",
     [("meiosis",), ("homologous",)], []),
    ("polymerase", "", "DNA poly mer ace reads the template strand three prime to five prime",
     [("polymerase",), ("template strand",)], []),
    ("catalyst", "", "the enzyme is a cat a list it lowers the activation energy",
     [("catalyst",), ("activation energy",)], []),
    ("osmosis", "", "oz mo sis is when water moves across a semi per me able membrane",
     [("osmosis",), ("semipermeable", "semi-permeable")], []),
    ("ribosomes", "", "and the rye bo zomes on the rough E R make proteins",
     [("ribosome",), ("rough ER", "rough endoplasmic")], []),
    ("alleles", "", "the a lee lez are different versions of a gene",
     [("allele",)], []),
    ("phenotype", "", "fen o type is what you can see and gee no type is the genes",
     [("phenotype",), ("genotype",)], []),
    ("garbled", "", "the cal vin cycle uses the uh fram blee sh to fix carbon",
     [("Calvin cycle",), ("[?",)], ["rubisco"]),
    ("no-repeat", "The mitochondria is where cellular respiration happens.", "and it makes a tee pee from glue coast",
     [("ATP",), ("glucose",)], ["where cellular respiration happens"]),
    ("no-additions", "", "okay so open your books to page forty two",
     [("page",)], ["mitochondri", "cell", "ATP", "chromosome"]),
    ("sell-not-cell", "", "make sure you sell your old textbooks back at the end of the year",
     [("sell",)], [" cell "]),
    ("numbers", "", "a human cell has twenty three pairs of chromosomes",
     [("chromosomes",), ("23", "twenty-three", "twenty three")], []),
    # 15-second batches, like real /refine calls: several segments joined
    ("batch-glycolysis", "Today we are looking at how cells get energy.",
     "so the first step is gly coll is is it happens in the site oh plaz um it splits glue coast into two pie roo "
     "vate and you get a little bit of a tee pee",
     [("glycolysis",), ("cytoplasm",), ("glucose",), ("pyruvate",), ("ATP",)], ["krebs"]),
    ("batch-replication", "",
     "okay when DNA copies itself the hell i case unzips the double helix and then the poly mer ace adds new nu "
     "clee o tides to each strand",
     [("helicase",), ("double helix",), ("polymerase",), ("nucleotides",)], []),
    ("batch-aside", "",
     "the cell mem brain is made of a phos foe lip id bi layer hey Jordan put your phone away please the heads are "
     "hydro filic and the tails are hydro phobic",
     [("phospholipid bilayer",), ("phone away",), ("hydrophilic",), ("hydrophobic",)], []),
    ("batch-continues", "Natural selection happens when some individuals survive and",
     "re produce more than others because of their a lee lez so the population ad apts over many gen er a shuns",
     [("reproduce",), ("allele",), ("adapt",), ("generations",)], ["natural selection happens"]),
    ("batch-no-extras", "",
     "the cell cycle takes about twenty four hours and mi toe sis is only about one hour of that",
     [("cell cycle",), ("mitosis",), ("24", "twenty-four", "twenty four")], ["prophase", "interphase", "metaphase"]),
]


def score(raw: str, out: str | None, must, must_not) -> tuple[bool, str]:
    if not out:
        return False, "no output"
    low = f" {out.lower()} "
    missing = [g[0] for g in must if not any(alt.lower() in low for alt in g)]
    bad = [m for m in must_not if m.lower() in low]
    ratio = len(out.split()) / max(1, len(raw.split()))
    problems = ([f"missing {missing}"] if missing else []) + ([f"has {bad}"] if bad else []) + \
               ([f"length x{ratio:.2f}"] if not 0.35 <= ratio <= 1.3 else [])
    return not problems, "; ".join(problems)


def call(model: str, level: str, case) -> dict:
    name, prev, raw, must, must_not = case
    cfg = types.GenerateContentConfig(
        system_instruction=prompts.REFINE, response_mime_type="application/json", response_schema=RefineGemini,
        http_options=types.HttpOptions(timeout=30_000),
        thinking_config=None if level == "default" else types.ThinkingConfig(thinking_level=level),
    )
    t0 = time.perf_counter()
    try:
        resp = ai.get_client().models.generate_content(
            model=model, contents=[refine_prompt(VOCAB, prev, [{"id": "s0", "raw_text": raw}])], config=cfg)
        ms = (time.perf_counter() - t0) * 1000
        out = resp.parsed.text if isinstance(resp.parsed, RefineGemini) else None
        thoughts = getattr(resp.usage_metadata, "thoughts_token_count", None) or 0
        ok, why = score(raw, out, must, must_not)
        return {"model": model, "level": level, "case": name, "ok": ok, "why": why, "out": out, "ms": ms,
                "thoughts": thoughts, "error": None}
    except Exception as e:  # noqa: BLE001
        return {"model": model, "level": level, "case": name, "ok": False, "why": "error", "out": None,
                "ms": (time.perf_counter() - t0) * 1000, "thoughts": 0, "error": str(e)[:160]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.8-flash",
                                                    "gemini-3.7-flash", "gemini-3.5-flash"])
    ap.add_argument("--levels", nargs="+", default=["default", "MINIMAL"])
    ap.add_argument("--reps", type=int, default=1)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--show", action="store_true", help="print every output, not just failures")
    args = ap.parse_args()

    jobs = [(m, lv, c) for m in args.models for lv in args.levels for c in CASES for _ in range(args.reps)]
    random.shuffle(jobs)  # interleave configs so load affects them equally
    print(f"{len(jobs)} calls ({len(CASES)} cases x {args.reps} reps per config)...", flush=True)
    with ThreadPoolExecutor(args.workers) as pool:
        results = list(pool.map(lambda j: call(*j), jobs))

    print(f"\n{'model':24} {'thinking':8} {'pass':>7} {'p50 ms':>7} {'p90 ms':>7} {'thoughts':>8}  errors")
    for m in args.models:
        for lv in args.levels:
            rs = [r for r in results if r["model"] == m and r["level"] == lv]
            good = [r for r in rs if not r["error"]]
            lat = sorted(r["ms"] for r in good)
            p50 = statistics.median(lat) if lat else float("nan")
            p90 = lat[min(len(lat) - 1, int(0.9 * len(lat)))] if lat else float("nan")
            th = statistics.mean(r["thoughts"] for r in good) if good else 0
            errs = sorted({r["error"] for r in rs if r["error"]})
            print(f"{m:24} {lv:8} {sum(r['ok'] for r in rs):>3}/{len(rs):<3} {p50:7.0f} {p90:7.0f} {th:8.0f}  "
                  f"{errs[0][:70] if errs else ''}")
    print("\nfailures:" if not args.show else "\noutputs:")
    for r in sorted(results, key=lambda r: (r["model"], r["level"], r["case"])):
        if args.show or (not r["ok"] and not r["error"]):
            print(f"  [{r['model']} {r['level']}] {r['case']}: {'OK' if r['ok'] else r['why']} -> {r['out']!r}")


if __name__ == "__main__":
    sys.exit(main())
