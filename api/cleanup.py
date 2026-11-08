"""Conservative transcript cleanup for /refine: which edits to one raw segment are safe, and a deterministic
fallback for when Gemini's edit is missing or unsafe.

An edit is accepted only if an order-preserving token alignment between the raw segment and the candidate
explains every difference as a safe category: filler removal, a repeated word or phrase, an abandoned false
start, a discourse marker, a stray article, or a sound-alike correction of a misheard term. Anything else
(new words, deleted content, reworded phrases, changed numbers or negations) rejects the candidate.
"""
import re
from collections import Counter
from dataclasses import dataclass
from difflib import SequenceMatcher

TOKEN_RE = re.compile(r"\d+(?:,\d{3})*(?:\.\d+)?|[a-z]+(?:'[a-z]+)*")

FILLERS = {"um", "umm", "ummm", "uh", "uhh", "uhm", "erm", "hmm", "mhm", "huh"}
# Removed by the deterministic fallback. Narrower than FILLERS: "huh" and "hmm" can be a question or a reply.
BASIC_FILLERS = {"um", "umm", "ummm", "uh", "uhh", "uhm", "erm"}
DISCOURSE = {"okay", "ok", "so", "well", "alright", "anyway", "yeah", "oh", "sorry"}
DISCOURSE_PAIRS = {("you", "know"), ("i", "mean")}
CORRECTION_MARKERS = {"sorry", "rather", "wait"}
STRAY = {"a", "an", "the", "and", "of", "to", "i"}
ARTICLES = {"a", "an", "the"}
FUNCTION_WORDS = STRAY | {"is", "are", "was", "were", "be", "it", "this", "that", "these", "those", "we", "you",
                          "they", "he", "she", "in", "on", "at", "for", "with", "we're", "it's", "there"}
NEGATIONS = {"not", "no", "never", "nor", "none", "nothing", "nobody", "neither", "cannot", "without"}
POLARITY = {
    "increase", "increases", "increased", "decrease", "decreases", "decreased", "more", "less", "fewer",
    "higher", "lower", "greater", "smaller", "larger", "bigger", "positive", "negative", "always", "before",
    "after", "above", "below", "inside", "outside", "maximum", "minimum", "gain", "gains", "lose", "loses",
    "loss", "left", "right", "first", "last",
}
OPPOSITE_STEMS = ("hyper", "hypo", "endo", "exo", "anti", "pro")
# Doubled on purpose in normal speech ("that that", "had had", "very very"), so never collapsed.
LEGIT_DOUBLES = {"that", "had", "very", "really", "yes", "bye", "far", "many", "much", "more", "over", "again",
                 "round", "ha", "knock", "tick", "so"}
SMALL_NUMBERS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
    "seventeen eighteen nineteen".split())}
TENS = {w: 10 * i for i, w in enumerate("twenty thirty forty fifty sixty seventy eighty ninety".split(), 2)}
SCALES = {"hundred": 100, "thousand": 1_000, "million": 1_000_000, "billion": 1_000_000_000}

MAX_FALSE_START = 6     # tokens in an abandoned start that is deleted as a whole
MAX_RESTART_TAIL = 2    # tokens of a false start that differ from the restart that follows it
MAX_ABANDONED = 3       # tokens abandoned before "sorry" / "I mean"
SOUND_ALIKE = 0.6       # character similarity of a misheard stretch and its correction


def tokens(text: str) -> list[str]:
    return TOKEN_RE.findall((text or "").lower().replace("\u2019", "'"))


def is_negation(token: str) -> bool:
    return token in NEGATIONS or token.endswith("n't")


def is_number(token: str) -> bool:
    return token[0].isdigit() or token in SMALL_NUMBERS or token in TENS or token in SCALES


def number_values(toks: list[str]) -> list[float]:
    """Numeric values in order; spelled-out numbers become digits ("twenty three" == "23")."""
    values: list[float] = []
    total = current = 0
    last = None

    def flush():
        nonlocal total, current, last
        if last is not None:
            values.append(float(total + current))
        total = current = 0
        last = None

    for t in toks:
        if t[0].isdigit():
            flush()
            values.append(float(t.replace(",", "")))
        elif t in SMALL_NUMBERS:
            if last == "small" or (last == "tens" and (SMALL_NUMBERS[t] >= 10 or current % 10)):
                flush()
            current += SMALL_NUMBERS[t]
            last = "small"
        elif t in TENS:
            if last in ("small", "tens"):
                flush()
            current += TENS[t]
            last = "tens"
        elif t in SCALES:
            current = current or 1
            if t == "hundred":
                current *= 100
            else:
                total, current = total + current * SCALES[t], 0
            last = "scale"
        elif t == "and" and last == "scale":
            continue
        else:
            flush()
    flush()
    return values


@dataclass
class Check:
    ok: bool
    reason: str = "ok"
    fillers: int = 0           # filler words removed
    deleted: int = 0           # other words removed (repetitions, false starts, discourse markers)
    corrected: int = 0         # misheard stretches replaced by a sound-alike


def check_cleanup(raw: str, candidate: str) -> Check:
    """Is `candidate` a faithful minimal cleanup of the raw segment `raw`?"""
    raw_tokens, cand_tokens = tokens(raw), tokens(candidate)
    raw_core = [t for t in raw_tokens if t not in FILLERS]
    cand_core = [t for t in cand_tokens if t not in FILLERS]
    fillers = max(0, (len(raw_tokens) - len(raw_core)) - (len(cand_tokens) - len(cand_core)))
    if not cand_core:
        if all(t in DISCOURSE for t in raw_core):
            return Check(True, fillers=fillers, deleted=len(raw_core))
        return Check(False, "content_deleted")
    if not raw_core:
        return Check(False, "insertion")

    soft = deleted = corrected = inserted = 0
    for tag, i1, i2, j1, j2 in SequenceMatcher(None, raw_core, cand_core, autojunk=False).get_opcodes():
        old, new = raw_core[i1:i2], cand_core[j1:j2]
        if tag == "equal":
            continue
        if negation_count(old, new) != sum(map(is_negation, new)):
            return Check(False, "negation_changed")
        if number_values(old) != number_values(new):
            return Check(False, "number_changed")
        if tag == "delete":
            kind = deletion_kind(raw_core, i1, i2)
            if kind is None:
                return Check(False, "content_deleted")
            soft += kind
            deleted += len(old)
        elif tag == "insert":
            inserted += len(new)
            if inserted > 1 or new[0] not in ARTICLES:
                return Check(False, "insertion")
        else:
            reason = replacement_problem(old, new)
            if reason:
                return Check(False, reason)
            corrected += 1
    if soft > max(2, len(raw_core) // 4):
        return Check(False, "too_many_deletions")
    return Check(True, fillers=fillers, deleted=deleted, corrected=corrected)


def negation_count(old: list[str], new: list[str]) -> int:
    """Negations in `old`, except a syllable inside a misheard word merged back together ("gee no type" ->
    "genotype"). A leading "not"/"no" always counts, so "not able" -> "notable" is still a changed negation."""
    if len(new) == 1 and len(old) >= 3 and not is_negation(old[0]) and not replacement_problem(old, new):
        return sum(is_negation(t) and t not in new[0] for t in old[1:])
    return sum(map(is_negation, old))


def deletion_kind(core: list[str], i1: int, i2: int) -> int | None:
    """None if deleting core[i1:i2] could lose meaning, else how many of its words count toward the budget for
    discourse markers and stray articles (repetitions and false starts are free)."""
    start, end = i1, i2
    while i1 < i2 and core[i1] in DISCOURSE:
        i1 += 1
    while i2 > i1 and core[i2 - 1] in DISCOURSE and core[i2 - 1] not in CORRECTION_MARKERS:
        i2 -= 1
    budget = (i1 - start) + (end - i2)  # discourse markers peeled off either end
    run, before, after = core[i1:i2], core[:i1], core[i2:]
    if not run:
        return budget
    if tuple(run) in DISCOURSE_PAIRS:
        return budget + len(run)
    if any(is_number(t) or is_negation(t) for t in run):
        return None
    n = len(run)
    if (after[:n] == run or before[-n:] == run) and not (n == 1 and run[0] in LEGIT_DOUBLES):
        return budget
    if n <= MAX_FALSE_START and after:
        shared = 0
        while shared < min(n, len(after)) and run[shared] == after[shared]:
            shared += 1
        tail = run[shared:]
        if shared and len(tail) <= MAX_RESTART_TAIL and (shared >= 2 or all(
            t in FUNCTION_WORDS or (len(t) >= 2 and shared < len(after) and after[shared].startswith(t))
            for t in tail
        )):
            return budget  # "the mito, the mitochondria"; never "the cell, the nucleus"
        if n == 1 and len(run[0]) >= 2 and after[0].startswith(run[0]) and after[0] != run[0]:
            return budget  # cut-off fragment: "photo photosynthesis"
        marker = 1 if run[-1] in CORRECTION_MARKERS else 2 if tuple(run[-2:]) == ("i", "mean") else 0
        if marker and n - marker <= MAX_ABANDONED:
            return budget  # "down the, sorry, along the mountain"
    if n <= 2 and all(t in STRAY for t in run):
        return budget + n
    if run[0] in STRAY and n > 1:
        rest = deletion_kind(core, i1 + 1, i2)  # "and it, it goes": a stray "and" before a stutter
        return None if rest is None else budget + 1 + rest
    return None


def replacement_problem(old: list[str], new: list[str]) -> str | None:
    """Accept a replaced stretch only as a sound-alike correction that keeps every protected word."""
    old_protected = Counter(t for t in old if t in POLARITY)
    new_protected = Counter(t for t in new if t in POLARITY)
    if old_protected != new_protected:
        return "protected_changed"
    old_join, new_join = "".join(old), "".join(new)
    if any(old_join.count(stem) != new_join.count(stem) for stem in OPPOSITE_STEMS):
        return "protected_changed"
    old_word_tokens = [t for t in old if not is_number(t)]
    old_words = "".join(old_word_tokens)
    new_words = "".join(t for t in new if not is_number(t))
    if not old_words and not new_words:
        return None  # only a number's spelling changed, and its value is checked separately
    if not old_words or not new_words:
        return "paraphrase"
    if len(new) == 1 and len(old_word_tokens) >= 2 and "".join(t[0] for t in old_word_tokens) == new_words:
        return None  # letters spelled out: "a tee pee" -> "ATP", "D N A" -> "DNA"
    old_key, new_key = sound_key(old_words), sound_key(new_words)
    ratio = len(new_key) / len(old_key)
    similarity = max(SequenceMatcher(None, old_words, new_words, autojunk=False).ratio(),
                     SequenceMatcher(None, old_key, new_key, autojunk=False).ratio())
    if similarity < SOUND_ALIKE or not 0.5 <= ratio <= 2.0:
        return "paraphrase"
    return None


_SOUND_RULES = [
    (r"ph", "f"), (r"ck", "k"), (r"c(?=[eiy])", "s"), (r"c", "k"), (r"q", "k"), (r"x", "ks"), (r"z", "s"),
    (r"y", "i"), (r"ee|ea|ie", "i"), (r"oo", "u"), (r"(?<=[aeiou])h", ""), (r"(.)\1+", r"\1"),
]


def sound_key(word: str) -> str:
    """Rough spelling-independent key so recognizer spellings compare to the real term ("site oh plaz" ~
    "cytoplasm"). Only used to recognise sound-alike corrections, never to rewrite text."""
    for pattern, repl in _SOUND_RULES:
        word = re.sub(pattern, repl, word)
    return word or "_"


SENTENCE_END = ".!?…"
_PIECE_RE = re.compile(r"^(\W*)(.*?)(\W*)$", re.DOTALL)


def _split(piece: str) -> tuple[str, str, str]:
    lead, core, trail = _PIECE_RE.match(piece).groups()
    return lead, core, trail


def _key(piece: str) -> str:
    return _split(piece)[1].lower().replace("\u2019", "'")


def basic_cleanup(raw: str) -> str:
    """Deterministic fallback: drop standalone um/uh/erm and collapse immediate stutters ("we're, we're",
    "we're gonna, we're gonna"). Numbers, negations, and words people double on purpose are never collapsed.
    Returns the raw text unchanged if the result would not pass check_cleanup."""
    raw = " ".join((raw or "").split())
    out: list[str] = []
    for piece in raw.split(" ") if raw else []:
        if _key(piece) not in BASIC_FILLERS:
            out.append(piece)
            continue
        trail = _split(piece)[2]
        if not out:
            continue
        lead, core, prev_trail = _split(out[-1])
        if any(c in SENTENCE_END for c in trail) and not any(c in SENTENCE_END for c in prev_trail):
            out[-1] = lead + core + prev_trail.rstrip(",;:") + trail.strip(",;: ")
        elif "," in trail and prev_trail.endswith(",") and core.lower() not in DISCOURSE:
            out[-1] = lead + core + prev_trail[:-1]  # "the, uh, free-body" -> "the free-body"

    changed = True
    while changed:
        changed = False
        for i in range(len(out)):
            for n in (3, 2, 1):
                first, second = out[i:i + n], out[i + n:i + 2 * n]
                if len(second) < n or [_key(p) for p in first] != [_key(p) for p in second]:
                    continue
                keys = [_key(p) for p in first]
                if any(not k or is_number(k) or is_negation(k) for k in keys) or (n == 1 and keys[0] in LEGIT_DOUBLES):
                    continue
                if any(_split(p)[2] for p in first[:-1]) or any(c in SENTENCE_END for c in _split(first[-1])[2]):
                    continue
                kept = out[i + n]
                if _split(first[0])[1][:1].isupper():
                    lead, core, trail = _split(kept)
                    kept = lead + core[:1].upper() + core[1:] + trail
                out[i:i + 2 * n] = [kept] + second[1:]
                changed = True
                break
            if changed:
                break

    text = " ".join(out)
    if text and raw[:1].isupper() and text[:1].islower():
        text = text[0].upper() + text[1:]
    return text if check_cleanup(raw, text).ok else raw
